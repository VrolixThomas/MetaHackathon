import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { SlackError, abortable, parsed } from "./types";

const MethodSchema = z.enum([
	"oauth.v2.access",
	"auth.test",
	"users.info",
	"users.conversations",
	"conversations.info",
	"conversations.members",
	"conversations.history",
	"conversations.replies",
	"chat.postMessage",
	"apps.connections.open",
]);
export type SlackMethod = z.infer<typeof MethodSchema>;
const EnvelopeSchema = z.object({ ok: z.boolean(), error: z.string().max(100).optional() });
const authErrors = new Set([
	"invalid_auth",
	"token_expired",
	"token_revoked",
	"not_authed",
	"account_inactive",
]);
const accessErrors = new Set([
	"channel_not_found",
	"not_in_channel",
	"no_permission",
	"access_denied",
	"restricted_action",
	"thread_not_found",
]);

type Budget = { localUntil: number; providerUntil: number };
const MAX_READS = 8;
const MAX_READ_WAIT_MS = 10_000;

/** Fixed Slack HTTPS origin, bounded streaming JSON and sanitized errors. Never retries writes. */
export class SlackTransport {
	private readonly fetcher: typeof fetch;
	private readonly now: () => number;
	private readonly budgets = new Map<string, Budget>();
	private readonly readQueues = new Map<string, Array<() => void>>();
	private reads = 0;
	private lastNow = Number.NEGATIVE_INFINITY;
	private active = 0;
	constructor(
		private readonly options: {
			fetch?: typeof fetch;
			now?: () => number;
			/** Main-only clock/wait injection for controlled transport probes. */
			wait?: (ms: number, signal: AbortSignal) => Promise<void>;
			/** Default handles commercially distributed non-Marketplace limits conservatively. */
			historyIntervalMs?: number;
		} = {}
	) {
		this.fetcher = options.fetch ?? fetch;
		this.now = options.now ?? (() => performance.now());
		if (
			!Number.isFinite(options.historyIntervalMs ?? 60_000) ||
			(options.historyIntervalMs ?? 60_000) < 0
		)
			throw new SlackError("invalid-data");
	}
	private time(): number {
		const now = this.now();
		if (!Number.isFinite(now)) throw new SlackError("invalid-data");
		// Production uses a monotonic clock. A regressing injected clock must not grant quota.
		this.lastNow = Math.max(this.lastNow, now);
		return this.lastNow;
	}
	private assertProviderReady(budget: Budget): void {
		const remaining = budget.providerUntil - this.time();
		if (remaining > 0) throw new SlackError("rate-limited", Math.ceil(remaining / 1000));
	}
	private async reserveRead(bucket: string, budget: Budget, parent: AbortSignal) {
		if (this.reads >= MAX_READS) throw new SlackError("capacity");
		this.assertProviderReady(budget);
		const queue = this.readQueues.get(bucket) ?? [];
		this.readQueues.set(bucket, queue);
		let start = () => {};
		const turn = new Promise<void>((resolve) => {
			start = resolve;
		});
		queue.push(start);
		this.reads++;
		const release = () => {
			const index = queue.indexOf(start);
			if (index < 0) return;
			queue.splice(index, 1);
			start(); // Settle a cancelled waiter's gate as well as removing its queue position.
			this.reads--;
			if (!queue.length) this.readQueues.delete(bucket);
			else if (index === 0) queue[0]?.();
		};
		if (queue.length === 1) start();
		const timeout = new AbortController();
		const timer = setTimeout(() => timeout.abort(), MAX_READ_WAIT_MS);
		const signal = AbortSignal.any([parent, timeout.signal]);
		try {
			await abortable(turn, signal);
			while (true) {
				if (signal.aborted) throw new SlackError("cancelled");
				// A preceding HTTP 429 fences every queued read; it is never a local reservation.
				this.assertProviderReady(budget);
				const remaining = budget.localUntil - this.time();
				if (remaining <= 0) return release;
				const wait = this.options.wait
					? this.options.wait(remaining, signal)
					: delay(remaining, undefined, { signal });
				await abortable(wait, signal);
			}
		} catch (error) {
			release();
			if (signal.aborted) throw new SlackError("cancelled");
			throw error instanceof SlackError ? error : new SlackError("provider");
		} finally {
			clearTimeout(timer);
		}
	}
	async call(
		method: SlackMethod,
		options: {
			token?: string;
			authorization?: string;
			fields?: Record<string, string | number | boolean>;
			form?: boolean;
			signal?: AbortSignal;
			bucket?: string;
			maxBytes?: number;
		}
	): Promise<unknown> {
		parsed(MethodSchema, method);
		const signal = AbortSignal.any([
			...(options.signal ? [options.signal] : []),
			AbortSignal.timeout(15_000),
		]);
		if (signal.aborted) throw new SlackError("cancelled");
		const bucket = `${options.bucket ?? "oauth"}:${method}`;
		let budget = this.budgets.get(bucket);
		if (!budget) {
			if (this.budgets.size >= 256) throw new SlackError("capacity");
			budget = { localUntil: Number.NEGATIVE_INFINITY, providerUntil: Number.NEGATIVE_INFINITY };
			this.budgets.set(bucket, budget);
		}
		const history = method === "conversations.history" || method === "conversations.replies";
		const interval = this.options.historyIntervalMs ?? 60_000;
		let release: (() => void) | undefined;
		let active = false;
		try {
			// Only explicitly configured short read intervals queue. Commercial limits fail promptly.
			if (history && interval <= 1500) release = await this.reserveRead(bucket, budget, signal);
			if (signal.aborted) throw new SlackError("cancelled");
			this.assertProviderReady(budget);
			const remaining = budget.localUntil - this.time();
			if (remaining > 0) throw new SlackError("rate-limited", Math.ceil(remaining / 1000));
			// Waiting reads consume no HTTP capacity; other methods may have filled it meanwhile.
			if (this.active >= 4) throw new SlackError("capacity");
			const fields = options.fields ?? {};
			// Slack read/metadata endpoints consume form parameters; posting retains typed JSON.
			const form = options.form ?? method !== "chat.postMessage";
			const body = form
				? new URLSearchParams(
						Object.entries(fields).map(([key, value]): [string, string] => [key, String(value)])
					).toString()
				: JSON.stringify(fields);
			this.active++;
			active = true;
			if (history) budget.localUntil = this.time() + interval;
			const response = await abortable(
				this.fetcher(`https://slack.com/api/${method}`, {
					method: "POST",
					redirect: "error",
					signal,
					headers: {
						Accept: "application/json",
						"Content-Type": form
							? "application/x-www-form-urlencoded"
							: "application/json; charset=utf-8",
						...(options.authorization
							? { Authorization: options.authorization }
							: options.token
								? { Authorization: `Bearer ${options.token}` }
								: {}),
					},
					body,
				}),
				signal
			);
			if (response.status === 429) {
				void response.body?.cancel().catch(() => {});
				const raw = response.headers.get("retry-after") ?? "";
				const seconds = /^\d{1,7}$/.test(raw) ? Math.max(1, Number(raw)) : 60;
				budget.providerUntil = Math.max(budget.providerUntil, this.time() + seconds * 1000);
				throw new SlackError("rate-limited", seconds);
			}
			if (
				!response.ok ||
				response.redirected ||
				!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")
			) {
				void response.body?.cancel().catch(() => {});
				throw new SlackError(
					response.status === 401
						? "connection-required"
						: response.status === 403
							? "access-denied"
							: "provider"
				);
			}
			const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
			const reader = response.body?.getReader();
			if (!reader) throw new SlackError("invalid-data");
			const chunks: Uint8Array[] = [];
			let length = 0;
			let value: unknown;
			try {
				while (true) {
					const chunk = await abortable(reader.read(), signal);
					if (chunk.done) break;
					length += chunk.value.length;
					if (length > maxBytes) throw new SlackError("invalid-data");
					chunks.push(chunk.value);
				}
				try {
					value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				} catch {
					throw new SlackError("invalid-data");
				}
			} finally {
				void reader.cancel().catch(() => {});
				reader.releaseLock();
			}
			const envelope = parsed(EnvelopeSchema, value);
			if (!envelope.ok) {
				const error = envelope.error ?? "";
				throw new SlackError(
					authErrors.has(error)
						? "connection-required"
						: accessErrors.has(error)
							? "access-denied"
							: error === "missing_scope"
								? "missing-scope"
								: "provider"
				);
			}
			if (signal.aborted) throw new SlackError("cancelled");
			return value;
		} catch (error) {
			if (signal.aborted) throw new SlackError("cancelled");
			throw error instanceof SlackError ? error : new SlackError("provider");
		} finally {
			if (active) this.active--;
			release?.();
		}
	}
}
