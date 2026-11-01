import { abortable } from "../../apps/desktop/src/main/agent/cancellation";
import { TeamError, secureUrl } from "./protocol";

/** Bounds fetch AND body consumption, even for transports that ignore cancellation. */
export async function requestWithTimeout<T>(
	timeoutMs: number,
	caller: AbortSignal | undefined,
	operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
	const controller = new AbortController();
	const signal = caller ? AbortSignal.any([caller, controller.signal]) : controller.signal;
	const timer = setTimeout(
		() => controller.abort(new DOMException("Request timed out", "TimeoutError")),
		timeoutMs
	);
	try {
		signal.throwIfAborted();
		return await abortable(operation(signal), signal);
	} finally {
		clearTimeout(timer);
		controller.abort();
	}
}

/** A stuck read/cancel cannot retain a worker after its caller has stopped. */
export async function abortableJson(response: Response, limit: number, signal: AbortSignal) {
	signal.throwIfAborted();
	const reader = response.body?.getReader();
	if (!reader) throw new TeamError("invalid");
	const chunks: Uint8Array[] = [];
	let count = 0;
	try {
		while (true) {
			signal.throwIfAborted();
			const { done, value } = await abortable(reader.read(), signal);
			if (done) break;
			count += value.byteLength;
			if (count > limit) throw new TeamError("invalid");
			chunks.push(value);
		}
		signal.throwIfAborted();
		return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
	} finally {
		void reader.cancel().catch(() => {});
	}
}

/** Main/server transport. Admin instance is server-only; user instances always carry Supabase JWT. */
export class SupabaseRest {
	readonly base: string;
	constructor(
		private readonly options: {
			url: string;
			key: string;
			token?: string;
			fetch?: typeof fetch;
			allowLocal?: boolean;
		}
	) {
		this.base = secureUrl(options.url, options.allowLocal).origin;
	}
	async request(
		path: string,
		init: { method?: string; body?: unknown; prefer?: string } = {},
		caller?: AbortSignal
	): Promise<unknown> {
		if (!/^\/(?:rest|auth)\/v1\//.test(path)) throw new TeamError("invalid");
		return requestWithTimeout(15000, caller, async (signal) => {
			let response: Response;
			try {
				response = await abortable(
					(this.options.fetch ?? fetch)(`${this.base}${path}`, {
						method: init.method ?? "GET",
						redirect: "error",
						signal,
						headers: {
							apikey: this.options.key,
							Authorization: `Bearer ${this.options.token ?? this.options.key}`,
							"Content-Type": "application/json",
							...(init.prefer ? { Prefer: init.prefer } : {}),
						},
						...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
					}),
					signal
				);
			} catch {
				signal.throwIfAborted();
				throw new TeamError("offline");
			}
			if (!response.ok) {
				const error = (await abortableJson(response, 20000, signal).catch(() => null)) as {
					code?: string;
				} | null;
				signal.throwIfAborted();
				throw new TeamError(
					response.status === 401
						? "unauthorized"
						: response.status === 403
							? "forbidden"
							: response.status === 409 || error?.code === "40001"
								? "conflict"
								: response.status >= 500
									? "unavailable"
									: "invalid",
					response.status
				);
			}
			return response.status === 204 || response.headers.get("content-length") === "0"
				? null
				: abortableJson(response, 4_000_000, signal);
		});
	}
	rpc(name: string, body: unknown, signal?: AbortSignal) {
		if (!/^team_[a-z_]+$/.test(name)) throw new TeamError("invalid");
		return this.request(`/rest/v1/rpc/${name}`, { method: "POST", body }, signal);
	}
}
export function query(table: string, filters: Record<string, string>, select = "*"): string {
	if (!/^team_[a-z_]+$/.test(table)) throw new TeamError("invalid");
	return `/rest/v1/${table}?${new URLSearchParams({ select, ...Object.fromEntries(Object.entries(filters).map(([key, value]) => [key, `eq.${value}`])) }).toString()}`;
}
