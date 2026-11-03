import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { executionEnvironment } from "../environment";
import { runProcess, terminateOwnedProcess } from "../process";

export const LocalPreviewSelectionSchema = z
	.object({
		kind: z.enum(["pr", "job"]),
		sourceId: z.string().min(1).max(300),
		repository: z.string().min(1).max(300),
		commitSha: z.string().regex(/^[0-9a-f]{40}$/),
	})
	.strict();
export type LocalPreviewSelection = z.infer<typeof LocalPreviewSelectionSchema>;
export interface PreviewLaunchRequest {
	selection: LocalPreviewSelection;
	/** Opaque receipt from trusted user ingress; never model-supplied consent. */
	authorityId: string;
}
export interface LocalPreviewReceipt {
	runId: string;
	selection: LocalPreviewSelection;
	command: [string, "start", "--ignore-scripts"];
	url: string;
	startedAt: string;
	readyAt: string | null;
	endedAt: string | null;
	state: "starting" | "ready" | "stopped" | "failed";
	exitCode: number | null;
	logPath: string;
}
export interface LocalPreviewOptions {
	directory: string;
	/** Trusted installation configuration, never a tool argument. No install or terminal fallback. */
	npmExecutable: string;
	port: number;
	timeoutMs?: number;
	/** Reauthorize exact account/source/revision and consume explicit launch consent, then return local object source. */
	authorize(
		request: PreviewLaunchRequest,
		signal: AbortSignal
	): Promise<{ repositoryPath: string }>;
}

/** App-owned execution, not an OS sandbox. No browser is created and readiness is not display proof. */
export class LocalPreviewService {
	private active?: {
		controller: AbortController;
		done: Promise<LocalPreviewReceipt>;
		stop?: () => Promise<void>;
	};
	private disposed = false;
	private snapshot?: () => { receipt: LocalPreviewReceipt; output: string };

	inspect(): { receipt: LocalPreviewReceipt; output: string } | null {
		return this.snapshot?.() ?? null;
	}
	constructor(private readonly options: LocalPreviewOptions) {
		if (
			!isAbsolute(options.directory) ||
			!isAbsolute(options.npmExecutable) ||
			!Number.isInteger(options.port) ||
			options.port < 1024 ||
			options.port > 65535 ||
			!Number.isFinite(options.timeoutMs ?? 20000) ||
			(options.timeoutMs ?? 20000) < 1 ||
			(options.timeoutMs ?? 20000) > 120000
		)
			throw new Error("Invalid local preview configuration");
	}
	start(raw: PreviewLaunchRequest, signal?: AbortSignal): Promise<LocalPreviewReceipt> {
		if (this.disposed || this.active)
			return Promise.reject(new Error("Preview unavailable or already running"));
		const request = z
			.object({ selection: LocalPreviewSelectionSchema, authorityId: z.string().min(1).max(300) })
			.strict()
			.parse(raw);
		const controller = new AbortController();
		const abort = () => controller.abort();
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		const active = {
			controller,
			done: Promise.resolve(null as unknown as LocalPreviewReceipt),
			stop: undefined as (() => Promise<void>) | undefined,
		};
		this.active = active;
		active.done = this.launch(request, controller.signal, (stop) => {
			active.stop = stop;
		}).catch((error) => {
			if (this.active === active) this.active = undefined;
			signal?.removeEventListener("abort", abort);
			throw error;
		});
		// Keep the caller's cancellation connected for the entire running preview lifetime.
		active.done.then(
			() => {},
			() => {}
		);
		const detach = () => signal?.removeEventListener("abort", abort);
		controller.signal.addEventListener("abort", detach, { once: true });
		return active.done;
	}
	async stop(): Promise<void> {
		const active = this.active;
		if (!active) return;
		active.controller.abort();
		await active.done.catch(() => {});
		await active.stop?.();
		if (this.active === active) this.active = undefined;
	}
	async dispose(): Promise<void> {
		this.disposed = true;
		await this.stop();
	}

	private async launch(
		request: PreviewLaunchRequest,
		signal: AbortSignal,
		register: (stop: () => Promise<void>) => void
	): Promise<LocalPreviewReceipt> {
		signal.throwIfAborted();
		const authorized = await this.options.authorize(request, signal);
		signal.throwIfAborted();
		const source = await realpath(authorized.repositoryPath);
		await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
		const directory = await realpath(this.options.directory);
		if (!relative(source, directory).startsWith(".."))
			throw new Error("Preview storage must be outside source repository");
		const root = await mkdtemp(join(directory, "preview-"));
		const home = join(root, "home");
		await mkdir(home, { mode: 0o700 });
		const env = executionEnvironment({
			HOME: home,
			TMPDIR: home,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_TERMINAL_PROMPT: "0",
			GIT_NO_LAZY_FETCH: "1",
		});
		const receipt: LocalPreviewReceipt = {
			runId: randomUUID(),
			selection: request.selection,
			command: [this.options.npmExecutable, "start", "--ignore-scripts"],
			url: `http://127.0.0.1:${this.options.port}`,
			startedAt: new Date().toISOString(),
			readyAt: null,
			endedAt: null,
			state: "starting",
			exitCode: null,
			logPath: join(root, "execution.json"),
		};
		let output = "";
		this.snapshot = () => ({
			receipt: { ...receipt, selection: { ...receipt.selection } },
			output,
		});
		let child: ChildProcess | undefined;
		let spawnError = false;
		let stopping: Promise<void> | undefined;
		const save = () =>
			writeFile(receipt.logPath, JSON.stringify({ ...receipt, output }, null, 2), { mode: 0o600 });
		const stop = () => {
			stopping ??= (async () => {
				signal.removeEventListener("abort", onAbort);
				if (child) await terminateOwnedProcess(child);
				receipt.exitCode = child?.exitCode ?? null;
				receipt.endedAt = new Date().toISOString();
				if (receipt.state !== "failed") receipt.state = "stopped";
				await save();
				// Only directories created by this run; logs remain inspectable after cleanup.
				await rm(join(root, "repository.git"), { recursive: true, force: true });
				await rm(join(root, "worktree"), { recursive: true, force: true });
				await rm(home, { recursive: true, force: true });
			})();
			return stopping;
		};
		const onAbort = () => {
			void stop().catch(() => {});
		};
		register(stop);
		const git = async (cwd: string, args: string[]) => {
			signal.throwIfAborted();
			const result = await runProcess({
				command: "git",
				args: [
					"--no-replace-objects",
					"-c",
					"core.hooksPath=/dev/null",
					"-c",
					"core.fsmonitor=false",
					...args,
				],
				cwd,
				env,
				signal,
				timeoutMs: 30000,
			});
			if (result.exitCode !== 0 || result.aborted || result.timedOut || result.outputTruncated)
				throw new Error("Pinned preview Git preparation failed");
			return result.stdout.trim();
		};
		try {
			await save();
			await git(root, [
				"clone",
				"--bare",
				"--no-hardlinks",
				"--dissociate",
				"--template=",
				"--",
				source,
				join(root, "repository.git"),
			]);
			const bare = join(root, "repository.git");
			const sha = request.selection.commitSha;
			if ((await git(bare, ["rev-parse", "--verify", `${sha}^{commit}`])) !== sha)
				throw new Error("Selected revision unavailable");
			await git(bare, ["worktree", "add", "--detach", "--", join(root, "worktree"), sha]);
			const cwd = join(root, "worktree");
			const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
			if (typeof manifest.scripts?.start !== "string" || !manifest.scripts.start.trim())
				throw new Error("Selected revision has no npm start script");
			if (await this.listeners(root, env)) throw new Error("Preview port is already occupied");
			signal.throwIfAborted();
			child = spawn(this.options.npmExecutable, ["start", "--ignore-scripts"], {
				cwd,
				shell: false,
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...env,
					PORT: String(this.options.port),
					HOST: "127.0.0.1",
					npm_config_userconfig: "/dev/null",
					npm_config_globalconfig: join(home, "npm-globalrc"),
					npm_config_ignore_scripts: "true",
				},
			});
			child.on("error", () => {
				spawnError = true;
			});
			for (const stream of [child.stdout, child.stderr])
				stream?.on("data", (chunk: Buffer) => {
					output = (output + chunk.toString()).slice(-64000);
				});
			signal.addEventListener("abort", onAbort, { once: true });
			const deadline = Date.now() + (this.options.timeoutMs ?? 20000);
			while (Date.now() < deadline) {
				signal.throwIfAborted();
				if (spawnError || child.exitCode !== null || child.signalCode !== null)
					throw new Error("Preview exited before readiness");
				const pids = await this.listeners(root, env);
				if (pids) {
					for (const pid of pids.split("\n")) {
						const group = await runProcess({
							command: "/bin/ps",
							args: ["-o", "pgid=", "-p", pid],
							cwd: root,
							env,
							timeoutMs: 1000,
							signal,
						});
						if (group.exitCode !== 0 || group.stdout.trim() !== String(child.pid))
							throw new Error("Preview listener is not owned by this launch");
					}
					const response = await fetch(receipt.url, {
						redirect: "error",
						signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
					}).catch(() => null);
					if (response) {
						await response.body?.cancel();
						if (response.ok) {
							signal.throwIfAborted();
							if (child.exitCode !== null || child.signalCode !== null)
								throw new Error("Preview exited during readiness");
							receipt.state = "ready";
							receipt.readyAt = new Date().toISOString();
							await save();
							signal.throwIfAborted();
							child.once("exit", () => {
								if (!stopping) receipt.state = "failed";
								void stop().catch(() => {});
							});
							return { ...receipt, selection: { ...receipt.selection } };
						}
					}
				}
				await delay(100, undefined, { signal });
			}
			throw new Error("Preview readiness timed out");
		} catch (error) {
			receipt.state = "failed";
			await stop();
			throw error;
		}
	}
	private async listeners(cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
		const result = await runProcess({
			command: "/usr/sbin/lsof",
			args: ["-nP", "-t", `-iTCP:${this.options.port}`, "-sTCP:LISTEN"],
			cwd,
			env,
			timeoutMs: 2000,
		});
		if (
			result.timedOut ||
			result.outputTruncated ||
			(result.exitCode !== 0 && result.exitCode !== 1)
		)
			throw new Error("Cannot verify preview listener ownership");
		return [...new Set(result.stdout.trim().split("\n").filter(Boolean))].join("\n");
	}
}
