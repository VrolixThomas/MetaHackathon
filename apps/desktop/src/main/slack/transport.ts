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

/** Fixed Slack HTTPS origin, bounded streaming JSON and sanitized errors. Never retries writes. */
export class SlackTransport {
	private readonly fetcher: typeof fetch;
	private readonly now: () => number;
	private readonly nextAllowed = new Map<string, number>();
	private active = 0;
	constructor(
		private readonly options: {
			fetch?: typeof fetch;
			now?: () => number;
			/** Default handles commercially distributed non-Marketplace limits conservatively. */
			historyIntervalMs?: number;
		} = {}
	) {
		this.fetcher = options.fetch ?? fetch;
		this.now = options.now ?? Date.now;
		if (
			!Number.isFinite(options.historyIntervalMs ?? 60_000) ||
			(options.historyIntervalMs ?? 60_000) < 0
		)
			throw new SlackError("invalid-data");
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
		if (this.active >= 4) throw new SlackError("capacity");
		const bucket = `${options.bucket ?? "oauth"}:${method}`;
		const remaining = (this.nextAllowed.get(bucket) ?? 0) - this.now();
		if (remaining > 0) throw new SlackError("rate-limited", Math.ceil(remaining / 1000));
		if (this.nextAllowed.size > 256) throw new SlackError("capacity");
		if (method === "conversations.history" || method === "conversations.replies")
			this.nextAllowed.set(bucket, this.now() + (this.options.historyIntervalMs ?? 60_000));
		const fields = options.fields ?? {};
		const body = options.form
			? new URLSearchParams(
					Object.entries(fields).map(([key, value]): [string, string] => [key, String(value)])
				).toString()
			: JSON.stringify(fields);
		this.active++;
		try {
			const response = await abortable(
				this.fetcher(`https://slack.com/api/${method}`, {
					method: "POST",
					redirect: "error",
					signal,
					headers: {
						Accept: "application/json",
						"Content-Type": options.form
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
				this.nextAllowed.set(bucket, this.now() + seconds * 1000);
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
			this.active--;
		}
	}
}
