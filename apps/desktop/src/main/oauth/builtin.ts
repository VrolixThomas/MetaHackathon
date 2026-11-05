import type { OAuthProvider } from "../../shared/contracts/oauth";

/**
 * OAuth app registrations baked into release builds. CI passes them from GitHub secrets and
 * electron-vite `define` replaces these reads at build time, so the downloaded app can sign in
 * without a local `.env`. Values are never committed. A local `.env` registration always wins,
 * and its ID/secret pair is never mixed with these built-in values.
 */
const builtin = {
	github: {
		clientId: process.env["MUSE_GITHUB_OAUTH_CLIENT_ID"],
		clientSecret: process.env["MUSE_GITHUB_OAUTH_CLIENT_SECRET"],
	},
	linear: {
		clientId: process.env["MUSE_LINEAR_OAUTH_CLIENT_ID"],
		clientSecret: process.env["MUSE_LINEAR_OAUTH_CLIENT_SECRET"],
	},
	slack: { clientId: process.env["MUSE_SLACK_OAUTH_CLIENT_ID"], clientSecret: undefined },
} as const;

export function builtinOAuthClient(
	provider: OAuthProvider
): { clientId: string; clientSecret?: string } | undefined {
	const { clientId, clientSecret } = builtin[provider];
	const id = clientId?.trim();
	if (!id) return undefined;
	const secret = clientSecret?.trim();
	return { clientId: id, ...(secret ? { clientSecret: secret } : {}) };
}

/** Explicit local registration first; the release build's registration otherwise. */
export async function resolveOAuthClient(
	provider: OAuthProvider,
	local: () => Promise<{ clientId: string; clientSecret?: string } | undefined>
) {
	return (await local()) ?? builtinOAuthClient(provider);
}
