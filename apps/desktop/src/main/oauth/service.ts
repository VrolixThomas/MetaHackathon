import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { PRODUCT_NAME } from "../../shared/brand";
import {
	OAUTH_CALLBACK_PORT,
	OAUTH_CALLBACK_URLS,
	OAuthProviderSchema,
	OAuthStartInputSchema,
	OAuthStatusSchema,
} from "../../shared/contracts/oauth";
import type {
	OAuthErrorCode,
	OAuthProvider,
	OAuthStartInput,
	OAuthStatus,
} from "../../shared/contracts/oauth";
import { type SlackCredential, SlackCredentialSchema } from "../slack/types";
import { authorizationUrl, exchange, profile, validClient } from "./providers";
import { OAuthStore } from "./store";
import {
	OAuthError,
	type OAuthServiceOptions,
	type OAuthSession,
	abortable,
	assertProvider,
	providerError,
} from "./types";

export { OAuthError } from "./types";
export type { OAuthServiceOptions } from "./types";

interface Flow {
	provider: OAuthProvider;
	epoch: number;
	state: string;
	verifier: string;
	controller: AbortController;
	code: Promise<string>;
	resolveCode: (code: string) => void;
	consumed: boolean;
	server?: Server;
	redirectUri?: string;
	timer?: ReturnType<typeof setTimeout>;
}

// One foreground browser login per process, even when two service instances are constructed.
let globalFlow: Flow | undefined;
const providers = OAuthProviderSchema.options;
const callbackHtml = `<!doctype html><html lang="en"><meta charset="utf-8"><title>${PRODUCT_NAME} login</title><p>Return to ${PRODUCT_NAME} to continue. You can close this window.</p></html>`;

export class OAuthService {
	private readonly store: OAuthStore;
	private readonly fetcher: typeof fetch;
	private readonly now: () => number;
	private readonly epochs: Record<OAuthProvider, number> = { github: 0, linear: 0, slack: 0 };
	private readonly errors: Partial<Record<OAuthProvider, OAuthErrorCode>> = {};
	private readonly pending: Partial<Record<OAuthProvider, Promise<unknown>>> = {};
	private readonly refreshes = new Map<
		OAuthProvider,
		{ id: string; epoch: number; controller: AbortController; promise: Promise<OAuthSession> }
	>();
	private readonly requests = new Map<string, OAuthProvider>();
	private flow?: Flow;
	private disposed = false;

	constructor(private readonly options: OAuthServiceOptions) {
		this.store = new OAuthStore(options.directory, options.encryption);
		this.fetcher = options.fetch ?? fetch;
		this.now = options.now ?? Date.now;
		if (
			!Number.isInteger(options.callbackPort ?? OAUTH_CALLBACK_PORT) ||
			(options.callbackPort ?? OAUTH_CALLBACK_PORT) < 0 ||
			(options.callbackPort ?? OAUTH_CALLBACK_PORT) > 65535 ||
			!Number.isFinite(options.timeoutMs ?? 300000) ||
			(options.timeoutMs ?? 300000) <= 0
		)
			throw new OAuthError("callback");
	}

	private current(provider: OAuthProvider, epoch: number): boolean {
		return !this.disposed && this.epochs[provider] === epoch;
	}

	private assertCurrent(provider: OAuthProvider, epoch: number): void {
		if (!this.current(provider, epoch)) throw new OAuthError("cancelled");
	}

	private fence(provider: OAuthProvider): number {
		this.epochs[provider] += 1;
		this.refreshes.get(provider)?.controller.abort(new OAuthError("cancelled"));
		this.refreshes.delete(provider);
		return this.epochs[provider];
	}

	private serial<T>(provider: OAuthProvider, action: () => Promise<T>): Promise<T> {
		const result = (this.pending[provider] ?? Promise.resolve()).then(action);
		this.pending[provider] = result.catch(() => {});
		return result;
	}

	private async notify(provider: OAuthProvider): Promise<void> {
		try {
			await this.options.onChange?.(provider);
		} catch {
			/* Data refresh is owned by composition, not authentication. */
		}
	}

	private commit(
		provider: OAuthProvider,
		epoch: number,
		signal: AbortSignal,
		session: OAuthSession,
		expectedId?: string
	): Promise<void> {
		return this.serial(provider, async () => {
			const previous = await this.store.get(provider);
			this.assertCurrent(provider, epoch);
			if (signal.aborted || (expectedId && previous?.id !== expectedId))
				throw new OAuthError("cancelled");
			await this.store.set(session);
			// Cancellation can arrive while the atomic filesystem replacement is in flight.
			// Restore before any queued clear or newer login is allowed to commit.
			if (!this.current(provider, epoch) || signal.aborted) {
				if (previous) await this.store.set(previous);
				else await this.store.delete(provider);
				throw new OAuthError("cancelled");
			}
		});
	}

	private async view(provider: OAuthProvider): Promise<OAuthStatus> {
		let configurationReady = false;
		try {
			configurationReady = Boolean(validClient(provider, await this.options.getClient(provider)));
		} catch {
			/* Configuration details stay main-only. */
		}
		let session: OAuthSession | undefined;
		let source: OAuthStatus["source"] = null;
		let storageError = false;
		try {
			await this.pending[provider];
			if (await this.store.has(provider)) {
				source = "oauth";
				session = await this.store.get(provider);
			} else if (await this.options.getManualToken(provider)) source = "env";
		} catch {
			storageError = true;
		}
		const error = storageError ? "storage" : (this.errors[provider] ?? null);
		const connecting = this.flow?.provider === provider && this.current(provider, this.flow.epoch);
		return OAuthStatusSchema.parse({
			provider,
			configurationReady,
			callbackUrl:
				this.flow?.provider === provider && this.flow.redirectUri
					? this.flow.redirectUri
					: OAUTH_CALLBACK_URLS[provider],
			phase: connecting ? "connecting" : error ? "error" : source ? "connected" : "disconnected",
			source,
			account: session?.account
				? {
						...session.account,
						...(provider === "slack" && session.slack
							? { workspaceId: session.slack.workspaceId }
							: {}),
					}
				: null,
			scopes: session?.scopes ?? [],
			expiresAt: session?.expiresAt ? new Date(session.expiresAt).toISOString() : null,
			error: connecting ? null : error,
		});
	}

	async status(): Promise<OAuthStatus[]> {
		return Promise.all(providers.map((provider) => this.view(provider)));
	}

	async start(input: OAuthStartInput): Promise<OAuthStatus> {
		const parsed = OAuthStartInputSchema.safeParse(input);
		if (!parsed.success) throw new OAuthError("callback");
		const { provider, requestId } = parsed.data;
		if (this.disposed) throw new OAuthError("cancelled");
		const previous = this.requests.get(requestId);
		if (previous) {
			if (previous !== provider) throw new OAuthError("callback");
			return this.view(provider);
		}
		if (globalFlow) return { ...(await this.view(provider)), phase: "error", error: "busy" };
		this.requests.set(requestId, provider);
		if (this.requests.size > 128) {
			const oldest = this.requests.keys().next().value;
			if (oldest) this.requests.delete(oldest);
		}
		const epoch = this.fence(provider);
		delete this.errors[provider];
		let resolveCode: (code: string) => void = () => {};
		const code = new Promise<string>((resolve) => {
			resolveCode = resolve;
		});
		const flow: Flow = {
			provider,
			epoch,
			state: randomBytes(32).toString("base64url"),
			verifier: randomBytes(32).toString("base64url"),
			controller: new AbortController(),
			code,
			resolveCode,
			consumed: false,
		};
		this.flow = globalFlow = flow;
		flow.timer = setTimeout(
			() => flow.controller.abort(new OAuthError("timeout")),
			this.options.timeoutMs ?? 300000
		);
		flow.timer.unref?.();
		void this.run(flow);
		return this.view(provider);
	}

	private reply(response: ServerResponse, status: number): void {
		response.writeHead(status, {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
			"Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
			"Referrer-Policy": "no-referrer",
			"X-Content-Type-Options": "nosniff",
			Connection: "close",
		});
		response.end(callbackHtml);
	}

	private callback(flow: Flow, request: IncomingMessage, response: ServerResponse): void {
		if (
			!this.current(flow.provider, flow.epoch) ||
			flow.controller.signal.aborted ||
			flow.consumed
		) {
			this.reply(response, 410);
			return;
		}
		const raw = request.url ?? "";
		// Bind HTTP authority as well as the socket; localhost must reject numeric/rebound Hosts.
		if (
			!flow.redirectUri ||
			request.headers.host !== new URL(flow.redirectUri).host ||
			request.rawHeaders.filter(
				(_, index) => index % 2 === 0 && request.rawHeaders[index]?.toLowerCase() === "host"
			).length !== 1
		) {
			this.reply(response, 400);
			return;
		}
		if (
			request.method !== "GET" ||
			raw.length > 8192 ||
			!raw.startsWith(`/oauth/${flow.provider}/callback?`)
		) {
			this.reply(response, 404);
			return;
		}
		let url: URL;
		try {
			url = new URL(raw, flow.redirectUri);
		} catch {
			this.reply(response, 400);
			return;
		}
		if (
			url.pathname !== `/oauth/${flow.provider}/callback` ||
			url.hash ||
			url.searchParams.size > 12 ||
			[...url.searchParams].some(([key, value]) => key.length > 100 || value.length > 2048)
		) {
			this.reply(response, 400);
			return;
		}
		const states = url.searchParams.getAll("state");
		if (
			states.length !== 1 ||
			states[0]?.length !== flow.state.length ||
			Buffer.byteLength(states[0]) !== Buffer.byteLength(flow.state) ||
			!timingSafeEqual(Buffer.from(states[0]), Buffer.from(flow.state))
		) {
			this.reply(response, 400);
			return;
		}
		const codes = url.searchParams.getAll("code");
		const errors = url.searchParams.getAll("error");
		if (errors.length === 1 && errors[0] && codes.length === 0) {
			flow.consumed = true;
			response.once("finish", () => flow.controller.abort(new OAuthError("denied")));
			this.reply(response, 200);
			return;
		}
		if (codes.length !== 1 || !codes[0] || !/^[\x21-\x7e]+$/.test(codes[0]) || errors.length) {
			this.reply(response, 400);
			return;
		}
		flow.consumed = true;
		response.once("finish", () => flow.resolveCode(codes[0] as string));
		this.reply(response, 200);
	}

	private async closeServer(flow: Flow): Promise<void> {
		const server = flow.server;
		if (!server) return;
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
			server.closeAllConnections();
		});
	}

	private async release(flow: Flow): Promise<void> {
		clearTimeout(flow.timer);
		await this.closeServer(flow);
		if (this.flow === flow) this.flow = undefined;
		if (globalFlow === flow) globalFlow = undefined;
	}

	private async run(flow: Flow): Promise<void> {
		const { provider, epoch, controller } = flow;
		const signal = controller.signal;
		let connected = false;
		try {
			const client = validClient(
				provider,
				await abortable(this.options.getClient(provider), signal)
			);
			if (!client) throw new OAuthError("unconfigured");
			this.assertCurrent(provider, epoch);
			this.store.assertSecure();
			const server = createServer({ maxHeaderSize: 8192 }, (request, response) =>
				this.callback(flow, request, response)
			);
			flow.server = server;
			server.requestTimeout = 3000;
			server.headersTimeout = 3000;
			server.timeout = 3000;
			await abortable(
				new Promise<void>((resolve, reject) => {
					server.once("error", () => reject(new OAuthError("callback")));
					server.once("listening", () => {
						if (signal.aborted || !this.current(provider, epoch)) {
							void this.closeServer(flow);
							reject(new OAuthError("cancelled"));
						} else resolve();
					});
					server.listen(this.options.callbackPort ?? OAUTH_CALLBACK_PORT, "127.0.0.1");
				}),
				signal
			);
			const address = server.address();
			if (!address || typeof address === "string") throw new OAuthError("callback");
			flow.redirectUri = `http://${new URL(OAUTH_CALLBACK_URLS[provider]).hostname}:${address.port}/oauth/${provider}/callback`;
			const challenge = createHash("sha256").update(flow.verifier).digest("base64url");
			await abortable(
				this.options.openExternal(
					authorizationUrl(provider, client, flow.redirectUri, flow.state, challenge)
				),
				signal
			);
			const code = await abortable(flow.code, signal);
			await this.closeServer(flow);
			const tokens = await exchange({
				provider,
				client,
				fetcher: this.fetcher,
				signal,
				now: this.now(),
				grant: { code, redirectUri: flow.redirectUri, verifier: flow.verifier },
			});
			const account = await profile(
				provider,
				tokens.accessToken,
				this.fetcher,
				signal,
				tokens.slack
			);
			await this.commit(provider, epoch, signal, {
				id: randomUUID(),
				provider,
				account,
				...tokens,
			});
			this.assertCurrent(provider, epoch);
			delete this.errors[provider];
			connected = true;
		} catch (error) {
			if (this.current(provider, epoch))
				this.errors[provider] = providerError(error, "provider").code;
		} finally {
			await this.release(flow);
			if (connected && this.current(provider, epoch)) void this.notify(provider);
		}
	}

	async cancel(provider: OAuthProvider): Promise<OAuthStatus> {
		assertProvider(provider);
		const epoch = this.fence(provider);
		if (this.flow?.provider === provider) {
			const flow = this.flow;
			flow.controller.abort(new OAuthError("cancelled"));
			await this.release(flow);
			if (this.current(provider, epoch)) this.errors[provider] = "cancelled";
		}
		return this.view(provider);
	}

	private async clear(provider: OAuthProvider, manual: boolean): Promise<void> {
		assertProvider(provider);
		const epoch = this.fence(provider);
		const flow = this.flow?.provider === provider ? this.flow : undefined;
		flow?.controller.abort(new OAuthError("cancelled"));
		const deletion = this.serial(provider, async () => {
			let failed = false;
			try {
				await this.store.delete(provider);
			} catch {
				failed = true;
			}
			if (manual) {
				try {
					await this.options.clearManualToken(provider);
				} catch {
					failed = true;
				}
			}
			if (failed) throw new OAuthError("storage");
		});
		try {
			await deletion;
			if (this.current(provider, epoch)) delete this.errors[provider];
		} catch {
			if (this.current(provider, epoch)) this.errors[provider] = "storage";
			throw new OAuthError("storage");
		} finally {
			if (flow) await this.release(flow);
			void this.notify(provider);
		}
	}

	async disconnect(provider: OAuthProvider): Promise<OAuthStatus> {
		assertProvider(provider);
		try {
			await this.clear(provider, true);
		} catch {
			/* view carries only the fixed storage error. */
		}
		return this.view(provider);
	}

	async clearSession(provider: OAuthProvider): Promise<void> {
		await this.clear(provider, false);
	}

	private async refresh(
		provider: OAuthProvider,
		initialSession: OAuthSession,
		epoch: number,
		signal: AbortSignal
	): Promise<OAuthSession> {
		try {
			const latest = await this.serial(provider, async () => {
				this.assertCurrent(provider, epoch);
				return this.store.get(provider);
			});
			if (!latest || latest.id !== initialSession.id) throw new OAuthError("cancelled");
			const session = latest;
			this.assertCurrent(provider, epoch);
			if (signal.aborted) throw signal.reason;
			if (session.expiresAt === null || session.expiresAt > this.now() + 60000) return session;
			if (
				!session.refreshToken ||
				(session.refreshExpiresAt !== null && session.refreshExpiresAt <= this.now())
			)
				throw new OAuthError("refresh");
			const client = validClient(
				provider,
				await abortable(this.options.getClient(provider), signal)
			);
			if (!client) throw new OAuthError("refresh");
			const tokens = await exchange({
				provider,
				client,
				fetcher: this.fetcher,
				signal,
				now: this.now(),
				grant: { session },
			});
			const account =
				provider === "slack"
					? await profile(provider, tokens.accessToken, this.fetcher, signal, tokens.slack)
					: session.account;
			const refreshed = { ...session, ...tokens, account };
			await this.commit(provider, epoch, signal, refreshed, session.id);
			this.assertCurrent(provider, epoch);
			delete this.errors[provider];
			return refreshed;
		} catch (error) {
			if (!this.current(provider, epoch)) throw new OAuthError("cancelled");
			const safe = providerError(error, "refresh");
			const code = safe.code === "storage" ? "storage" : "refresh";
			this.errors[provider] = code;
			throw new OAuthError(code);
		}
	}

	private async credential(
		provider: OAuthProvider,
		manual = true
	): Promise<{ value: string; oauth: boolean; session?: OAuthSession } | undefined> {
		assertProvider(provider);
		const epoch = this.epochs[provider];
		this.assertCurrent(provider, epoch);
		let session: OAuthSession | undefined;
		try {
			await this.pending[provider];
			session = await this.store.get(provider);
		} catch {
			throw new OAuthError("storage");
		}
		this.assertCurrent(provider, epoch);
		if (!session) {
			if (!manual) return undefined;
			let value: string | undefined;
			try {
				value = await this.options.getManualToken(provider);
			} catch {
				throw new OAuthError("storage");
			}
			this.assertCurrent(provider, epoch);
			return value ? { value, oauth: false } : undefined;
		}
		if (session.expiresAt === null || session.expiresAt > this.now() + 60000)
			return { value: session.accessToken, oauth: true, session };
		let refresh = this.refreshes.get(provider);
		if (!refresh || refresh.id !== session.id || refresh.epoch !== epoch) {
			const controller = new AbortController();
			const timer = setTimeout(
				() => controller.abort(new OAuthError("refresh")),
				Math.min(this.options.timeoutMs ?? 15000, 15000)
			);
			timer.unref?.();
			const promise = this.refresh(provider, session, epoch, controller.signal).finally(() => {
				clearTimeout(timer);
				if (this.refreshes.get(provider)?.promise === promise) this.refreshes.delete(provider);
			});
			refresh = { id: session.id, epoch, controller, promise };
			this.refreshes.set(provider, refresh);
		}
		const refreshed = await refresh.promise;
		this.assertCurrent(provider, epoch);
		return { value: refreshed.accessToken, oauth: true, session: refreshed };
	}

	/** Main-only OAuth identity. Undefined means absent OAuth, never manual-token fallback.
	 * The saved session ID identifies the connection across single-use token rotations.
	 */
	async slackCredential(): Promise<SlackCredential | undefined> {
		const epoch = this.epochs.slack;
		const credential = await this.credential("slack", false);
		this.assertCurrent("slack", epoch);
		if (!credential) return undefined;
		const session = credential.session;
		if (!session?.slack) throw new OAuthError("storage");
		try {
			const result = await this.serial("slack", async () => {
				const latest = await this.store.get("slack");
				this.assertCurrent("slack", epoch);
				if (
					latest?.id !== session.id ||
					latest.accessToken !== session.accessToken ||
					JSON.stringify(latest.slack) !== JSON.stringify(session.slack) ||
					JSON.stringify(latest.scopes) !== JSON.stringify(session.scopes)
				)
					throw new OAuthError("cancelled");
				const knownError = this.errors.slack;
				if (knownError === "storage" || knownError === "refresh" || knownError === "provider")
					throw new OAuthError(knownError);
				const parsed = SlackCredentialSchema.safeParse({
					connectionId: session.id,
					accessToken: session.accessToken,
					tokenKind: "user",
					...session.slack,
					scopes: session.scopes,
				});
				if (!parsed.success) throw new OAuthError("storage");
				return parsed.data;
			});
			this.assertCurrent("slack", epoch);
			return result;
		} catch (error) {
			this.assertCurrent("slack", epoch);
			throw providerError(error, "storage");
		}
	}

	/** Main-only: never register token/authorization as renderer RPCs. */
	async token(provider: OAuthProvider): Promise<string | undefined> {
		return (await this.credential(provider))?.value;
	}

	async authorization(provider: OAuthProvider): Promise<string | undefined> {
		const credential = await this.credential(provider);
		return credential
			? provider === "linear" && !credential.oauth
				? credential.value
				: `Bearer ${credential.value}`
			: undefined;
	}

	async hasCredentials(provider: OAuthProvider): Promise<boolean> {
		assertProvider(provider);
		try {
			await this.pending[provider];
			return (
				(await this.store.has(provider)) || Boolean(await this.options.getManualToken(provider))
			);
		} catch {
			throw new OAuthError("storage");
		}
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		for (const provider of providers) this.fence(provider);
		if (this.flow) {
			const flow = this.flow;
			flow.controller.abort(new OAuthError("cancelled"));
			await this.release(flow);
		}
		await Promise.all(Object.values(this.pending));
		await this.store.drain();
	}
}
