import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { PreviewSchema } from "../../shared/contracts";
import type { Preview, PullRequest } from "../../shared/contracts";
import { executionEnvironment } from "./environment";
import { runProcess, terminateOwnedProcess } from "./process";
import { checkoutFile } from "./scenarios";

export interface PreviewPage {
	loadURL(url: string): Promise<void>;
	setViewport(width: number, height: number): Promise<void>;
	measure(): Promise<{ id: string; x: number; y: number; width: number; height: number }[]>;
	close(): void;
}
export type PreviewPageFactory = () => PreviewPage;
const handshakeSchema = z.object({ runId: z.string(), port: z.number().int().min(1).max(65535) });

/** Owns only the server process group and page created during this start call. */
export class PreviewRunner {
	private readonly active = new Map<string, () => Promise<void>>();
	constructor(
		private readonly logsDirectory: string,
		private readonly createPage: PreviewPageFactory,
		private readonly nodeExecutable = process.execPath
	) {}

	async start(input: {
		pr: PullRequest;
		path: string;
		sha: string;
		mode: "phone" | "desktop";
		signal?: AbortSignal;
		timeoutMs?: number;
	}): Promise<{ preview: Preview; stop: () => Promise<void> }> {
		if (input.sha !== input.pr.headSha) throw new Error("Preview must match the PR head");
		if (input.signal?.aborted) throw new Error("Preview cancelled");
		const timeoutMs = input.timeoutMs ?? 20_000;
		if (timeoutMs < 1 || timeoutMs > 120_000) throw new Error("Invalid preview timeout");
		const check = await runProcess({
			command: "git",
			args: ["rev-parse", "HEAD"],
			cwd: input.path,
			env: executionEnvironment(),
			timeoutMs: 10_000,
			signal: input.signal,
		});
		if (check.exitCode !== 0 || check.stdout.trim() !== input.sha)
			throw new Error("Preview checkout revision changed");
		const clean = await runProcess({
			command: "git",
			args: ["diff", "--exit-code", "HEAD", "--"],
			cwd: input.path,
			env: executionEnvironment(),
			timeoutMs: 10_000,
			signal: input.signal,
		});
		if (clean.exitCode !== 0) throw new Error("Preview checkout has tracked changes");
		await checkoutFile(input.path, "checkout/server.mjs");
		const runId = randomUUID();
		const startedAt = new Date().toISOString();
		const args = ["--experimental-strip-types", "checkout/server.mjs"];
		const child = spawn(this.nodeExecutable, args, {
			cwd: input.path,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: executionEnvironment({
				PORT: "0",
				METAHACKATHON_RUN_ID: runId,
				...(process.versions["electron"] ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
			}),
		});
		let page: PreviewPage | undefined;
		let stopped = false;
		let stopping: Promise<void> | undefined;
		let output = "";
		let stderr = "";
		child.stderr?.on("data", (data: Buffer) => {
			stderr = (stderr + data.toString()).slice(-100_000);
		});
		const stop = (): Promise<void> => {
			if (stopping) return stopping;
			stopped = true;
			input.signal?.removeEventListener("abort", onAbort);
			page?.close();
			stopping = terminateOwnedProcess(child).finally(() => {
				this.active.delete(runId);
			});
			return stopping;
		};
		const onAbort = () => {
			void stop();
		};
		this.active.set(runId, stop);
		input.signal?.addEventListener("abort", onAbort, { once: true });
		if (input.signal?.aborted) onAbort();
		try {
			const port = await new Promise<number>((resolvePort, reject) => {
				const timer = setTimeout(() => finish(new Error("Preview readiness timed out")), timeoutMs);
				const finish = (error?: Error, value?: number) => {
					clearTimeout(timer);
					child.off("error", onError);
					child.off("exit", onExit);
					if (error) reject(error);
					else resolvePort(value as number);
				};
				const onError = () => finish(new Error("Unable to start preview server"));
				const onExit = () => finish(new Error("Preview server exited before readiness"));
				child.once("error", onError);
				child.once("exit", onExit);
				child.stdout?.on("data", (data: Buffer) => {
					output = (output + data.toString()).slice(-100_000);
					for (const line of output.split("\n")) {
						if (!line.startsWith("METAHACKATHON_PREVIEW ")) continue;
						try {
							const ready = handshakeSchema.parse(
								JSON.parse(line.slice("METAHACKATHON_PREVIEW ".length))
							);
							if (ready.runId !== runId) {
								finish(new Error("Preview ownership mismatch"));
								return;
							}
							finish(undefined, ready.port);
						} catch {
							finish(new Error("Invalid preview readiness response"));
						}
					}
				});
			});
			if (stopped) throw new Error("Preview cancelled");
			const origin = `http://127.0.0.1:${port}`;
			// A separate readiness probe exits, so evidence reports a real exit code while the server stays live.
			const probeArgs = [
				"-e",
				"fetch(process.argv[1],{redirect:'error'}).then(async r=>{if(!r.ok)throw Error('health');const j=await r.json();if(j.runId!==process.argv[2])throw Error('owner');console.log(JSON.stringify(j))}).catch(()=>process.exit(1))",
				`${origin}/health?runId=${runId}`,
				runId,
			];
			const probe = await runProcess({
				command: this.nodeExecutable,
				args: probeArgs,
				cwd: input.path,
				env: executionEnvironment(
					process.versions["electron"] ? { ELECTRON_RUN_AS_NODE: "1" } : {}
				),
				timeoutMs,
				signal: input.signal,
			});
			if (probe.exitCode !== 0) throw new Error("Preview server ownership check failed");
			const viewport =
				input.mode === "phone"
					? { mode: "phone" as const, width: 390, height: 640 }
					: { mode: "desktop" as const, width: 1024, height: 768 };
			page = this.createPage();
			await page.setViewport(viewport.width, viewport.height);
			const url = `${origin}/checkout?runId=${runId}`;
			await withTimeout(page.loadURL(url), timeoutMs);
			if (stopped) throw new Error("Preview cancelled");
			const measurements = await withTimeout(page.measure(), timeoutMs);
			if (stopped || input.signal?.aborted) throw new Error("Preview cancelled during measurement");
			const file = "checkout/PromoField.ts";
			const blob = await runProcess({
				command: "git",
				args: ["show", "--no-ext-diff", "--no-textconv", `${input.sha}:${file}`],
				cwd: input.path,
				env: executionEnvironment(),
				timeoutMs: 10_000,
			});
			const finalDiff = await runProcess({
				command: "git",
				args: ["diff", "--exit-code", input.sha, "--"],
				cwd: input.path,
				env: executionEnvironment(),
				timeoutMs: 10_000,
			});
			if (
				blob.exitCode !== 0 ||
				blob.outputTruncated ||
				finalDiff.exitCode !== 0 ||
				(await readFile(await checkoutFile(input.path, file), "utf8")) !== blob.stdout
			)
				throw new Error("Preview source changed during execution");
			const source = blob.stdout.split("\n");
			const markers = ["cap-note", "pay-button"].map((id, index) => {
				const rect = measurements.find((measurement) => measurement.id === id);
				const line = source.findIndex((text) => text.includes(`data-preview-marker=\"${id}\"`)) + 1;
				if (!rect || line === 0) throw new Error(`Missing preview marker ${id}`);
				return {
					id,
					number: index + 1,
					label:
						id === "cap-note"
							? "40% discount cap note"
							: rect.y >= viewport.height
								? "Pay button below the fold"
								: "Pay button",
					location: {
						repository: input.pr.repository,
						revision: "head" as const,
						commitSha: input.sha,
						path: file,
						startLine: line,
						endLine: line,
					},
					bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
				};
			});
			await mkdir(this.logsDirectory, { recursive: true, mode: 0o700 });
			const log = resolve(this.logsDirectory, `${runId}-preview.json`);
			const completedAt = new Date().toISOString();
			await writeFile(
				log,
				JSON.stringify(
					{
						runId,
						url,
						startedAt,
						completedAt,
						viewport,
						markers,
						serverCommand: [this.nodeExecutable, ...args],
						probeCommand: [this.nodeExecutable, ...probeArgs],
						probe,
						stdout: output,
						stderr,
					},
					null,
					2
				),
				{ mode: 0o600 }
			);
			const preview = PreviewSchema.parse({
				id: runId,
				prId: input.pr.id,
				revision: "head",
				commitSha: input.sha,
				url,
				viewport,
				markers,
				evidence: {
					kind: "execution",
					runId,
					commitSha: input.sha,
					command: [this.nodeExecutable, ...probeArgs],
					startedAt,
					completedAt,
					exitCode: probe.exitCode,
					logUrl: pathToFileURL(log).href,
				},
			});
			if (stopped || input.signal?.aborted) throw new Error("Preview cancelled before completion");
			return { preview, stop };
		} catch (error) {
			await stop();
			throw error;
		}
	}

	async dispose() {
		await Promise.all([...this.active.values()].map((stop) => stop()));
	}
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("Preview page timed out")), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
