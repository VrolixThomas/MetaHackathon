import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { MuseClient, readSessionDurability, spawnMspConnection } from "@muse-code/sdk";
import type { ResumeSessionOptions, Session, StartSessionOptions } from "@muse-code/sdk";
import { z } from "zod";
import type { MuseCodeStatus } from "../../../shared/contracts/coding-provider";
import { abortable } from "../../agent/cancellation";
import { redactCodingText } from "../../agent/coding-worker-safety";
import { codingEnvironment } from "../coding-environment";

export type MuseFailure = NonNullable<MuseCodeStatus["error"]>;
const errors: Record<MuseFailure, string> = {
	"not-installed": "Muse Code is not installed at the selected path.",
	"sign-in-required": "Sign in to Muse Code with your subscription account before coding.",
	"api-key-selected": "Muse Code selected an API key. Subscription coding is blocked.",
	"subscription-required": "An active Muse Code subscription is required.",
	"quota-exceeded": "Muse Code subscription allowance is exhausted. Wait for its reset.",
	"unsupported-cli": "This Muse Code version or protocol cannot establish the required guardrails.",
	unavailable: "Muse Code could not confirm its state. Existing work was retained.",
};
export class MuseCodeRuntimeError extends Error {
	constructor(readonly code: MuseFailure) {
		super(errors[code]);
	}
}
export interface MuseHost {
	info: unknown;
	durability: string;
	request(method: string, params?: Record<string, unknown>): Promise<unknown>;
	command(method: string, params: Record<string, unknown>, commandId?: string): Promise<unknown>;
	mintId(): string;
	start(options: StartSessionOptions): Promise<Session>;
	resume(options: ResumeSessionOptions): Promise<Session>;
	close(): Promise<void>;
}
export interface MuseCodeDependencies {
	resolveBinary(path: string | null): Promise<{ path: string; version: string }>;
	connect(
		path: string,
		cwd: string,
		env: NodeJS.ProcessEnv,
		signal: AbortSignal
	): Promise<MuseHost>;
	checkPlugins(path: string, cwd: string, env: NodeJS.ProcessEnv): Promise<void>;
}
/** Explicit allowlist: provider keys, fail-open flags, Node hooks and alternate endpoints are absent. */
export function museEnvironment(): NodeJS.ProcessEnv {
	const env = codingEnvironment();
	env["MUSE_NO_AUTO_UPDATE"] = "1";
	env["PATH"] = `${join(homedir(), ".local", "bin")}:${env["PATH"]}`;
	return env;
}
export const CODING_TOOLS = [
	"read_file",
	"edit_file",
	"write_file",
	"bash",
	"request_user_input",
] as const;
export const HOST_ARGS = [
	"serve",
	"--provider",
	"meta",
	"--preset",
	"miniswe",
	"--sandbox-network",
	"restricted",
	"-c",
	"agents.execution_capacity=1",
	"-c",
	`run.toolset=${JSON.stringify(CODING_TOOLS)}`,
	"-c",
	"hooks={}",
	"-c",
	"managed_hooks_path=null",
] as const;

/** Own the spawned process immediately, including a server that never answers initialize. */
export async function initializeOwnedHandshake(
	handshake: ReturnType<typeof spawnMspConnection>,
	signal: AbortSignal
) {
	let closing: Promise<void> | undefined;
	const close = () => {
		closing ??= handshake.close().then(() => {});
		return closing;
	};
	const abort = () => {
		void close().catch(() => {});
	};
	signal.addEventListener("abort", abort, { once: true });
	try {
		signal.throwIfAborted();
		return await abortable(
			handshake.initialize({
				clientInfo: { name: "muse_desktop_worker", version: "1" },
				capabilities: { experimentalApi: true, userInputDialogs: true },
			}),
			signal
		);
	} catch (error) {
		await close().catch(() => {});
		throw error;
	} finally {
		signal.removeEventListener("abort", abort);
	}
}
export const dependencies: MuseCodeDependencies = {
	async checkPlugins(path, cwd, env) {
		const stdout = await new Promise<string>((resolve, reject) =>
			execFile(
				path,
				["plugins", "list", "--json"],
				{ cwd, env, timeout: 5000, maxBuffer: 100_000, encoding: "utf8" },
				(error, stdout) => (error ? reject(error) : resolve(stdout))
			)
		);
		const catalog = z
			.object({
				plugins: z.array(z.object({ record: z.object({ enabled: z.boolean() }) })).max(100),
			})
			.parse(JSON.parse(stdout));
		if (catalog.plugins.some((plugin) => plugin.record.enabled))
			throw new MuseCodeRuntimeError("unsupported-cli");
	},
	async resolveBinary(selected) {
		const candidates =
			selected !== null
				? [selected]
				: [
						join(homedir(), ".local", "bin", "muse"),
						...(museEnvironment()["PATH"] ?? "")
							.split(":")
							.filter(Boolean)
							.map((path) => join(path, "muse")),
					];
		for (const candidate of candidates) {
			if (!isAbsolute(candidate) || candidate.includes("\0")) continue;
			try {
				await access(candidate, constants.X_OK);
				const path = await realpath(candidate);
				const stdout = await new Promise<string>((resolve, reject) =>
					execFile(
						path,
						["--version"],
						{ env: museEnvironment(), timeout: 5000, maxBuffer: 4096, encoding: "utf8" },
						(error, stdout) => (error ? reject(error) : resolve(stdout))
					)
				);
				const version = /^Muse Code (1\.4\.(?:13|14))\b/.exec(stdout)?.[1];
				if (!version) throw new MuseCodeRuntimeError("unsupported-cli");
				return { path, version };
			} catch (error) {
				if (error instanceof MuseCodeRuntimeError) throw error;
				if (selected !== null && (error as NodeJS.ErrnoException).code !== "ENOENT")
					throw new MuseCodeRuntimeError("unsupported-cli");
			}
		}
		throw new MuseCodeRuntimeError("not-installed");
	},
	async connect(path, cwd, env, signal) {
		const handshake = spawnMspConnection({
			command: path,
			args: HOST_ARGS,
			cwd,
			env,
			shutdownTimeoutMs: 500,
			onStderr: () => {},
		});
		try {
			const host = await initializeOwnedHandshake(handshake, signal);
			const durability = readSessionDurability(host.initializeResult);
			const client = new MuseClient(host.connection, { host, durability });
			return {
				info: host.initializeResult,
				durability: durability.kind,
				request: (method, params) => host.connection.request(method, params),
				command: (method, params, commandId) =>
					host.connection.command(method, params, {
						...(commandId ? { commandId } : {}),
						maxAttempts: 1,
					}),
				mintId: () => host.connection.mintCommandId(),
				start: (options) => client.startSession(options),
				resume: (options) => client.resumeSession(options),
				close: () => client.close(),
			};
		} catch (error) {
			await handshake.close().catch(() => {});
			throw error;
		}
	},
};

const accountSchema = z.object({ state: z.string(), credentialRequired: z.boolean() });
const windowSchema = z.object({
	usedPercent: z.int().nonnegative(),
	resetsAtMs: z.int().nonnegative(),
});
const refreshSchema = z.object({
	subscriptionActive: z.boolean().optional(),
	tierName: z.string().max(100).optional(),
	usage: z
		.object({
			observedAtMs: z.int().nonnegative(),
			tier: z.string(),
			weekly: windowSchema,
			window: windowSchema.extend({ windowDurationMins: z.int().positive() }),
		})
		.optional(),
});
export function baseStatus(version: string | null, error: MuseFailure | null): MuseCodeStatus {
	return {
		installed: error !== "not-installed",
		version,
		auth: "unknown",
		billing: "unknown",
		tier: null,
		ready: false,
		error,
	};
}
export function validateHost(host: MuseHost, version: string): void {
	if (!["1.4.13", "1.4.14"].includes(version)) throw new MuseCodeRuntimeError("unsupported-cli");
	const info = z
		.object({
			experimentalApi: z.literal(true),
			sandboxAvailability: z.literal("available"),
			schema: z.object({ fingerprint: z.string() }),
		})
		.parse(host.info);
	const expected =
		version === "1.4.13"
			? "sha256:7fddaf646dbc317e5fcac0785e135eb04df14fbb0db1863089dfd6da21730e5b"
			: "sha256:c94c3d1f2f51e6424074b9ec43eac3eedcf532d3dcd77351ec1383a87d3049c6";
	if (info.schema.fingerprint !== expected || host.durability !== "durable")
		throw new MuseCodeRuntimeError("unsupported-cli");
}
export async function accountStatus(
	host: MuseHost,
	version: string,
	signal: AbortSignal
): Promise<MuseCodeStatus> {
	const status = baseStatus(version, null);
	const account = accountSchema.parse(await abortable(host.request("account/read"), signal));
	if (account.state === "envKey" || account.state === "apiKey")
		return { ...status, auth: "api-key", billing: "pay-as-you-go", error: "api-key-selected" };
	if (account.state === "loggedOut")
		return { ...status, auth: "sign-in-required", error: "sign-in-required" };
	if (account.state !== "accountLogin" || !account.credentialRequired)
		return { ...status, error: "unavailable" };
	const refresh = refreshSchema.parse(await abortable(host.request("usage/refresh"), signal));
	status.auth = "account";
	if (refresh.subscriptionActive !== true)
		return {
			...status,
			error: refresh.subscriptionActive === false ? "subscription-required" : "unavailable",
		};
	status.billing = "subscription";
	status.tier =
		refresh.tierName &&
		/^[\p{L}\p{N} _.-]{1,100}$/u.test(refresh.tierName) &&
		redactCodingText(refresh.tierName) === refresh.tierName
			? refresh.tierName
			: null;
	const usage = refresh.usage;
	if (
		!usage ||
		Math.abs(Date.now() - usage.observedAtMs) > 60_000 ||
		usage.weekly.resetsAtMs <= Date.now() ||
		usage.window.resetsAtMs <= Date.now()
	)
		return { ...status, error: "unavailable" };
	if (usage.weekly.usedPercent >= 100 || usage.window.usedPercent >= 100)
		return { ...status, error: "quota-exceeded" };
	// Verify the effective lane again after the refresh mint; a stored key must not win silently.
	const current = accountSchema.parse(await abortable(host.request("account/read"), signal));
	if (current.state !== "accountLogin" || !current.credentialRequired)
		return {
			...status,
			auth:
				current.state === "apiKey" || current.state === "envKey"
					? "api-key"
					: current.state === "loggedOut"
						? "sign-in-required"
						: "unknown",
			billing:
				current.state === "apiKey" || current.state === "envKey" ? "pay-as-you-go" : "unknown",
			tier: null,
			ready: false,
			error:
				current.state === "apiKey" || current.state === "envKey"
					? "api-key-selected"
					: current.state === "loggedOut"
						? "sign-in-required"
						: "unavailable",
		};
	return { ...status, ready: true };
}
export async function assertAccount(host: MuseHost, signal: AbortSignal): Promise<void> {
	const state = accountSchema.parse(await abortable(host.request("account/read"), signal));
	if (state.state === "apiKey" || state.state === "envKey")
		throw new MuseCodeRuntimeError("api-key-selected");
	if (state.state === "loggedOut") throw new MuseCodeRuntimeError("sign-in-required");
	if (state.state !== "accountLogin" || !state.credentialRequired)
		throw new MuseCodeRuntimeError("unavailable");
}
export async function assertExtensions(
	host: MuseHost,
	signal: AbortSignal,
	sessionId?: string
): Promise<void> {
	const scope = sessionId ? { sessionId } : {};
	const mcp = z
		.object({ servers: z.array(z.unknown()).max(100) })
		.parse(await abortable(host.request("mcpServer/list", scope), signal));
	if (mcp.servers.length) throw new MuseCodeRuntimeError("unsupported-cli");
	if (sessionId) {
		const plugins = z
			.object({ plugins: z.array(z.object({ enabled: z.boolean() })).max(100) })
			.parse(await abortable(host.request("plugin/list", scope), signal));
		const hooks = z
			.object({ hooks: z.array(z.unknown()).max(100) })
			.parse(await abortable(host.request("hook/list", scope), signal));
		if (plugins.plugins.some((plugin) => plugin.enabled) || hooks.hooks.length)
			throw new MuseCodeRuntimeError("unsupported-cli");
	}
}
export function safeFailure(error: unknown): MuseCodeRuntimeError {
	if (error instanceof MuseCodeRuntimeError) return error;
	const parsed = z
		.object({
			kind: z.string().optional(),
			data: z.object({ quota: z.unknown().optional() }).passthrough().optional(),
		})
		.safeParse(error);
	if (parsed.success && parsed.data.kind === "authRequired")
		return new MuseCodeRuntimeError("sign-in-required");
	if (parsed.success && parsed.data.data?.quota !== undefined)
		return new MuseCodeRuntimeError("quota-exceeded");
	if (
		parsed.success &&
		["methodNotFound", "capabilityRequired", "invalidParams"].includes(parsed.data.kind ?? "")
	)
		return new MuseCodeRuntimeError("unsupported-cli");
	return new MuseCodeRuntimeError("unavailable");
}
