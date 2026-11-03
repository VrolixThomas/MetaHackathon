import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
	type FileHandle,
	lstat,
	mkdir,
	open,
	readdir,
	realpath,
	rename,
	unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { throwIfAborted } from "./cancellation";
import {
	type CodingCommandInput,
	type CodingCommandResult,
	type CodingFileWrite,
	CodingWorkerCheckpointSchema,
	type CodingWorkerPorts,
} from "./coding-worker";
import { CodingToolError, redactCodingText } from "./coding-worker-safety";

type ExecutionPorts = Pick<
	CodingWorkerPorts,
	"listFiles" | "readFile" | "writeFile" | "editFile" | "runCommand"
>;
export interface CodingAllowedCommand {
	command: string;
	args: string[];
}
export interface CodingWorkerToolsOptions {
	worktreePath: string;
	/** Main-approved exact argv additions, e.g. an existing repository's custom validation. */
	allowedCommands?: readonly CodingAllowedCommand[];
	/** Keep credential values in this closure; never put them in a model or IPC payload. */
	redactText?: (text: string) => string;
}

const MAX_FILE_BYTES = 1_000_000;
const MAX_READ_CHARS = 40000;
const MAX_COMMAND_OUTPUT = 32000;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const blockedPart = (part: string) =>
	/^(?:\.git|node_modules|\.env(?:\..*)?|\.ssh|\.aws|\.azure|\.gnupg|\.netrc|\.npmrc|\.pypirc|credentials(?:\..*)?|secrets?(?:\..*)?)$/i.test(
		part
	) || /\.(?:pem|key|p12|pfx|keystore)$/i.test(part);
const isWithin = (root: string, target: string) =>
	target === root ||
	(!relative(root, target).startsWith(`..${sep}`) &&
		relative(root, target) !== ".." &&
		!isAbsolute(relative(root, target)));
const missing = (error: unknown) =>
	!!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
const hasControl = (text: string) => [...text].some((char) => char.charCodeAt(0) < 32);

/**
 * Scoped cooperative file tools and bounded direct-argv validation. This is NOT an OS
 * security sandbox: repository validation code runs with the current user's file access.
 * Main owns the child process/worktree and must review commands and changes independently.
 */
export function createCodingWorkerTools(options: CodingWorkerToolsOptions): ExecutionPorts {
	if (!isAbsolute(options.worktreePath)) throw new Error("Coding worktree path must be absolute");
	const rootReady = realpath(options.worktreePath);
	const redact = (text: string) => redactCodingText(options.redactText?.(text) ?? text);
	const observed = new Map<string, string>();
	const scriptSnapshot = readOriginalScripts();
	// Lazy callers may never invoke a tool; still observe setup failures.
	void rootReady.catch(() => {});
	void scriptSnapshot.catch(() => {});

	async function scoped(path: string, allowMissing = false): Promise<string> {
		const root = await rootReady;
		if (!path || isAbsolute(path) || path.includes("\\") || hasControl(path))
			throw new CodingToolError("path", "Use a worktree-relative path");
		const parts = path.split("/").filter((part) => part !== "." && part !== "");
		if (parts.some((part) => part === ".." || blockedPart(part)))
			throw new CodingToolError("path", "Protected or escaping worktree path");
		const target = resolve(root, ...parts);
		if (!isWithin(root, target)) throw new CodingToolError("path", "Path escapes the worktree");
		let current = root;
		for (let index = 0; index < parts.length; index++) {
			current = join(current, parts[index] as string);
			try {
				const info = await lstat(current);
				if (info.isSymbolicLink())
					throw new CodingToolError("symlink", "Symlinks are not available to coding tools");
				if (!isWithin(root, await realpath(current)))
					throw new CodingToolError("path", "Resolved path escapes the worktree");
				if (index < parts.length - 1 && !info.isDirectory())
					throw new CodingToolError("path", "Parent path is not a directory");
			} catch (error) {
				if (allowMissing && missing(error)) break;
				if (error instanceof CodingToolError) throw error;
				throw new CodingToolError(
					"file",
					missing(error) ? "Worktree path does not exist" : "Worktree path could not be inspected"
				);
			}
		}
		return target;
	}

	async function rawRead(path: string): Promise<string> {
		const target = await scoped(path);
		let handle: FileHandle | undefined;
		try {
			handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
			const info = await handle.stat();
			if (!info.isFile() || info.nlink !== 1)
				throw new CodingToolError(
					"file",
					"Only regular, non-hardlinked source files are available"
				);
			if (info.size > MAX_FILE_BYTES)
				throw new CodingToolError("size", "Source file exceeds the bounded read size");
			await scoped(path);
			const bytes = await handle.readFile();
			if (bytes.byteLength > MAX_FILE_BYTES || bytes.includes(0))
				throw new CodingToolError("file", "Only bounded UTF-8 text source is available");
			const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			return text;
		} catch (error) {
			if (error instanceof CodingToolError) throw error;
			throw new CodingToolError("file", "Source file could not be read as UTF-8 text");
		} finally {
			await handle?.close();
		}
	}

	async function prepareParent(path: string): Promise<void> {
		const root = await rootReady;
		const parent = dirname(await scoped(path, true));
		const parts = relative(root, parent).split(sep).filter(Boolean);
		for (let index = 0; index < parts.length; index++) {
			const subpath = parts.slice(0, index + 1).join("/");
			const next = await scoped(subpath, true);
			try {
				await mkdir(next);
			} catch (error) {
				if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST")
					throw error;
			}
			await scoped(subpath);
		}
	}

	async function write(
		path: string,
		content: string,
		expected: string | null,
		signal: AbortSignal
	): Promise<CodingFileWrite> {
		throwIfAborted(signal);
		await scoped(path, true);
		if (content.includes("[REDACTED") || redact(content) !== content)
			throw new CodingToolError(
				"credential",
				"Credential-bearing or redacted content cannot be written"
			);
		if (Buffer.byteLength(content) > 100000)
			throw new CodingToolError("size", "Write exceeds the bounded file size");
		let current: string | null = null;
		try {
			current = await rawRead(path);
		} catch (error) {
			// Only absence permits creating a new file. Protected/binary/unreadable files stay blocked.
			try {
				await lstat(await scoped(path, true));
			} catch (absent) {
				if (!missing(absent)) throw error;
			}
			if (await exists(path)) throw error;
		}
		if (current !== null && redact(current) !== current)
			throw new CodingToolError("credential", "Redacted source cannot be overwritten");
		if (
			expected === null
				? current !== null
				: current === null || sha256(current) !== expected || observed.get(path) !== expected
		) {
			throw new CodingToolError(
				"conflict",
				"File is unobserved or has changed; read its current contents before writing"
			);
		}
		await prepareParent(path);
		const target = await scoped(path, true);
		const temp = join(dirname(target), `.muse-write-${randomUUID()}`);
		let handle: FileHandle | undefined;
		try {
			const mode = current === null ? 0o644 : (await lstat(target)).mode & 0o777;
			handle = await open(temp, "wx", mode);
			await handle.writeFile(content, "utf8");
			await handle.sync();
			await handle.close();
			handle = undefined;
			throwIfAborted(signal);
			await scoped(path, true);
			// Re-check expected state immediately before the atomic replacement.
			if (current === null ? await exists(path) : sha256(await rawRead(path)) !== expected)
				throw new CodingToolError("conflict", "File changed before replacement");
			throwIfAborted(signal);
			await rename(temp, target);
			observed.set(path, sha256(content));
			return { path, sha256: sha256(content) };
		} finally {
			await handle?.close();
			await unlink(temp).catch(() => {});
		}
	}
	async function exists(path: string): Promise<boolean> {
		try {
			await lstat(await scoped(path, true));
			return true;
		} catch (error) {
			if (missing(error)) return false;
			throw error;
		}
	}
	async function readOriginalScripts(): Promise<Record<string, string>> {
		try {
			const json = JSON.parse(await rawRead("package.json"));
			return Object.fromEntries(
				Object.entries(json.scripts ?? {}).filter(
					(entry): entry is [string, string] => typeof entry[1] === "string"
				)
			);
		} catch {
			return {};
		}
	}
	async function permitted(input: CodingCommandInput): Promise<boolean> {
		if (input.command === "bun" && input.args.length === 2 && input.args[0] === "test") {
			const path = input.args[1] ?? "";
			if (
				!/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_][A-Za-z0-9_.-]*\.(?:test|spec)\.[cm]?[jt]sx?$/.test(
					path
				)
			)
				return false;
			await rawRead(path); // Existing regular owned file; reject symlink/secret/escaping paths.
			return true;
		}
		if (
			options.allowedCommands?.some(
				(allowed) =>
					allowed.command === input.command &&
					JSON.stringify(allowed.args) === JSON.stringify(input.args)
			)
		)
			return true;
		if (
			!["bun", "npm", "pnpm", "yarn"].includes(input.command) ||
			input.args.length !== 2 ||
			input.args[0] !== "run"
		)
			return false;
		const name = input.args[1] ?? "";
		if (!/^(?:test(?::unit)?|lint|type-check|typecheck|check:types|build)$/.test(name))
			return false;
		const original = await scriptSnapshot;
		const current = await readOriginalScripts();
		return (
			!!original[name] &&
			original[name] === current[name] &&
			["pre", "post"].every(
				(prefix) => original[`${prefix}${name}`] === current[`${prefix}${name}`]
			)
		);
	}

	return {
		async listFiles(input, signal) {
			throwIfAborted(signal);
			const target = await scoped(input.path);
			const entries = [];
			const found = await readdir(target, { withFileTypes: true });
			let truncated = false;
			for (const entry of found.sort((a, b) => a.name.localeCompare(b.name))) {
				if (
					blockedPart(entry.name) ||
					entry.isSymbolicLink() ||
					(!entry.isFile() && !entry.isDirectory())
				)
					continue;
				if (entries.length >= input.maxEntries) {
					truncated = true;
					break;
				}
				entries.push({
					path: input.path === "." ? entry.name : `${input.path}/${entry.name}`,
					type: entry.isDirectory() ? ("directory" as const) : ("file" as const),
				});
			}
			throwIfAborted(signal);
			return { entries, truncated };
		},
		async readFile(input, signal) {
			throwIfAborted(signal);
			const text = await rawRead(input.path);
			const lines = text.split("\n");
			const endLine = Math.min(input.endLine ?? lines.length, lines.length, input.startLine + 799);
			if (input.startLine > lines.length || endLine < input.startLine)
				throw new CodingToolError("lines", "Source line range is outside the file");
			const selected = lines.slice(input.startLine - 1, endLine).join("\n");
			const clean = redact(selected);
			observed.set(input.path, sha256(text));
			throwIfAborted(signal);
			return {
				path: input.path,
				text: clean.slice(0, MAX_READ_CHARS),
				sha256: sha256(text),
				startLine: input.startLine,
				endLine,
				truncated: endLine < (input.endLine ?? lines.length) || clean.length > MAX_READ_CHARS,
				redacted: clean !== selected,
			};
		},
		writeFile: (input, signal) => write(input.path, input.content, input.expectedSha256, signal),
		async editFile(input, signal) {
			throwIfAborted(signal);
			const text = await rawRead(input.path);
			if (
				sha256(text) !== input.expectedSha256 ||
				observed.get(input.path) !== input.expectedSha256
			)
				throw new CodingToolError("conflict", "Read the current file before editing");
			const index = text.indexOf(input.oldText);
			if (!input.oldText || index < 0 || text.indexOf(input.oldText, index + 1) >= 0)
				throw new CodingToolError("match", "Edit must match exactly one occurrence");
			return write(
				input.path,
				text.slice(0, index) + input.newText + text.slice(index + input.oldText.length),
				input.expectedSha256,
				signal
			);
		},
		async runCommand(input, signal) {
			throwIfAborted(signal);
			if (
				!Number.isInteger(input.timeoutMs) ||
				input.timeoutMs < 100 ||
				input.timeoutMs > 120000 ||
				input.args.length > 50 ||
				hasControl(input.command) ||
				input.args.some(hasControl)
			)
				throw new CodingToolError("command", "Invalid direct-argv command");
			if (redact(JSON.stringify(input)) !== JSON.stringify(input))
				throw new CodingToolError("credential", "Credentials cannot be passed to commands");
			if (!(await permitted(input)))
				throw new CodingToolError(
					"command-policy",
					"Use an unchanged existing validation script (bun/npm/pnpm/yarn run test, test:unit, lint, type-check, typecheck, check:types or build), bun test <repo-relative .test/.spec file>, or a main-approved exact argv command. No shell, installs, app launch or Git writes."
				);
			throwIfAborted(signal);
			// A ./ prefix makes Bun execute this file instead of interpreting its name as a filter.
			const execution =
				input.command === "bun" && input.args[0] === "test" && input.args.length === 2
					? { ...input, args: ["test", `./${input.args[1]}`] }
					: input;
			return runValidation(execution, await rootReady, signal, redact);
		},
	};
}

/** Deliberate environment allowlist: no provider tokens, NODE_OPTIONS, BUN_OPTIONS or preload hooks. */
export function codingCommandEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { CI: "1", NO_COLOR: "1", LANG: "en_US.UTF-8" };
	for (const key of ["PATH", "TMPDIR", "TEMP", "TMP", "SystemRoot", "WINDIR"]) {
		if (process.env[key]) env[key] = process.env[key];
	}
	return env;
}

async function runValidation(
	input: CodingCommandInput,
	cwd: string,
	signal: AbortSignal,
	redact: (text: string) => string
): Promise<CodingCommandResult> {
	const startedAt = new Date().toISOString();
	return new Promise((resolveResult, reject) => {
		const child = spawn(input.command, input.args, {
			cwd,
			env: codingCommandEnvironment(),
			shell: false,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let truncated = false;
		const overflow = { stdout: false, stderr: false };
		let interrupted = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const kill = (kind: NodeJS.Signals) => {
			if (!child.pid) return;
			try {
				if (process.platform !== "win32") process.kill(-child.pid, kind);
				else child.kill(kind);
			} catch {
				/* already exited */
			}
		};
		const stop = () => {
			interrupted = true;
			kill("SIGTERM");
			killTimer ??= setTimeout(() => kill("SIGKILL"), 1000);
			killTimer.unref();
		};
		const timeout = setTimeout(stop, input.timeoutMs);
		const clean = () => {
			clearTimeout(timeout);
			if (killTimer) clearTimeout(killTimer);
			signal.removeEventListener("abort", stop);
		};
		signal.addEventListener("abort", stop, { once: true });
		if (signal.aborted) stop();
		const append = (target: "stdout" | "stderr", chunk: Buffer) => {
			if (overflow[target]) return;
			const previous = target === "stdout" ? stdout : stderr;
			const value = previous + chunk.toString("utf8");
			if (value.length > MAX_COMMAND_OUTPUT * 2) {
				truncated = true;
				overflow[target] = true;
			}
			// Discard an overflowing stream entirely: a clipped token at the capture
			// boundary cannot then escape the complete-value redaction filter.
			if (target === "stdout") stdout = overflow[target] ? "" : value;
			else stderr = overflow[target] ? "" : value;
		};
		child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
		child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
		child.once("error", () => {
			clean();
			reject(new CodingToolError("spawn", "Validation process could not start"));
		});
		child.once("close", (exitCode, exitSignal) => {
			if (interrupted) kill("SIGKILL");
			clean();
			if (signal.aborted) {
				reject(new DOMException("Operation cancelled", "AbortError"));
				return;
			}
			const cleanOut = overflow.stdout ? "[Output exceeded bounded capture limit]" : redact(stdout);
			const cleanErr = overflow.stderr ? "[Output exceeded bounded capture limit]" : redact(stderr);
			resolveResult({
				command: input.command,
				args: input.args,
				cwd,
				startedAt,
				finishedAt: new Date().toISOString(),
				exitCode,
				signal: exitSignal,
				stdout: cleanOut.slice(0, MAX_COMMAND_OUTPUT),
				stderr: cleanErr.slice(0, MAX_COMMAND_OUTPUT),
				truncated:
					truncated || cleanOut.length > MAX_COMMAND_OUTPUT || cleanErr.length > MAX_COMMAND_OUTPUT,
				interrupted,
			});
		});
	});
}

/** Atomic private JSON persistence for a single main-chosen checkpoint path. No model path input. */
export function createCodingWorkerCheckpointStore(
	checkpointPath: string
): Pick<CodingWorkerPorts, "loadCheckpoint" | "saveCheckpoint"> {
	if (!isAbsolute(checkpointPath)) throw new Error("Checkpoint path must be absolute");
	const expected = resolve(checkpointPath);
	const check = (path: string) => {
		if (resolve(path) !== expected) throw new Error("Checkpoint store path mismatch");
	};
	return {
		async loadCheckpoint(path) {
			check(path);
			let handle: FileHandle | undefined;
			try {
				handle = await open(expected, constants.O_RDONLY | constants.O_NOFOLLOW);
				const info = await handle.stat();
				if (!info.isFile() || info.size > 2_000_000 || info.nlink !== 1)
					throw new Error("Invalid coding checkpoint file");
				return CodingWorkerCheckpointSchema.parse(JSON.parse(await handle.readFile("utf8")));
			} catch (error) {
				if (missing(error)) return null;
				throw error;
			} finally {
				await handle?.close();
			}
		},
		async saveCheckpoint(path, checkpoint) {
			check(path);
			const encoded = JSON.stringify(CodingWorkerCheckpointSchema.parse(checkpoint));
			if (Buffer.byteLength(encoded) > 2_000_000)
				throw new Error("Coding checkpoint exceeds storage limit");
			await mkdir(dirname(expected), { recursive: true, mode: 0o700 });
			const directory = await realpath(dirname(expected));
			const target = join(directory, basename(expected));
			const temp = join(directory, `.muse-checkpoint-${randomUUID()}`);
			let handle: FileHandle | undefined;
			try {
				handle = await open(temp, "wx", 0o600);
				await handle.writeFile(encoded, "utf8");
				await handle.sync();
				await handle.close();
				handle = undefined;
				await rename(temp, target);
				const dir = await open(directory, "r");
				try {
					await dir.sync();
				} finally {
					await dir.close();
				}
			} finally {
				await handle?.close();
				await unlink(temp).catch(() => {});
			}
		},
	};
}
