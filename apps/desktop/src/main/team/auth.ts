import { createHash, randomBytes } from "node:crypto";
import {
	SessionSchema,
	TeamError,
	type TeamSession,
	boundedJson,
	secureUrl,
} from "../../../../../services/team/protocol";
import type { TeamStore } from "./storage";

/** Supabase Auth session, separate from existing GitHub/Linear/Slack credentials. Never expose tokens to renderer. */
export class TeamAuth {
	private epoch = 0;
	private pending: { verifier: string; redirect: string; expires: number; epoch: number } | null =
		null;
	private refresh: Promise<TeamSession> | null = null;
	readonly base: string;
	constructor(
		private readonly options: {
			url: string;
			publishableKey: string;
			store: TeamStore;
			fetch?: typeof fetch;
			now?: () => number;
			allowLocal?: boolean;
		}
	) {
		this.base = secureUrl(options.url, options.allowLocal).origin;
		// Only publishable/legacy anon keys. Never accept a service-role/admin secret here.
		if (options.publishableKey.startsWith("sb_secret_") || !options.publishableKey)
			throw new Error("Supabase publishable key required");
		if (options.publishableKey.split(".").length === 3) {
			try {
				if (
					JSON.parse(
						Buffer.from(options.publishableKey.split(".")[1] ?? "", "base64url").toString()
					).role !== "anon"
				)
					throw new Error();
			} catch {
				throw new Error("Supabase anon key required");
			}
		}
	}
	private now() {
		return (this.options.now ?? Date.now)();
	}
	beginLogin(callbackOrigin: string): string {
		const callback = secureUrl(callbackOrigin, true);
		if (
			callback.protocol !== "http:" ||
			callback.hostname !== "127.0.0.1" ||
			!callback.port ||
			callback.pathname !== "/"
		)
			throw new Error("Loopback callback origin required");
		const verifier = randomBytes(48).toString("base64url");
		const redirect = `${callback.origin}/team-auth/${randomBytes(32).toString("hex")}`;
		this.pending = { verifier, redirect, expires: this.now() + 300000, epoch: ++this.epoch };
		const url = new URL(`${this.base}/auth/v1/authorize`);
		url.search = new URLSearchParams({
			provider: "github",
			redirect_to: redirect,
			code_challenge: createHash("sha256").update(verifier).digest("base64url"),
			code_challenge_method: "s256",
		}).toString();
		return url.toString();
	}
	async finishLogin(callbackUrl: string): Promise<{ userId: string }> {
		const pending = this.pending;
		this.pending = null;
		const url = new URL(callbackUrl);
		if (
			!pending ||
			pending.expires < this.now() ||
			pending.epoch !== this.epoch ||
			`${url.origin}${url.pathname}` !== pending.redirect ||
			url.hash ||
			url.searchParams.has("error") ||
			!url.searchParams.get("code")
		)
			throw new TeamError("unauthorized");
		const session = await this.token("pkce", {
			auth_code: url.searchParams.get("code"),
			code_verifier: pending.verifier,
		});
		if (this.epoch !== pending.epoch) throw new TeamError("unauthorized");
		await this.options.store.write(session);
		return { userId: session.user.id };
	}
	private async token(grant: string, body: unknown): Promise<TeamSession> {
		let response: Response;
		try {
			response = await (this.options.fetch ?? fetch)(
				`${this.base}/auth/v1/token?grant_type=${grant}`,
				{
					method: "POST",
					redirect: "error",
					signal: AbortSignal.timeout(15000),
					headers: { apikey: this.options.publishableKey, "Content-Type": "application/json" },
					body: JSON.stringify(body),
				}
			);
		} catch {
			throw new TeamError("offline");
		}
		if (!response.ok)
			throw new TeamError(response.status >= 500 ? "unavailable" : "unauthorized", response.status);
		const raw = (await boundedJson(response, 100000)) as Record<string, unknown>;
		return SessionSchema.parse({
			...raw,
			expires_at: raw.expires_at ?? Math.floor(this.now() / 1000) + Number(raw.expires_in),
		});
	}
	async session(): Promise<TeamSession> {
		const epoch = this.epoch;
		const raw = await this.options.store.read();
		if (!raw || epoch !== this.epoch) throw new TeamError("unauthorized");
		const session = SessionSchema.parse(raw);
		if (session.expires_at * 1000 > this.now() + 60000) return session;
		if (this.refresh) return this.refresh;
		const operation = (async () => {
			try {
				const next = await this.token("refresh_token", { refresh_token: session.refresh_token });
				if (epoch !== this.epoch || next.user.id !== session.user.id)
					throw new TeamError("unauthorized");
				await this.options.store.write(next);
				return next;
			} catch (error) {
				if (error instanceof TeamError && error.code === "unauthorized" && epoch === this.epoch)
					await this.options.store.write(null);
				throw error;
			}
		})();
		this.refresh = operation;
		try {
			return await operation;
		} finally {
			if (this.refresh === operation) this.refresh = null;
		}
	}
	async status() {
		try {
			const session = await this.session();
			return { status: "connected" as const, userId: session.user.id };
		} catch (error) {
			return {
				status:
					error instanceof TeamError && error.code === "offline"
						? ("offline" as const)
						: ("disconnected" as const),
				userId: null,
			};
		}
	}
	get revision(): number {
		return this.epoch;
	}
	cancelLogin() {
		++this.epoch;
		this.pending = null;
	}
	async disconnect() {
		++this.epoch;
		this.pending = null;
		await this.options.store.write(null);
	}
}
