import { z } from "zod";
import { IdSchema } from "./common";

export const OAuthProviderSchema = z.enum(["github", "linear"]);
export type OAuthProvider = z.infer<typeof OAuthProviderSchema>;
export const OAUTH_CALLBACK_PORT = 43187;
export const OAUTH_CALLBACK_URLS = {
	github: "http://127.0.0.1:43187/oauth/github/callback",
	linear: "http://127.0.0.1:43187/oauth/linear/callback",
} as const;
export const OAUTH_MESSAGES = {
	unconfigured: "Configure the OAuth application credentials in the app .env file.",
	busy: "Finish or cancel the current login before connecting another account.",
	cancelled: "Login cancelled.",
	denied: "Authorization was declined. You can connect again.",
	timeout: "Login timed out. Connect again to open a new browser session.",
	callback: "The login callback was not valid. Connect again.",
	provider: "The provider could not complete login. Check the application credentials and retry.",
	storage: "The account could not be saved securely on this device.",
	refresh: "The saved account needs to be reconnected.",
} as const;
export const OAuthErrorCodeSchema = z.enum([
	"unconfigured",
	"busy",
	"cancelled",
	"denied",
	"timeout",
	"callback",
	"provider",
	"storage",
	"refresh",
]);
export const OAuthAccountSchema = z.strictObject({
	id: z.string().min(1).max(200),
	displayName: z.string().min(1).max(300),
	login: z.string().min(1).max(100).optional(),
	avatarUrl: z.url().max(2048).optional(),
});
/** Public account metadata only. Application credentials and tokens never cross IPC. */
export const OAuthStatusSchema = z.strictObject({
	provider: OAuthProviderSchema,
	configurationReady: z.boolean(),
	callbackUrl: z.url().max(2048),
	phase: z.enum(["disconnected", "connecting", "connected", "error"]),
	source: z.enum(["oauth", "env"]).nullable(),
	account: OAuthAccountSchema.nullable(),
	scopes: z.array(z.string().min(1).max(100)).max(50),
	expiresAt: z.iso.datetime().nullable(),
	error: OAuthErrorCodeSchema.nullable(),
});
export const OAuthStatusListSchema = z
	.array(OAuthStatusSchema)
	.length(2)
	.refine((rows) => new Set(rows.map((r) => r.provider)).size === 2, "One status per provider");
export const OAuthStartInputSchema = z.strictObject({
	provider: OAuthProviderSchema,
	requestId: IdSchema,
});
export const OAuthProviderInputSchema = z.strictObject({ provider: OAuthProviderSchema });
export type OAuthStatus = z.infer<typeof OAuthStatusSchema>;
export type OAuthAccount = z.infer<typeof OAuthAccountSchema>;
export type OAuthStartInput = z.infer<typeof OAuthStartInputSchema>;
export type OAuthErrorCode = z.infer<typeof OAuthErrorCodeSchema>;
