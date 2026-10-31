import { existsSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import {
	CodingTaskInputSchema,
	CodingTaskResultSchema,
	runCodingTask,
} from "../agent/coding-worker";
import {
	createCodingWorkerCheckpointStore,
	createCodingWorkerTools,
} from "../agent/coding-worker-tools";
import { MetaClient } from "../agent/meta-client";
import { EnvConfiguration } from "../config/env";
import {
	CodingProviderPinError,
	codingProviderFailureCode,
	runPinnedCodingTask,
	stripCodingProviderEnvironment,
} from "./coding-provider";

const requestSchema = z.strictObject({
	kind: z.literal("run"),
	input: CodingTaskInputSchema,
	envPath: z.string().refine(isAbsolute),
});
const lifetime = new AbortController();
let started = false;
const send = (event: unknown) =>
	new Promise<void>((resolve) => {
		if (!process.connected || !process.send) return resolve();
		process.send(event, () => resolve());
	});
process.on("disconnect", () => lifetime.abort());
process.on("SIGTERM", () => lifetime.abort());
process.on("SIGINT", () => lifetime.abort());
process.on("message", async (raw) => {
	if (raw && typeof raw === "object" && "kind" in raw && raw.kind === "cancel") {
		lifetime.abort();
		return;
	}
	if (started) return;
	started = true;
	let selectedProvider: "meta-api" | "muse-code" | undefined;
	try {
		const request = requestSchema.parse(raw);
		const config = new EnvConfiguration(request.envPath);
		const values = (
			await Promise.all([
				config.get("meta"),
				config.get("github"),
				config.get("elevenlabs"),
				config.linearToken(),
			])
		).filter((value): value is string => !!value && value.length > 5);
		const redact = (text: string) =>
			values.reduce((clean, value) => clean.split(value).join("[redacted]"), text);
		const log = async (text: string) => {
			for (const line of redact(text).split(/\r?\n/).slice(0, 200))
				await send({ kind: "log", text: line.slice(0, 12000) });
		};
		const result = await runPinnedCodingTask(
			request.input,
			() => config.codingProviderSettings(),
			{
				log,
				meta: async (input, signal) => {
					selectedProvider = "meta-api";
					const path = input.worktreePath;
					const regular = async (file: string) => {
						try {
							const value = await lstat(join(path, file));
							return value.isFile() && !value.isSymbolicLink();
						} catch {
							return false;
						}
					};
					const manager =
						(await regular("bun.lock")) || (await regular("bun.lockb"))
							? "bun"
							: (await regular("pnpm-lock.yaml"))
								? "pnpm"
								: (await regular("yarn.lock"))
									? "yarn"
									: "npm";
					const install = existsSync(join(path, "package.json"))
						? [
								{ command: manager, args: ["install"] },
								{
									command: manager,
									args:
										manager === "npm"
											? ["ci"]
											: ["install", manager === "yarn" ? "--immutable" : "--frozen-lockfile"],
								},
							]
						: [];
					const tools = createCodingWorkerTools({
						worktreePath: path,
						allowedCommands: install,
						redactText: redact,
					});
					const client = new MetaClient({
						getApiKey: async () => (await config.get("meta")) ?? null,
						recordUsage: () => {},
					});
					return runCodingTask(
						client,
						input,
						{
							...tools,
							...createCodingWorkerCheckpointStore(input.checkpointPath),
							redactText: redact,
							log: (event) => log(`[${event.kind}] ${event.message}`),
							runCommand: async (command, active) => {
								await log(`$ ${command.command} ${command.args.join(" ")}`);
								const output = await tools.runCommand(command, active);
								await log(output.stdout);
								await log(output.stderr);
								await log(`[exit ${output.exitCode ?? output.signal ?? "unknown"}]`);
								return output;
							},
						},
						signal
					);
				},
				muse: async (input, options, signal) => {
					selectedProvider = "muse-code";
					stripCodingProviderEnvironment(process.env);
					const { runMuseCodeTask } = await import("./muse-code");
					signal.throwIfAborted();
					return runMuseCodeTask(input, { musePath: options.musePath, log, redact }, signal);
				},
			},
			lifetime.signal
		);
		await send({ kind: "result", result: CodingTaskResultSchema.parse(result) });
	} catch (error) {
		if (error instanceof CodingProviderPinError)
			await send({ kind: "log", text: `[coding-provider] Selection rejected: ${error.code}` });
		if (selectedProvider === "muse-code") {
			const code = codingProviderFailureCode(error);
			if (code) await send({ kind: "log", text: `[coding-provider] muse-code stopped: ${code}` });
		}
		await send({
			kind: "failed",
			message: lifetime.signal.aborted
				? "Worker paused before completion."
				: selectedProvider === "muse-code"
					? "The Muse Code worker could not complete. Check its login, subscription, quota and execution log."
					: "The Muse worker could not complete. Check its model connection and execution log.",
		});
	} finally {
		process.disconnect?.();
	}
});
