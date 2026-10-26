import { type ChildProcess, execFile, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export interface ProcessOptions {
	command: string;
	args: string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	signal?: AbortSignal;
	maxOutputBytes?: number;
}

export interface ProcessResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	aborted: boolean;
	outputTruncated: boolean;
	durationMs: number;
}

/** Executes an argument array, owns its process group, and never logs command arguments or env. */
export async function runProcess(options: ProcessOptions): Promise<ProcessResult> {
	const started = performance.now();
	const timeoutMs = options.timeoutMs ?? 30_000;
	const maximum = options.maxOutputBytes ?? 1_048_576;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isInteger(maximum) || maximum < 0) {
		throw new Error("Invalid process limits");
	}
	if (options.signal?.aborted) {
		return {
			exitCode: null,
			stdout: "",
			stderr: "",
			timedOut: false,
			aborted: true,
			outputTruncated: false,
			durationMs: 0,
		};
	}
	return new Promise((resolve, reject) => {
		const child = spawn(options.command, options.args, {
			cwd: options.cwd,
			env: options.env ?? process.env,
			shell: false,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});
		let bytes = 0;
		let stdout = Buffer.alloc(0);
		let stderr = Buffer.alloc(0);
		let timedOut = false;
		let aborted = false;
		let outputTruncated = false;
		let settled = false;
		let escalation: ReturnType<typeof setTimeout> | undefined;
		let deadline: ReturnType<typeof setTimeout> | undefined;
		let stopping = false;
		const ownedDescendants = new Map<number, string>();
		const kill = (signal: NodeJS.Signals) => {
			if (!child.pid) return;
			try {
				if (process.platform === "win32") child.kill(signal);
				else process.kill(-child.pid, signal);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
			}
		};
		const signalDescendants = async (signal: NodeJS.Signals) => {
			const current = await processSnapshot();
			for (const [pid, birth] of ownedDescendants) {
				if (current.get(pid)?.birth !== birth) continue;
				try {
					process.kill(pid, signal);
				} catch {
					/* Exited after the identity check. */
				}
			}
		};
		const stop = () => {
			if (stopping) return;
			stopping = true;
			// A detached descendant can hold inherited pipes after its parent exits. Always settle.
			deadline = setTimeout(() => {
				kill("SIGKILL");
				child.stdout.destroy();
				child.stderr.destroy();
				complete(child.exitCode);
			}, 1000);
			void (async () => {
				const snapshot = await processSnapshot();
				const ancestors = new Set(child.pid ? [child.pid] : []);
				let changed = true;
				while (changed) {
					changed = false;
					for (const [pid, entry] of snapshot)
						if (!ancestors.has(pid) && ancestors.has(entry.parent)) {
							ancestors.add(pid);
							ownedDescendants.set(pid, entry.birth);
							changed = true;
						}
				}
				await signalDescendants("SIGTERM");
				kill("SIGTERM");
				if (!settled)
					escalation = setTimeout(() => {
						void signalDescendants("SIGKILL");
						kill("SIGKILL");
					}, 250);
			})();
		};
		const abort = () => {
			if (settled) return;
			aborted = true;
			stop();
		};
		const timeout = setTimeout(() => {
			if (settled) return;
			timedOut = true;
			stop();
		}, timeoutMs);
		const capture = (chunk: Buffer, destination: "stdout" | "stderr") => {
			const slice = chunk.subarray(0, Math.max(0, maximum - bytes));
			if (slice.length < chunk.length) outputTruncated = true;
			bytes += slice.length;
			if (destination === "stdout") stdout = Buffer.concat([stdout, slice]);
			else stderr = Buffer.concat([stderr, slice]);
		};
		child.stdout.on("data", (chunk: Buffer) => capture(chunk, "stdout"));
		child.stderr.on("data", (chunk: Buffer) => capture(chunk, "stderr"));
		const finish = () => {
			settled = true;
			clearTimeout(timeout);
			if (escalation) clearTimeout(escalation);
			if (deadline) clearTimeout(deadline);
			options.signal?.removeEventListener("abort", abort);
		};
		child.once("error", (error) => {
			finish();
			reject(error);
		});
		const complete = (exitCode: number | null) => {
			if (settled) return;
			// This one-shot command owns descendants even if they close stdio and outlive the leader.
			kill("SIGKILL");
			if (ownedDescendants.size) void signalDescendants("SIGKILL");
			finish();
			resolve({
				exitCode,
				// Do not expand a truncated UTF-8 suffix into replacement characters beyond the byte cap.
				stdout: new StringDecoder("utf8").write(stdout),
				stderr: new StringDecoder("utf8").write(stderr),
				timedOut,
				aborted,
				outputTruncated,
				durationMs: performance.now() - started,
			});
		};
		child.once("close", complete);
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) abort();
	});
}

/** No command lines/environments are collected. Birth identity prevents killing a reused PID. */
function processSnapshot(): Promise<Map<number, { parent: number; birth: string }>> {
	if (process.platform === "win32") return Promise.resolve(new Map());
	return new Promise((resolveSnapshot) => {
		execFile(
			"/bin/ps",
			["-axo", "pid=,ppid=,lstart="],
			{ timeout: 200, maxBuffer: 2_000_000 },
			(error, stdout) => {
				const rows = new Map<number, { parent: number; birth: string }>();
				if (!error)
					for (const line of stdout.split("\n")) {
						const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
						if (match)
							rows.set(Number(match[1]), { parent: Number(match[2]), birth: match[3] ?? "" });
					}
				resolveSnapshot(rows);
			}
		);
	});
}

/** Bounded cleanup for a long-lived process owned by this runtime, including detached descendants. */
export async function terminateOwnedProcess(child: ChildProcess): Promise<void> {
	if (!child.pid) return;
	const pid = child.pid;
	let closed = child.exitCode !== null || child.signalCode !== null;
	let closeListener: (() => void) | undefined;
	const closing = new Promise<void>((resolveClose) => {
		if (closed) {
			resolveClose();
			return;
		}
		closeListener = () => {
			closed = true;
			resolveClose();
		};
		child.once("close", closeListener);
	});
	const snapshot = await processSnapshot();
	const rootBirth =
		snapshot.get(pid)?.parent === process.pid ? snapshot.get(pid)?.birth : undefined;
	const descendants = new Map<number, string>();
	const ancestors = new Set([pid]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const [candidate, entry] of snapshot)
			if (!ancestors.has(candidate) && ancestors.has(entry.parent)) {
				ancestors.add(candidate);
				descendants.set(candidate, entry.birth);
				changed = true;
			}
	}
	const signalOwned = async (signal: NodeJS.Signals) => {
		const current = await processSnapshot();
		for (const [candidate, birth] of descendants)
			if (current.get(candidate)?.birth === birth) {
				try {
					process.kill(candidate, signal);
				} catch {
					/* Already exited. */
				}
			}
		try {
			if (process.platform === "win32") child.kill(signal);
			else if (
				!current.has(pid) ||
				(rootBirth &&
					current.get(pid)?.birth === rootBirth &&
					current.get(pid)?.parent === process.pid)
			)
				process.kill(-pid, signal);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	};
	try {
		await signalOwned("SIGTERM");
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			closing,
			new Promise<void>((resolveWait) => {
				timer = setTimeout(resolveWait, 250);
			}),
		]);
		clearTimeout(timer);
		await signalOwned("SIGKILL");
		// A pipe inherited by an unobservable reparented process cannot keep disposal pending.
		child.stdout?.destroy();
		child.stderr?.destroy();
		if (!closed) {
			await Promise.race([
				closing,
				new Promise<void>((resolveWait) => {
					timer = setTimeout(resolveWait, 250);
				}),
			]);
			clearTimeout(timer);
		}
	} finally {
		if (closeListener) child.off("close", closeListener);
	}
}
