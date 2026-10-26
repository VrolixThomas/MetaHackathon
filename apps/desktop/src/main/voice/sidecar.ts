import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { z } from "zod";

export interface VoiceCredentials {
	meta?: string;
	elevenlabs?: string;
	voiceId?: string;
}
export interface SidecarOptions {
	/** Trusted composition paths only, never supplied by renderer. */
	command: string;
	args?: string[];
	getCredentials: () => Promise<VoiceCredentials>;
	startupTimeoutMs?: number;
	requestTimeoutMs?: number;
}
export interface VoiceBackend {
	request: (path: string, body: unknown, signal?: AbortSignal) => Promise<unknown>;
	dispose: () => Promise<void>;
}
const ReadySchema = z.strictObject({ port: z.int().min(1).max(65535) });

/** Owns one private loopback server. Credentials and its bearer never leave main. */
export class VoiceSidecar implements VoiceBackend {
	private child?: ChildProcessWithoutNullStreams;
	private starting?: Promise<number>;
	private disposed = false;
	private disposal?: Promise<void>;
	private token = randomBytes(32).toString("hex");
	private lifetime = new AbortController();
	constructor(private options: SidecarOptions) {}

	/** Main composition may warm the local executable after credentials are configured. No provider request is made. */
	async prepare(): Promise<void> {
		await this.start();
	}

	private start(): Promise<number> {
		if (this.disposed) return Promise.reject(new Error("Voice service is shut down"));
		this.starting ??= this.launch();
		return this.starting;
	}
	private async launch(): Promise<number> {
		const credentials = await this.options.getCredentials();
		if (this.disposed) throw new Error("Voice service is shut down");
		const missing = [
			!credentials.meta && "MODEL_API_KEY",
			!credentials.elevenlabs && "ELEVENLABS_API_KEY",
			!credentials.voiceId && "ELEVENLABS_VOICE_ID",
		].filter(Boolean);
		if (missing.length) throw new Error(`Voice setup missing: ${missing.join(", ")}`);
		const child = spawn(this.options.command, [...(this.options.args ?? []), "--port", "0"], {
			shell: false,
			stdio: "pipe",
			env: {
				PATH: process.env["PATH"],
				HOME: process.env["HOME"],
				TMPDIR: process.env["TMPDIR"],
				LANG: "en_US.UTF-8",
				PYTHONUNBUFFERED: "1",
				VOICE_AUTH_TOKEN: this.token,
				MODEL_API_KEY: credentials.meta,
				ELEVENLABS_API_KEY: credentials.elevenlabs,
				ELEVENLABS_VOICE_ID: credentials.voiceId,
			},
		});
		this.child = child;
		// Provider libraries may log credential-bearing errors. Never forward raw stderr to renderer/logs.
		child.stderr.resume();
		return await new Promise<number>((resolve, reject) => {
			let buffer = "";
			let settled = false;
			const finish = (error?: Error, port?: number) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				child.stdout.off("data", onData);
				child.stdout.resume();
				if (error) {
					child.kill("SIGTERM");
					const killTimer = setTimeout(() => {
						if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
					}, 2000);
					killTimer.unref();
					child.once("exit", () => clearTimeout(killTimer));
					reject(error);
				} else resolve(port as number);
			};
			const timer = setTimeout(
				() => finish(new Error("Voice sidecar startup timed out")),
				this.options.startupTimeoutMs ?? 30_000
			);
			const onData = (chunk: Buffer) => {
				buffer += chunk.toString("utf8");
				if (buffer.length > 8192) {
					finish(new Error("Invalid voice readiness response"));
					return;
				}
				const newline = buffer.indexOf("\n");
				if (newline < 0) return;
				try {
					finish(undefined, ReadySchema.parse(JSON.parse(buffer.slice(0, newline))).port);
				} catch {
					finish(new Error("Invalid voice readiness response"));
				}
			};
			child.stdout.on("data", onData);
			child.once("error", () => finish(new Error("Voice executable could not start")));
			child.once("exit", () => {
				finish(new Error("Voice sidecar exited before readiness"));
				this.lifetime.abort();
			});
		});
	}
	async request(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
		if (!["offer", "release", "speak", "cancel", "poll"].includes(path))
			throw new Error("Unknown voice operation");
		if (this.disposed) throw new Error("Voice service is shut down");
		signal?.throwIfAborted();
		if (path === "cancel" && !this.starting) return {};
		const port = await this.start();
		if (this.disposed) throw new Error("Voice service is shut down");
		const combined = AbortSignal.any([
			this.lifetime.signal,
			AbortSignal.timeout(this.options.requestTimeoutMs ?? 15_000),
			...(signal ? [signal] : []),
		]);
		combined.throwIfAborted();
		const response = await fetch(`http://127.0.0.1:${port}/${path}`, {
			method: "POST",
			headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: combined,
			redirect: "error",
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`Voice ${path} failed (HTTP ${response.status})`);
		}
		const reader = response.body?.getReader();
		if (!reader) throw new Error("Empty voice response");
		let size = 0;
		const chunks: Uint8Array[] = [];
		try {
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				size += chunk.value.byteLength;
				if (size > 4_000_000) throw new Error("Voice response exceeds limit");
				chunks.push(chunk.value);
			}
			return JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} finally {
			await reader.cancel().catch(() => {});
			reader.releaseLock();
		}
	}
	dispose(): Promise<void> {
		this.disposed = true;
		this.lifetime.abort();
		this.disposal ??= this.stop();
		return this.disposal;
	}
	private async stop(): Promise<void> {
		const child = this.child;
		if (!child || child.exitCode !== null || child.signalCode !== null) return;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				resolve();
			}, 2000);
			child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
			child.kill("SIGTERM");
		});
	}
}
