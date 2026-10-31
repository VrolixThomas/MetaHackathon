import { z } from "zod";
import { createStore } from "zustand/vanilla";
import {
	type OAuthErrorCode,
	type OAuthProvider,
	OAuthProviderInputSchema,
	OAuthProviderSchema,
	OAuthStartInputSchema,
	type OAuthStatus,
	OAuthStatusListSchema,
	OAuthStatusSchema,
} from "../../shared/contracts/oauth";
import type { ConversationApi } from "../conversation/api";

export const OAUTH_POLL_INTERVAL_MS = 3000;
export const OAUTH_CONNECTING_POLL_INTERVAL_MS = 1000;
export const OAUTH_PROVIDERS = OAuthProviderSchema.options;
export type OAuthOperation = "connect" | "cancel" | "disconnect";

export interface OAuthState {
	rows: OAuthStatus[];
	loading: boolean;
	busy: boolean;
	error: OAuthErrorCode | null;
	errors: Record<OAuthProvider, OAuthErrorCode | null>;
	pending: Record<OAuthProvider, OAuthOperation | null>;
	setupBusy: boolean;
	setupError: OAuthErrorCode | null;
}

export function hasPendingLogin(state: OAuthState) {
	return (
		state.rows.some((row) => row.phase === "connecting") ||
		OAUTH_PROVIDERS.some(
			(provider) => state.pending[provider] === "connect" || state.pending[provider] === "cancel"
		)
	);
}

/** App owns one instance shared by Settings and Connections. Only main owns credentials/login. */
export function createOAuthController(call: ConversationApi["call"]) {
	const store = createStore<OAuthState>(() => ({
		rows: [],
		loading: false,
		busy: false,
		error: null,
		errors: { github: null, linear: null, slack: null },
		pending: { github: null, linear: null, slack: null },
		setupBusy: false,
		setupError: null,
	}));
	type Operation = {
		kind: OAuthOperation;
		epoch: number;
		promise: Promise<OAuthStatus | null>;
	};
	const epochs = { github: 0, linear: 0, slack: 0 };
	const active: Record<OAuthProvider, Operation | undefined> = {
		github: undefined,
		linear: undefined,
		slack: undefined,
	};
	let disposed = false;
	let started = false;
	let actionEpoch = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let observing: { promise: Promise<void> } | undefined;
	let setup: { promise: Promise<void> } | undefined;

	function schedule() {
		clearTimeout(timer);
		if (!started || disposed) return;
		const connecting = store.getState().rows.some((row) => row.phase === "connecting");
		timer = setTimeout(
			() => void reload(),
			connecting ? OAUTH_CONNECTING_POLL_INTERVAL_MS : OAUTH_POLL_INTERVAL_MS
		);
	}

	function updateBusy() {
		store.setState({
			busy: OAUTH_PROVIDERS.some((provider) => !!active[provider]) || store.getState().setupBusy,
		});
	}

	function adopt(row: OAuthStatus) {
		const rows = store.getState().rows;
		store.setState({
			rows: OAUTH_PROVIDERS.flatMap((provider) => {
				const value =
					provider === row.provider ? row : rows.find((item) => item.provider === provider);
				return value ? [value] : [];
			}),
		});
	}

	function reload(): Promise<void> {
		if (disposed) return Promise.resolve();
		if (observing) return observing.promise;
		clearTimeout(timer);
		const reading = { ...epochs };
		const readingActionEpoch = actionEpoch;
		const observation = { promise: Promise.resolve() };
		observing = observation;
		store.setState({ loading: true });
		observation.promise = (async () => {
			try {
				const rows = OAuthStatusListSchema.parse(await call("query", "oauth.status", {}));
				if (disposed) return;
				const previous = store.getState().rows;
				store.setState({
					rows: OAUTH_PROVIDERS.flatMap((provider) => {
						// Fence reads started before OR during a mutation, independently for each provider.
						const candidates =
							reading[provider] === epochs[provider] && !active[provider] ? rows : previous;
						const row = candidates.find((item) => item.provider === provider);
						return row ? [row] : [];
					}),
					...(readingActionEpoch === actionEpoch ? { error: null } : {}),
				});
			} catch {
				if (!disposed && readingActionEpoch === actionEpoch) store.setState({ error: "provider" });
			} finally {
				observing = undefined;
				if (!disposed) {
					store.setState({ loading: false });
					schedule();
				}
			}
		})();
		return observation.promise;
	}

	function operate(provider: OAuthProvider, kind: OAuthOperation): Promise<OAuthStatus | null> {
		if (disposed) return Promise.resolve(null);
		OAuthProviderSchema.parse(provider);
		const prior = active[provider];
		if (prior?.kind === kind) return prior.promise;
		if (kind === "connect" && hasPendingLogin(store.getState())) return Promise.resolve(null);
		// Cancel supersedes a pending start immediately in the UI, then runs after its RPC.
		// This keeps one mutation in flight per provider and prevents late login adoption.
		if (prior && !(kind === "cancel" && prior.kind === "connect")) return Promise.resolve(null);
		const operation: Operation = {
			kind,
			epoch: ++epochs[provider],
			promise: Promise.resolve(null),
		};
		active[provider] = operation;
		++actionEpoch;
		store.setState((state) => ({
			pending: { ...state.pending, [provider]: kind },
			errors: { ...state.errors, [provider]: null },
		}));
		updateBusy();
		const current = () =>
			!disposed && active[provider] === operation && epochs[provider] === operation.epoch;
		operation.promise = (async () => {
			try {
				if (prior) await prior.promise;
				if (!current()) return null;
				const input =
					kind === "connect"
						? OAuthStartInputSchema.parse({ provider, requestId: crypto.randomUUID() })
						: OAuthProviderInputSchema.parse({ provider });
				const path = kind === "connect" ? "oauth.start" : `oauth.${kind}`;
				const row = OAuthStatusSchema.parse(await call("mutation", path, input));
				if (row.provider !== provider) throw new Error("OAuth provider identity mismatch");
				if (!current()) return null;
				adopt(row);
				return row;
			} catch {
				if (current())
					store.setState((state) => ({ errors: { ...state.errors, [provider]: "provider" } }));
				return null;
			} finally {
				if (current()) {
					++epochs[provider];
					++actionEpoch;
					active[provider] = undefined;
					store.setState((state) => ({ pending: { ...state.pending, [provider]: null } }));
					updateBusy();
					schedule();
				}
			}
		})();
		return operation.promise;
	}

	function openSetup(): Promise<void> {
		if (disposed) return Promise.resolve();
		if (setup) return setup.promise;
		const opening = { promise: Promise.resolve() };
		setup = opening;
		store.setState({ setupBusy: true, setupError: null });
		updateBusy();
		opening.promise = (async () => {
			try {
				z.void().parse(await call("mutation", "oauth.openSetup", {}));
			} catch {
				if (!disposed) store.setState({ setupError: "provider" });
			} finally {
				setup = undefined;
				if (!disposed) {
					store.setState({ setupBusy: false });
					updateBusy();
				}
			}
		})();
		return opening.promise;
	}

	return {
		store,
		start(): Promise<void> {
			if (disposed) return Promise.resolve();
			if (started) return observing?.promise ?? Promise.resolve();
			started = true;
			return reload();
		},
		reload,
		connect: (provider: OAuthProvider) => operate(provider, "connect"),
		cancel: (provider: OAuthProvider) => operate(provider, "cancel"),
		disconnect: (provider: OAuthProvider) => operate(provider, "disconnect"),
		openSetup,
		dispose() {
			if (disposed) return;
			disposed = true;
			started = false;
			clearTimeout(timer);
			timer = undefined;
		},
	};
}

export type OAuthController = ReturnType<typeof createOAuthController>;
