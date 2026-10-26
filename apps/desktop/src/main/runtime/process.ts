import { spawn } from "node:child_process";
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
		let settled = false;
		let escalation: ReturnType<typeof setTimeout> | undefined;
		const kill = (signal: NodeJS.Signals) => {
			if (!child.pid) return;
			try {
				if (process.platform === "win32") child.kill(signal);
				else process.kill(-child.pid, signal);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
			}
		};
		const stop = () => {
			kill("SIGTERM");
			escalation ??= setTimeout(() => kill("SIGKILL"), 250);
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
			options.signal?.removeEventListener("abort", abort);
		};
		child.once("error", (error) => {
			finish();
			reject(error);
		});
		child.once("close", (exitCode) => {
			if (settled) return;
			// This one-shot command owns descendants even if they close stdio and outlive the leader.
			kill("SIGKILL");
			finish();
			resolve({
				exitCode,
				// Do not expand a truncated UTF-8 suffix into replacement characters beyond the byte cap.
				stdout: new StringDecoder("utf8").write(stdout),
				stderr: new StringDecoder("utf8").write(stderr),
				timedOut,
				aborted,
				durationMs: performance.now() - started,
			});
		});
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) abort();
	});
}
