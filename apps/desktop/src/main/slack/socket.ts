import { z } from "zod";
import type { SlackClient } from "./client";
import type { SlackIntake } from "./intake";
import { SlackError, SlackTokenSchema, abortable, parsed } from "./types";

export interface SlackSocket {
	onopen: (() => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	onerror: (() => void) | null;
	onclose: (() => void) | null;
	send(data: string): void;
	close(): void;
}
export interface SlackSocketState {
	mode: "connecting" | "socket" | "poll" | "stopped";
	reason:
		| "connected"
		| "unconfigured"
		| "disconnected"
		| "rate-limited"
		| "provider"
		| "capacity"
		| "cancelled";
}
export interface SlackSocketOptions {
	client: SlackClient;
	intake: Pick<SlackIntake, "receive">;
	getAppToken(): Promise<string | undefined>;
	connect?: (url: string) => SlackSocket;
	onState?: (state: SlackSocketState) => void;
	delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}
const EnvelopeSchema = z.object({
	type: z.string().max(100),
	envelope_id: z.string().min(1).max(200).optional(),
	payload: z.unknown().optional(),
	reason: z.string().max(100).optional(),
});

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await abortable(
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, milliseconds);
			}),
			signal
		);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** Explicitly started by root. The xapp token opens WSS only; user OAuth still gates every source. */
export class SlackSocketMode {
	private running = false;
	constructor(private readonly options: SlackSocketOptions) {}
	private state(state: SlackSocketState): void {
		try {
			this.options.onState?.(state);
		} catch {
			/* UI metadata cannot own transport lifecycle. */
		}
	}
	async run(signal: AbortSignal): Promise<void> {
		if (this.running) throw new SlackError("capacity");
		this.running = true;
		try {
			for (let failures = 0; failures < 5; failures++) {
				if (signal.aborted) break;
				let appToken: string | undefined;
				try {
					appToken = await abortable(this.options.getAppToken(), signal);
				} catch {
					if (signal.aborted) break;
					this.state({ mode: "poll", reason: "unconfigured" });
					return;
				}
				if (!appToken) {
					this.state({ mode: "poll", reason: "unconfigured" });
					return;
				}
				parsed(SlackTokenSchema, appToken);
				if (!/^(?:xapp-|xoxe\.xapp-)/.test(appToken)) {
					this.state({ mode: "poll", reason: "unconfigured" });
					return;
				}
				this.state({ mode: "connecting", reason: "disconnected" });
				let retry = true;
				try {
					const credential = await this.options.client.credential();
					const value = parsed(
						z.object({ url: z.string().max(4096) }),
						await this.options.client.transport.call("apps.connections.open", {
							token: appToken,
							bucket: credential.appId,
							signal,
						})
					);
					await this.options.client.assertCurrent(credential);
					const url = new URL(value.url);
					if (
						url.protocol !== "wss:" ||
						!url.hostname.endsWith(".slack.com") ||
						url.username ||
						url.password ||
						url.hash
					)
						throw new SlackError("invalid-data");
					retry = await this.connection(value.url, signal);
				} catch (error) {
					if (signal.aborted) break;
					this.state({
						mode: "poll",
						reason:
							error instanceof SlackError && error.code === "rate-limited"
								? "rate-limited"
								: "provider",
					});
					if (error instanceof SlackError && error.code === "rate-limited") return;
				}
				if (!retry) return;
				if (failures < 4)
					await (this.options.delay ?? delay)(Math.min(30000, 1000 * 2 ** failures), signal);
			}
			this.state(
				signal.aborted
					? { mode: "stopped", reason: "cancelled" }
					: { mode: "poll", reason: "disconnected" }
			);
		} catch {
			this.state(
				signal.aborted
					? { mode: "stopped", reason: "cancelled" }
					: { mode: "poll", reason: "provider" }
			);
		} finally {
			this.running = false;
		}
	}
	private connection(url: string, signal: AbortSignal): Promise<boolean> {
		return new Promise((resolve) => {
			let socket: SlackSocket;
			try {
				socket = this.options.connect
					? this.options.connect(url)
					: (new WebSocket(url) as unknown as SlackSocket);
			} catch {
				resolve(true);
				return;
			}
			let settled = false;
			let pending = 0;
			const finish = (retry: boolean, state: SlackSocketState) => {
				if (settled) return;
				settled = true;
				clearTimeout(openTimer);
				signal.removeEventListener("abort", cancel);
				socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
				try {
					socket.close();
				} catch {
					/* Closing a dead native socket is best effort. */
				}
				this.state(state);
				resolve(retry);
			};
			const cancel = () => finish(false, { mode: "stopped", reason: "cancelled" });
			const openTimer = setTimeout(
				() => finish(true, { mode: "poll", reason: "disconnected" }),
				15000
			);
			signal.addEventListener("abort", cancel, { once: true });
			socket.onopen = () => {
				clearTimeout(openTimer);
				this.state({ mode: "socket", reason: "connected" });
			};
			socket.onerror = socket.onclose = () =>
				finish(true, { mode: "poll", reason: "disconnected" });
			socket.onmessage = (event) => {
				if (settled) return;
				if (typeof event.data !== "string" || Buffer.byteLength(event.data) > 2 * 1024 * 1024) {
					finish(false, { mode: "poll", reason: "capacity" });
					return;
				}
				let payload: unknown;
				try {
					payload = JSON.parse(event.data);
				} catch {
					finish(false, { mode: "poll", reason: "provider" });
					return;
				}
				const result = EnvelopeSchema.safeParse(payload);
				if (!result.success) {
					finish(false, { mode: "poll", reason: "provider" });
					return;
				}
				const envelope = result.data;
				if (envelope.type === "disconnect") {
					finish(envelope.reason !== "link_disabled", { mode: "poll", reason: "disconnected" });
					return;
				}
				if (!envelope.envelope_id) return;
				if (pending >= 8) {
					finish(false, { mode: "poll", reason: "capacity" });
					return;
				}
				pending++;
				const work =
					envelope.type === "events_api"
						? this.options.intake.receive(envelope.payload, signal)
						: Promise.resolve("ignored");
				void work
					.then(
						() => {
							if (!settled && !signal.aborted) {
								try {
									socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
								} catch {
									finish(true, { mode: "poll", reason: "disconnected" });
								}
							}
						},
						() => finish(false, { mode: "poll", reason: "provider" })
					)
					.finally(() => {
						pending--;
					});
			};
			if (signal.aborted) cancel();
		});
	}
}
