import { randomUUID } from "node:crypto";
import {
	type BrowserBounds,
	type BrowserCommand,
	BrowserCommandSchema,
	BrowserObserveInputSchema,
	type BrowserPresentInput,
	BrowserPresentInputSchema,
	type BrowserState,
	BrowserStateSchema,
	type BrowserViewport,
} from "../../shared/contracts";
import { allowedBrowserURL, browserURL, previewOrigin } from "./browser-policy";

export type BrowserSnapshot = Pick<BrowserState, "url" | "title" | "text" | "elements" | "scroll">;
export interface BrowserPage {
	loadURL(url: string): Promise<void>;
	snapshot(): Promise<BrowserSnapshot>;
	act(command: BrowserCommand, expected: BrowserSnapshot): Promise<void>;
	viewport(viewport: BrowserViewport): Promise<void>;
	present(bounds: BrowserBounds | null): void;
	close(): void;
}
export interface BrowserPreviewLease {
	prId: string;
	repository: string;
	revision: "base" | "head";
	commitSha: string;
	url: string;
	close(): Promise<void>;
}
export interface BrowserServiceOptions {
	openPreview(
		command: Extract<BrowserCommand, { kind: "open" }>,
		signal: AbortSignal
	): Promise<BrowserPreviewLease>;
	createPage(origin: string): BrowserPage;
	timeoutMs?: number;
}
interface ActiveBrowser {
	id: string;
	lease: BrowserPreviewLease;
	page: BrowserPage;
	viewport: BrowserViewport;
	state?: BrowserState;
	fingerprint?: string;
	closed: boolean;
	closing?: Promise<void>;
}

/** One owned, persistent page per conversation; all commands target the displayed page. */
export class BrowserService {
	private readonly sessions = new Map<string, ActiveBrowser>();
	private readonly queues = new Map<string, Promise<unknown>>();
	private readonly controllers = new Map<string, Set<AbortController>>();
	private readonly requests = new Map<string, Set<string>>();
	private readonly bounds = new Map<string, BrowserBounds | null>();
	private readonly closing = new Set<Promise<void>>();
	private readonly retiring = new Map<string, Set<Promise<void>>>();
	private closed = false;
	private presentedSession?: string;
	private disposal?: Promise<void>;
	constructor(private readonly options: BrowserServiceOptions) {}

	execute(input: BrowserCommand, signal?: AbortSignal): Promise<BrowserState> {
		const command = BrowserCommandSchema.parse(input);
		const seen = this.requests.get(command.sessionId) ?? new Set<string>();
		if (seen.has(command.requestId))
			return Promise.reject(new Error("Browser request already submitted"));
		if (seen.size >= 4096)
			return Promise.reject(new Error("Browser session request limit reached"));
		seen.add(command.requestId);
		this.requests.set(command.sessionId, seen);
		return this.enqueue(command.sessionId, signal, async (localSignal) => {
			if (command.kind === "open") return this.open(command, localSignal);
			const active = this.sessions.get(command.sessionId);
			if (!active || active.id !== command.browserId || active.closed)
				throw new Error("Stale browser session");
			return this.guarded(command.sessionId, active, localSignal, async () => {
				const before = await this.capture(command.sessionId, active);
				localSignal.throwIfAborted();
				if (
					"observationSequence" in command &&
					command.observationSequence !== undefined &&
					command.observationSequence !== before.sequence
				)
					throw new Error("Stale browser observation; observe again");
				if (command.kind === "navigate")
					await active.page.loadURL(browserURL(command.url, active.lease.url));
				else if (command.kind === "viewport") {
					await active.page.viewport(command.viewport);
					active.viewport = command.viewport;
				} else {
					const { url, title, text, elements, scroll } = before;
					await active.page.act(command, { url, title, text, elements, scroll });
				}
				localSignal.throwIfAborted();
				return this.capture(command.sessionId, active);
			});
		});
	}

	observe(sessionId: string, signal?: AbortSignal): Promise<BrowserState | null> {
		BrowserObserveInputSchema.parse({ sessionId });
		return this.enqueue(sessionId, signal, async (localSignal) => {
			const active = this.sessions.get(sessionId);
			if (!active || active.closed) return null;
			return this.guarded(sessionId, active, localSignal, () => this.capture(sessionId, active));
		});
	}

	present(input: BrowserPresentInput): void {
		const { sessionId, bounds } = BrowserPresentInputSchema.parse(input);
		if (this.closed) throw new Error("Browser service has shut down");
		this.bounds.set(sessionId, bounds);
		if (bounds) this.presentedSession = sessionId;
		// The main window has one browser surface even if a retired conversation still exists.
		if (bounds)
			for (const [id, active] of this.sessions) if (id !== sessionId) active.page.present(null);
		this.sessions.get(sessionId)?.page.present(bounds);
	}

	async close(sessionId: string): Promise<void> {
		const active = this.sessions.get(sessionId);
		for (const controller of this.controllers.get(sessionId) ?? []) controller.abort();
		if (active) await this.destroy(sessionId, active);
		await this.queues.get(sessionId)?.catch(() => undefined);
		await Promise.all([...(this.retiring.get(sessionId) ?? [])]);
		this.bounds.delete(sessionId);
		// Retain request tombstones: a late repeated mutation must never reopen a retired page.
	}

	dispose(): Promise<void> {
		this.disposal ??= (async () => {
			this.closed = true;
			for (const set of this.controllers.values()) for (const controller of set) controller.abort();
			await Promise.allSettled([...this.queues.values()]);
			await Promise.all([...this.sessions].map(([id, active]) => this.destroy(id, active)));
			await Promise.all([...this.closing]);
			this.bounds.clear();
			this.requests.clear();
		})();
		return this.disposal;
	}

	private enqueue<T>(
		sessionId: string,
		signal: AbortSignal | undefined,
		work: (signal: AbortSignal) => Promise<T>
	): Promise<T> {
		if (this.closed) return Promise.reject(new Error("Browser service has shut down"));
		if (signal?.aborted)
			return Promise.reject(signal.reason ?? new Error("Browser action cancelled"));
		const controller = new AbortController();
		const localSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
		const set = this.controllers.get(sessionId) ?? new Set<AbortController>();
		set.add(controller);
		this.controllers.set(sessionId, set);
		const prior = this.queues.get(sessionId) ?? Promise.resolve();
		const done = prior
			.catch(() => undefined)
			.then(async () => {
				localSignal.throwIfAborted();
				if (this.closed) throw new Error("Browser service has shut down");
				return work(localSignal);
			})
			.finally(() => {
				set.delete(controller);
				if (!set.size) this.controllers.delete(sessionId);
				if (this.queues.get(sessionId) === done) this.queues.delete(sessionId);
			});
		this.queues.set(sessionId, done);
		return done;
	}

	private async open(command: Extract<BrowserCommand, { kind: "open" }>, signal: AbortSignal) {
		const existing = this.sessions.get(command.sessionId);
		if (
			existing &&
			existing.lease.prId === command.prId &&
			existing.lease.revision === command.revision
		) {
			return this.guarded(command.sessionId, existing, signal, async () => {
				if (command.path) await existing.page.loadURL(browserURL(command.path, existing.lease.url));
				return this.capture(command.sessionId, existing);
			});
		}
		if (existing) await this.destroy(command.sessionId, existing);
		if (this.sessions.size >= 8) throw new Error("Too many browser sessions");
		signal.throwIfAborted();
		const lease = await this.options.openPreview(command, signal);
		let active: ActiveBrowser | undefined;
		try {
			signal.throwIfAborted();
			if (lease.prId !== command.prId || lease.revision !== command.revision)
				throw new Error("Preview identity mismatch");
			const origin = previewOrigin(lease.url);
			active = {
				id: randomUUID(),
				lease,
				page: this.options.createPage(origin),
				viewport: existing?.viewport ?? { width: 1024, height: 768 },
				closed: false,
			};
			this.sessions.set(command.sessionId, active);
			const page = active;
			return await this.guarded(command.sessionId, page, signal, async () => {
				await page.page.viewport(page.viewport);
				page.page.present(
					this.presentedSession === command.sessionId
						? (this.bounds.get(command.sessionId) ?? null)
						: null
				);
				await page.page.loadURL(browserURL(command.path ?? lease.url, lease.url));
				return this.capture(command.sessionId, page);
			});
		} catch (error) {
			if (active) await this.destroy(command.sessionId, active);
			else await lease.close();
			throw error;
		}
	}

	private async capture(sessionId: string, active: ActiveBrowser): Promise<BrowserState> {
		const snapshot = await active.page.snapshot();
		if (active.closed || this.sessions.get(sessionId) !== active)
			throw new Error("Browser session closed");
		if (!allowedBrowserURL(snapshot.url, previewOrigin(active.lease.url))) {
			await this.destroy(sessionId, active);
			throw new Error("Browser left its active preview origin");
		}
		const fingerprint = JSON.stringify({ ...snapshot, viewport: active.viewport });
		const state = BrowserStateSchema.parse({
			...snapshot,
			browserId: active.id,
			sessionId,
			prId: active.lease.prId,
			repository: active.lease.repository,
			revision: active.lease.revision,
			commitSha: active.lease.commitSha,
			viewport: active.viewport,
			sequence: (active.state?.sequence ?? 0) + (active.fingerprint === fingerprint ? 0 : 1),
			observedAt: new Date().toISOString(),
			provenance: "live-browser",
		});
		active.state = state;
		active.fingerprint = fingerprint;
		return state;
	}

	private async guarded<T>(
		sessionId: string,
		active: ActiveBrowser,
		signal: AbortSignal,
		work: () => Promise<T>
	): Promise<T> {
		signal.throwIfAborted();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let rejectAbort: (reason: Error) => void = () => {};
		const abort = () => {
			void this.destroy(sessionId, active).catch(() => undefined);
			rejectAbort(new Error("Browser action cancelled"));
		};
		const cancelled = new Promise<never>((_resolve, reject) => {
			rejectAbort = reject;
		});
		signal.addEventListener("abort", abort, { once: true });
		timer = setTimeout(abort, this.options.timeoutMs ?? 15_000);
		try {
			const result = await Promise.race([work(), cancelled]);
			signal.throwIfAborted();
			if (active.closed) throw new Error("Browser session closed");
			return result;
		} finally {
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
		}
	}

	private destroy(sessionId: string, active: ActiveBrowser): Promise<void> {
		if (active.closed) return active.closing ?? Promise.resolve();
		active.closed = true;
		if (this.sessions.get(sessionId) === active) this.sessions.delete(sessionId);
		// Closing the page is synchronous, so no queued JS can run after cancellation returns.
		let pageError: unknown;
		try {
			active.page.close();
		} catch (error) {
			pageError = error;
		}
		const closing = active.lease
			.close()
			.then(() => {
				if (pageError) throw pageError;
			})
			.finally(() => {
				this.closing.delete(closing);
				const pending = this.retiring.get(sessionId);
				pending?.delete(closing);
				if (!pending?.size) this.retiring.delete(sessionId);
			});
		active.closing = closing;
		this.closing.add(closing);
		const pending = this.retiring.get(sessionId) ?? new Set<Promise<void>>();
		pending.add(closing);
		this.retiring.set(sessionId, pending);
		return closing;
	}
}
