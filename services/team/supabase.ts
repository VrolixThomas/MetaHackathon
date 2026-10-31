import { TeamError, boundedJson, secureUrl } from "./protocol";

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
		init: { method?: string; body?: unknown; prefer?: string } = {}
	): Promise<unknown> {
		if (!/^\/(?:rest|auth)\/v1\//.test(path)) throw new TeamError("invalid");
		let response: Response;
		try {
			response = await (this.options.fetch ?? fetch)(`${this.base}${path}`, {
				method: init.method ?? "GET",
				redirect: "error",
				signal: AbortSignal.timeout(15000),
				headers: {
					apikey: this.options.key,
					Authorization: `Bearer ${this.options.token ?? this.options.key}`,
					"Content-Type": "application/json",
					...(init.prefer ? { Prefer: init.prefer } : {}),
				},
				...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
			});
		} catch {
			throw new TeamError("offline");
		}
		if (!response.ok) {
			const error = (await boundedJson(response, 20000).catch(() => null)) as {
				code?: string;
			} | null;
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
			: boundedJson(response);
	}
	rpc(name: string, body: unknown) {
		if (!/^team_[a-z_]+$/.test(name)) throw new TeamError("invalid");
		return this.request(`/rest/v1/rpc/${name}`, { method: "POST", body });
	}
}
export function query(table: string, filters: Record<string, string>, select = "*"): string {
	if (!/^team_[a-z_]+$/.test(table)) throw new TeamError("invalid");
	return `/rest/v1/${table}?${new URLSearchParams({ select, ...Object.fromEntries(Object.entries(filters).map(([key, value]) => [key, `eq.${value}`])) }).toString()}`;
}
