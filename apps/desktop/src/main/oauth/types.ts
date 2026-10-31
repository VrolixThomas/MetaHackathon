import { z } from "zod";
import {
	OAUTH_MESSAGES,
	OAuthAccountSchema,
	OAuthProviderSchema,
} from "../../shared/contracts/oauth";
import type { OAuthErrorCode, OAuthProvider } from "../../shared/contracts/oauth";
import type { SecretEncryption } from "../runtime/credentials";
import { SlackIdSchema, SlackScopesSchema } from "../slack/types";

/** Only fixed, public-safe messages may leave this module. Never attach a provider error/cause. */
export class OAuthError extends Error {
	constructor(readonly code: OAuthErrorCode) {
		super(OAUTH_MESSAGES[code]);
		this.name = "OAuthError";
	}
}

export function assertProvider(provider: OAuthProvider): void {
	if (!OAuthProviderSchema.safeParse(provider).success) throw new OAuthError("callback");
}

export interface OAuthClient {
	clientId: string;
	clientSecret?: string;
}

export interface OAuthServiceOptions {
	directory: string;
	encryption: SecretEncryption;
	getClient(provider: OAuthProvider): Promise<OAuthClient | undefined>;
	getManualToken(provider: OAuthProvider): Promise<string | undefined>;
	clearManualToken(provider: OAuthProvider): Promise<void>;
	openExternal(url: string): Promise<unknown>;
	onChange?: (provider: OAuthProvider) => Promise<void>;
	fetch?: typeof fetch;
	now?: () => number;
	callbackPort?: number;
	timeoutMs?: number;
}

export const TokenSchema = z
	.string()
	.min(1)
	.max(16384)
	.regex(/^[\x21-\x7e]+$/);
export const ScopesSchema = z
	.array(
		z
			.string()
			.min(1)
			.max(100)
			.regex(/^[\w:./-]+$/)
	)
	.max(50);
export const SlackIdentitySchema = z.strictObject({
	appId: SlackIdSchema,
	workspaceId: SlackIdSchema,
	userId: SlackIdSchema,
});
export const SessionSchema = z
	.strictObject({
		id: z.uuid(),
		provider: OAuthProviderSchema,
		account: OAuthAccountSchema,
		accessToken: TokenSchema,
		refreshToken: TokenSchema.nullable(),
		scopes: ScopesSchema,
		expiresAt: z.number().int().positive().nullable(),
		refreshExpiresAt: z.number().int().positive().nullable(),
		slack: SlackIdentitySchema.optional(),
	})
	.refine((session) =>
		session.provider === "slack"
			? session.slack !== undefined &&
				session.account.id === session.slack.userId &&
				SlackScopesSchema.safeParse(session.scopes).success &&
				Boolean(session.refreshToken) === Boolean(session.expiresAt) &&
				Boolean(session.refreshToken) === Boolean(session.refreshExpiresAt)
			: session.slack === undefined
	);
/** Main-only. Entire records, including profile and token identity, are encrypted. */
export type OAuthSession = z.infer<typeof SessionSchema>;

export function providerError(error: unknown, fallback: OAuthErrorCode): OAuthError {
	return error instanceof OAuthError ? error : new OAuthError(fallback);
}

export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () =>
			reject(signal.reason instanceof OAuthError ? signal.reason : new OAuthError("cancelled"));
		if (signal.aborted) {
			// Still observe rejections from an already-started operation.
			void work.catch(() => {});
			abort();
			return;
		}
		signal.addEventListener("abort", abort, { once: true });
		work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}
