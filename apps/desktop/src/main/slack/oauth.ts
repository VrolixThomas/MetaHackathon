import { z } from "zod";
import { SlackTransport } from "./transport";
import { SlackError, SlackIdSchema, SlackScopesSchema, SlackTokenSchema, parsed } from "./types";

export const SLACK_USER_SCOPES = [
	"channels:read",
	"channels:history",
	"groups:read",
	"groups:history",
	"im:read",
	"im:history",
	"mpim:read",
	"mpim:history",
	"users:read",
	"chat:write",
] as const;
const ClientSchema = z.strictObject({ clientId: SlackTokenSchema, clientSecret: SlackTokenSchema });
export type SlackOAuthClient = z.infer<typeof ClientSchema>;
const TokenFieldsSchema = z.object({
	access_token: SlackTokenSchema,
	token_type: z.literal("user"),
	scope: z.string().max(10000),
	refresh_token: SlackTokenSchema.optional(),
	expires_in: z.int().positive().max(31536000).optional(),
});
const GrantSchema = z.object({
	app_id: SlackIdSchema,
	team: z.object({ id: SlackIdSchema, name: z.string().max(300).optional() }),
	authed_user: TokenFieldsSchema.extend({ id: SlackIdSchema }),
});
export interface SlackUserGrant {
	appId: string;
	workspaceId: string;
	userId: string;
	accessToken: string;
	scopes: string[];
	refreshToken: string | null;
	expiresAt: number | null;
}

export function slackRedirectUri(input: string): string {
	try {
		const url = new URL(input);
		if (
			input.length > 2048 ||
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.hash
		)
			throw new Error();
		return input;
	} catch {
		throw new SlackError("invalid-data");
	}
}

/** Root supplies one-time state, optional S256 challenge, and a registered HTTPS callback. */
export function slackAuthorizationUrl(input: {
	clientId: string;
	redirectUri: string;
	state: string;
	challenge?: string;
}): string {
	const url = new URL("https://slack.com/oauth/v2/authorize");
	url.search = new URLSearchParams({
		client_id: parsed(SlackTokenSchema, input.clientId),
		redirect_uri: slackRedirectUri(input.redirectUri),
		state: parsed(SlackTokenSchema, input.state),
		user_scope: SLACK_USER_SCOPES.join(","),
		...(input.challenge
			? { code_challenge: parsed(SlackTokenSchema, input.challenge), code_challenge_method: "S256" }
			: {}),
	}).toString();
	return url.href;
}

function tokenFields(value: z.infer<typeof TokenFieldsSchema>, now: number) {
	if (Boolean(value.expires_in) !== Boolean(value.refresh_token))
		throw new SlackError("invalid-data");
	return {
		accessToken: value.access_token,
		scopes: parsed(SlackScopesSchema, value.scope.split(/[ ,]+/).filter(Boolean)),
		refreshToken: value.refresh_token ?? null,
		expiresAt: value.expires_in ? now + value.expires_in * 1000 : null,
	};
}

async function exchange(
	client: SlackOAuthClient,
	fields: Record<string, string>,
	options: {
		fetch?: typeof fetch;
		signal?: AbortSignal;
	}
): Promise<unknown> {
	const validated = parsed(ClientSchema, client);
	return new SlackTransport({ fetch: options.fetch }).call("oauth.v2.access", {
		authorization: `Basic ${Buffer.from(`${validated.clientId}:${validated.clientSecret}`).toString("base64")}`,
		form: true,
		fields,
		signal: options.signal,
		maxBytes: 65536,
	});
}

/** Nested authed_user only; top-level bot credentials are deliberately never substituted. */
export async function exchangeSlackCode(input: {
	client: SlackOAuthClient;
	code: string;
	redirectUri: string;
	verifier?: string;
	fetch?: typeof fetch;
	signal?: AbortSignal;
	now?: number;
}): Promise<SlackUserGrant> {
	const value = parsed(
		GrantSchema,
		await exchange(
			input.client,
			{
				code: parsed(SlackTokenSchema, input.code),
				redirect_uri: slackRedirectUri(input.redirectUri),
				grant_type: "authorization_code",
				...(input.verifier ? { code_verifier: parsed(SlackTokenSchema, input.verifier) } : {}),
			},
			input
		)
	);
	return {
		appId: value.app_id,
		workspaceId: value.team.id,
		userId: value.authed_user.id,
		...tokenFields(value.authed_user, input.now ?? Date.now()),
	};
}

/** Root serializes refresh and atomically persists the replacement single-use refresh token. */
export async function refreshSlackToken(input: {
	client: SlackOAuthClient;
	previous: SlackUserGrant;
	fetch?: typeof fetch;
	signal?: AbortSignal;
	now?: number;
}): Promise<SlackUserGrant> {
	if (!input.previous.refreshToken) throw new SlackError("connection-required");
	const raw = await exchange(
		input.client,
		{
			grant_type: "refresh_token",
			refresh_token: parsed(SlackTokenSchema, input.previous.refreshToken),
		},
		input
	);
	const value = parsed(TokenFieldsSchema, raw);
	if (!value.refresh_token || !value.expires_in) throw new SlackError("invalid-data");
	return { ...input.previous, ...tokenFields(value, input.now ?? Date.now()) };
}
