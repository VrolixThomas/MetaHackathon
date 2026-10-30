import {
	OAUTH_CALLBACK_URLS,
	type OAuthProvider,
	type OAuthStatus,
	OAuthStatusSchema,
} from "../../shared/contracts/oauth";

/** Controlled public metadata for unit/SSR tests only. */
export function status(provider: OAuthProvider, overrides: Partial<OAuthStatus> = {}): OAuthStatus {
	return OAuthStatusSchema.parse({
		provider,
		configurationReady: true,
		callbackUrl: OAUTH_CALLBACK_URLS[provider],
		phase: "disconnected",
		source: null,
		account: null,
		scopes: [],
		expiresAt: null,
		error: null,
		...overrides,
	});
}

export const connected = (provider: OAuthProvider, login = "test-account") =>
	status(provider, {
		phase: "connected",
		source: "oauth",
		account: { id: `test-${login}`, displayName: "Test User", login },
	});

export const statuses = (github = status("github"), linear = status("linear")) => [github, linear];

export function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}
