import { z } from "zod";
import { OAuthAccountSchema } from "../../shared/contracts/oauth";
import type { OAuthAccount, OAuthProvider } from "../../shared/contracts/oauth";
import {
	exchangeSlackCode,
	refreshSlackToken,
	slackAuthorizationUrl,
	slackProfile,
} from "../slack/oauth";
import {
	type OAuthClient,
	OAuthError,
	type OAuthSession,
	ScopesSchema,
	TokenSchema,
	abortable,
} from "./types";

const endpoints = {
	github: {
		authorize: "https://github.com/login/oauth/authorize",
		token: "https://github.com/login/oauth/access_token",
		scope: "repo read:user read:org offline_access",
	},
	linear: {
		authorize: "https://linear.app/oauth/authorize",
		token: "https://api.linear.app/oauth/token",
		scope: "read,write",
	},
} as const;
const ClientSchema = z.object({
	clientId: z
		.string()
		.min(1)
		.max(1024)
		.regex(/^[\x21-\x7e]+$/),
	clientSecret: TokenSchema.optional(),
});

export function validClient(provider: OAuthProvider, input: unknown): OAuthClient | undefined {
	if (provider === "slack") {
		const result = ClientSchema.omit({ clientSecret: true }).safeParse(input);
		return result.success ? result.data : undefined;
	}
	const result = ClientSchema.safeParse(input);
	return result.success && (provider !== "github" || result.data.clientSecret)
		? result.data
		: undefined;
}

export function authorizationUrl(
	provider: OAuthProvider,
	client: OAuthClient,
	redirectUri: string,
	state: string,
	challenge: string
): string {
	if (provider === "slack")
		return slackAuthorizationUrl({
			clientId: client.clientId,
			redirectUri,
			state,
			challenge,
		});
	const url = new URL(endpoints[provider].authorize);
	url.search = new URLSearchParams({
		client_id: client.clientId,
		redirect_uri: redirectUri,
		state,
		scope: endpoints[provider].scope,
		code_challenge: challenge,
		code_challenge_method: "S256",
		...(provider === "linear" ? { response_type: "code", actor: "user", prompt: "consent" } : {}),
	}).toString();
	return url.href;
}

/** Responses and their errors are untrusted; only validated data ever escapes. */
async function json(
	fetcher: typeof fetch,
	url: string,
	init: RequestInit,
	parentSignal: AbortSignal
): Promise<unknown> {
	const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(15_000)]);
	try {
		const response = await abortable(fetcher(url, { ...init, redirect: "error", signal }), signal);
		if (
			!response.ok ||
			response.redirected ||
			!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")
		) {
			void response.body?.cancel().catch(() => {});
			throw new OAuthError("provider");
		}
		if (Number(response.headers.get("content-length") ?? 0) > 65536) {
			void response.body?.cancel().catch(() => {});
			throw new OAuthError("provider");
		}
		const reader = response.body?.getReader();
		if (!reader) throw new OAuthError("provider");
		const chunks: Uint8Array[] = [];
		let length = 0;
		try {
			while (true) {
				const chunk = await abortable(reader.read(), signal);
				if (chunk.done) break;
				length += chunk.value.length;
				if (length > 65536) throw new OAuthError("provider");
				chunks.push(chunk.value);
			}
		} finally {
			void reader.cancel().catch(() => {});
			reader.releaseLock();
		}
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch (error) {
		if (signal.aborted) throw signal.reason;
		throw error instanceof OAuthError ? error : new OAuthError("provider");
	}
}

const TokenResponseSchema = z.object({
	access_token: TokenSchema,
	token_type: z.string().regex(/^bearer$/i),
	refresh_token: TokenSchema.optional(),
	expires_in: z.number().int().positive().max(31536000).optional(),
	refresh_token_expires_in: z.number().int().positive().max(315360000).optional(),
	scope: z.union([z.string().max(5000), ScopesSchema]).optional(),
	error: z.unknown().optional(),
});

export async function exchange(options: {
	provider: OAuthProvider;
	client: OAuthClient;
	fetcher: typeof fetch;
	signal: AbortSignal;
	now: number;
	grant: { code: string; redirectUri: string; verifier: string } | { session: OAuthSession };
}): Promise<
	Pick<
		OAuthSession,
		"accessToken" | "refreshToken" | "expiresAt" | "refreshExpiresAt" | "scopes" | "slack"
	>
> {
	const { provider, client, signal, fetcher, grant } = options;
	if (provider === "slack") {
		const previous = "session" in grant ? grant.session : undefined;
		if (previous && !previous.slack) throw new OAuthError("storage");
		const value = previous?.slack
			? await refreshSlackToken({
					client,
					previous: { ...previous, ...previous.slack },
					fetch: fetcher,
					signal,
					now: options.now,
				})
			: "code" in grant
				? await exchangeSlackCode({
						client,
						...grant,
						fetch: fetcher,
						signal,
						now: options.now,
					})
				: undefined;
		if (!value) throw new OAuthError("provider");
		return {
			accessToken: value.accessToken,
			refreshToken: value.refreshToken,
			expiresAt: value.expiresAt,
			refreshExpiresAt: value.refreshExpiresAt,
			scopes: value.scopes,
			slack: { appId: value.appId, workspaceId: value.workspaceId, userId: value.userId },
		};
	}
	const fields = new URLSearchParams({ client_id: client.clientId });
	if (client.clientSecret) fields.set("client_secret", client.clientSecret);
	if ("session" in grant) {
		fields.set("grant_type", "refresh_token");
		fields.set("refresh_token", grant.session.refreshToken ?? "");
	} else {
		fields.set("grant_type", "authorization_code");
		fields.set("code", grant.code);
		fields.set("redirect_uri", grant.redirectUri);
		fields.set("code_verifier", grant.verifier);
	}
	const raw = await json(
		fetcher,
		endpoints[provider].token,
		{
			method: "POST",
			headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
			body: fields.toString(),
		},
		signal
	);
	const result = TokenResponseSchema.safeParse(raw);
	if (!result.success || result.data.error !== undefined) throw new OAuthError("provider");
	const value = result.data;
	if (provider === "linear" && (!value.refresh_token || !value.expires_in))
		throw new OAuthError("provider");
	const scopes = ScopesSchema.safeParse(
		typeof value.scope === "string"
			? value.scope.split(/[ ,]+/).filter(Boolean)
			: (value.scope ?? ("session" in grant ? grant.session.scopes : []))
	);
	if (!scopes.success) throw new OAuthError("provider");
	return {
		accessToken: value.access_token,
		refreshToken: value.refresh_token ?? ("session" in grant ? grant.session.refreshToken : null),
		expiresAt: value.expires_in ? options.now + value.expires_in * 1000 : null,
		refreshExpiresAt: value.refresh_token_expires_in
			? options.now + value.refresh_token_expires_in * 1000
			: null,
		scopes: scopes.data,
	};
}

const GitHubProfileSchema = z.object({
	id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	login: z.string().min(1).max(100),
	name: z.string().max(300).nullable().optional(),
	avatar_url: z.url().max(2048).optional(),
});
const LinearProfileSchema = z.object({
	data: z.object({
		viewer: z.object({ id: z.string().min(1).max(200), name: z.string().min(1).max(300) }),
	}),
	errors: z.unknown().optional(),
});

export async function profile(
	provider: OAuthProvider,
	token: string,
	fetcher: typeof fetch,
	signal: AbortSignal,
	slack?: OAuthSession["slack"]
): Promise<OAuthAccount> {
	if (provider === "slack") {
		if (!slack) throw new OAuthError("storage");
		return slackProfile({ grant: { ...slack, accessToken: token }, fetch: fetcher, signal });
	}
	const headers = {
		Authorization: `Bearer ${token}`,
		Accept: "application/json",
		"User-Agent": "MuseFocus-Desktop",
	};
	if (provider === "github") {
		const value = GitHubProfileSchema.safeParse(
			await json(fetcher, "https://api.github.com/user", { method: "GET", headers }, signal)
		);
		if (!value.success) throw new OAuthError("provider");
		const account = OAuthAccountSchema.safeParse({
			id: String(value.data.id),
			login: value.data.login,
			displayName: value.data.name || value.data.login,
			...(value.data.avatar_url ? { avatarUrl: value.data.avatar_url } : {}),
		});
		if (!account.success) throw new OAuthError("provider");
		return account.data;
	}
	const value = LinearProfileSchema.safeParse(
		await json(
			fetcher,
			"https://api.linear.app/graphql",
			{
				method: "POST",
				headers: { ...headers, "Content-Type": "application/json" },
				body: JSON.stringify({ query: "{ viewer { id name } }" }),
			},
			signal
		)
	);
	if (!value.success || value.data.errors !== undefined) throw new OAuthError("provider");
	return { id: value.data.data.viewer.id, displayName: value.data.data.viewer.name };
}
