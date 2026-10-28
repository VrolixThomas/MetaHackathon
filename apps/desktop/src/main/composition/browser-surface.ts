import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
	type BrowserBounds,
	BrowserCommandSchema,
	type BrowserViewport,
	BrowserViewportSchema,
	IdSchema,
	type LocalBrowserCommand,
	LocalBrowserCommandSchema,
	type LocalBrowserPresent,
	LocalBrowserPresentSchema,
	type LocalBrowserState,
	LocalBrowserStateSchema,
	LocalBrowserUrlSchema,
	type WorkspaceBrowserCommand,
	WorkspaceBrowserCommandSchema,
	type WorkspaceBrowserObservation,
	WorkspaceBrowserObservationSchema,
	WorkspaceUrlSchema,
} from "../../shared/contracts";
import type { BrowserPage, BrowserSnapshot } from "../runtime/browser";
import { publicProcedure, router } from "../trpc";

const openSchema = z.strictObject({ url: LocalBrowserUrlSchema });
const defaultViewport = (): BrowserViewport => ({ width: 1024, height: 768 });
const failure = () => new Error("Local browser operation failed");
const historySchema = z.strictObject({ canGoBack: z.boolean(), canGoForward: z.boolean() });
export type BrowserOperationCode =
	| "UNSUPPORTED"
	| "BROWSER_UNAVAILABLE"
	| "BROWSER_MISMATCH"
	| "STALE_OBSERVATION"
	| "INVALID_ELEMENT"
	| "BROWSER_NOT_PRESENTED"
	| "INVALID_COMMAND"
	| "CANCELLED";

/** Recoverable failures carry only a fixed code, never page content or adapter errors. */
export class BrowserOperationError extends Error {
	readonly recoverable = true;
	constructor(readonly code: BrowserOperationCode) {
		super(`Browser operation: ${code}`);
		this.name = "BrowserOperationError";
	}
}
class CommandUnavailable extends BrowserOperationError {
	constructor() {
		super("UNSUPPORTED");
	}
}
const presentationSchema = z.strictObject({
	visible: z.boolean(),
	bounds: LocalBrowserPresentSchema.shape.bounds,
});
const identitySchema = z.strictObject({ sessionId: IdSchema, requestId: IdSchema });
type WorkspaceSnapshot = BrowserSnapshot & {
	documentId?: string;
	truncated?: boolean;
	viewport?: BrowserViewport;
};

// Optional native capabilities also allow adapters predating the runtime history addition.
interface HistoryPage extends BrowserPage {
	history?(): { canGoBack: boolean; canGoForward: boolean };
	back?(): Promise<void>;
	forward?(): Promise<void>;
	reload?(): Promise<void>;
	presentation?(): { visible: boolean; bounds: BrowserBounds | null };
}

/** Use shared validation without reflecting arbitrary URLs or adapter errors to the renderer. */
function requestSchema<T>(schema: z.ZodType<T>) {
	return z.unknown().transform((raw, context): T => {
		try {
			const parsed = schema.safeParse(raw);
			if (parsed.success) return parsed.data;
		} catch {
			/* URL refinements may throw; do not return their raw input. */
		}
		context.addIssue({ code: "custom", message: "Invalid local browser request" });
		return z.NEVER;
	});
}
function input<T>(schema: z.ZodType<T>, raw: unknown): T {
	try {
		const parsed = schema.safeParse(raw);
		if (parsed.success) return parsed.data;
	} catch {
		/* Keep validation failures independent of caller-provided text. */
	}
	throw new Error("Invalid local browser request");
}

interface OwnedPage {
	id: string;
	fingerprint?: string;
	sequence: number;
	page: HistoryPage;
	viewport: BrowserViewport;
	origin: string;
	closed: boolean;
}

interface Operation {
	signal: AbortSignal;
	page?: OwnedPage;
}

/** One native page, with no PR identity, server execution or synthetic observation. */
export class LocalBrowserSurface {
	private active?: OwnedPage;
	private viewport = defaultViewport();
	private bounds: BrowserBounds | null = null;
	private hideEpoch = 0;
	private tail: Promise<unknown> = Promise.resolve();
	private readonly pending = new Set<{ cancel(retire: boolean): void }>();
	private disposed = false;
	private readonly timeoutMs: number;

	constructor(
		private readonly options: {
			createPage: (origin: string) => BrowserPage;
			timeoutMs?: number;
			allowWebNavigation?: boolean;
		}
	) {
		this.timeoutMs = options.timeoutMs ?? 15_000;
		if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000)
			throw new Error("Invalid local browser timeout");
	}

	async open(raw: { url: string }, signal?: AbortSignal): Promise<LocalBrowserState> {
		const { url } = input(openSchema, raw);
		this.allowedURL(url);
		return this.enqueue((operation) => this.navigate(url, operation), signal);
	}

	state(): Promise<LocalBrowserState | null> {
		return this.enqueue(async (operation) =>
			this.active ? this.capture(this.active, operation) : null
		);
	}

	async command(raw: LocalBrowserCommand, signal?: AbortSignal): Promise<LocalBrowserState> {
		const command = input(LocalBrowserCommandSchema, raw);
		if (command.kind === "navigate") this.allowedURL(command.url);
		return this.enqueue(async (operation) => {
			if (command.kind === "navigate") return this.navigate(command.url, operation);
			// History support is supplied by the native page, never synthesized here.
			const active = this.active;
			if (!active) throw new CommandUnavailable();
			const action = active.page[command.kind];
			if (!action) throw new CommandUnavailable();
			await this.capture(active, operation);
			this.check(active, operation);
			await action.call(active.page);
			this.check(active, operation);
			return this.capture(active, operation);
		}, signal);
	}

	observe(signal?: AbortSignal): Promise<WorkspaceBrowserObservation | null> {
		return this.enqueue(
			async (operation) =>
				this.active ? (await this.observePage(this.active, operation)).observation : null,
			signal
		);
	}

	async executeBrowser(
		raw: WorkspaceBrowserCommand,
		signal?: AbortSignal,
		identity?: { sessionId: string; requestId: string }
	): Promise<WorkspaceBrowserObservation> {
		const command = input(WorkspaceBrowserCommandSchema, raw);
		const actor = identity ? input(identitySchema, identity) : undefined;
		return this.enqueue(async (operation) => {
			const active = this.active;
			if (!active) throw new BrowserOperationError("BROWSER_UNAVAILABLE");
			// The action and its freshness checks use this exact, single native snapshot.
			const { observation: before, snapshot } = await this.observePage(active, operation);
			if ("browserId" in command && command.browserId !== before.browserId)
				throw new BrowserOperationError("BROWSER_MISMATCH");
			if ("observationSequence" in command && command.observationSequence !== before.sequence)
				throw new BrowserOperationError("STALE_OBSERVATION");
			this.requirePresented(active);
			if ("elementId" in command && command.elementId) {
				const element = before.elements.find((item) => item.id === command.elementId);
				if (!element || (command.kind !== "scroll" && (!element.visible || !element.enabled)))
					throw new BrowserOperationError("INVALID_ELEMENT");
			}
			this.check(active, operation);
			if (command.kind === "viewport") {
				await this.resize(active, command.viewport, operation);
			} else if (
				command.kind === "back" ||
				command.kind === "forward" ||
				command.kind === "reload"
			) {
				const action = active.page[command.kind];
				if (!action) throw new CommandUnavailable();
				await action.call(active.page);
			} else {
				const parsed = BrowserCommandSchema.safeParse({
					...command,
					browserId: active.id,
					...(actor ?? { sessionId: active.id, requestId: randomUUID() }),
				});
				if (!parsed.success) throw new BrowserOperationError("INVALID_COMMAND");
				try {
					await active.page.act(parsed.data, snapshot);
				} catch (error) {
					// DOM guards are expected races between observation and page interaction.
					if (error instanceof Error) {
						if (
							/Browser observation changed before action|Stale browser element/.test(error.message)
						)
							throw new BrowserOperationError("STALE_OBSERVATION");
						if (
							/Browser element is (?:disabled|obscured|not an editable text field)|Scroll browser element into view first/.test(
								error.message
							)
						)
							throw new BrowserOperationError("INVALID_ELEMENT");
					}
					throw error;
				}
			}
			this.check(active, operation);
			return (await this.observePage(active, operation)).observation;
		}, signal);
	}

	async present(raw: LocalBrowserPresent): Promise<void> {
		const presentation = input(LocalBrowserPresentSchema, raw);
		if (this.disposed) throw new Error("Local browser has shut down");
		if (presentation.bounds === null) {
			// Native child views sit above renderer dialogs. Hide cannot wait for page I/O.
			this.hideEpoch++;
			this.bounds = null;
			try {
				this.active?.page.present(null);
			} catch {
				throw failure();
			}
			if (!presentation.viewport) return;
		}
		const epoch = this.hideEpoch;
		return this.enqueue(async (operation) => {
			if (epoch !== this.hideEpoch) return;
			const active = this.active;
			if (active) {
				this.admit(active, operation);
				if (presentation.viewport) {
					await this.resize(active, presentation.viewport, operation);
				}
				if (epoch !== this.hideEpoch) return;
				active.page.present(presentation.bounds);
			}
			operation.signal.throwIfAborted();
			this.bounds = presentation.bounds;
			if (presentation.viewport) this.viewport = presentation.viewport;
		});
	}

	async close(): Promise<void> {
		// Do not queue teardown behind page APIs that may never settle.
		const active = this.active;
		this.active = undefined;
		this.hideEpoch++;
		for (const operation of this.pending) operation.cancel(true);
		this.pending.clear();
		this.tail = Promise.resolve();
		this.bounds = null;
		this.viewport = defaultViewport();
		try {
			if (active) this.destroy(active);
		} catch {
			throw failure();
		}
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		await this.close();
	}

	private enqueue<T>(work: (operation: Operation) => Promise<T>, caller?: AbortSignal): Promise<T> {
		if (this.disposed) return Promise.reject(new Error("Local browser has shut down"));
		if (caller?.aborted) return Promise.reject(new BrowserOperationError("CANCELLED"));
		if (this.pending.size >= 32) return Promise.reject(new Error("Local browser queue is full"));
		const controller = new AbortController();
		const operation: Operation = { signal: controller.signal };
		let finished = false;
		let rejectAbort: (error: Error) => void = () => {};
		let release: () => void = () => {};
		const interrupted = new Promise<never>((_resolve, reject) => {
			rejectAbort = reject;
		});
		const retired = new Promise<void>((resolve) => {
			release = resolve;
		});
		const pending = {
			cancel: (retire: boolean) => {
				if (finished) return;
				controller.abort();
				if (retire) {
					// Capture the admitted page, never whichever page happens to be active later.
					try {
						if (operation.page) this.destroy(operation.page);
					} catch {
						/* Cleanup cannot delay cancellation. */
					}
					release();
				}
				rejectAbort(new BrowserOperationError("CANCELLED"));
			},
		};
		this.pending.add(pending);
		const abort = () => pending.cancel(false);
		caller?.addEventListener("abort", abort, { once: true });
		// A user cancellation rejects promptly, but admitted I/O still owns its queue slot.
		// Its original deadline can retire a hung page before allowing the next operation.
		const timer = setTimeout(() => pending.cancel(true), this.timeoutMs);
		const execution = this.tail
			.catch(() => {})
			.then(async () => {
				try {
					operation.signal.throwIfAborted();
					const result = await work(operation);
					operation.signal.throwIfAborted();
					return result;
				} catch (error) {
					if (operation.signal.aborted) throw new BrowserOperationError("CANCELLED");
					if (error instanceof BrowserOperationError) throw error;
					try {
						if (operation.page) this.destroy(operation.page);
					} catch {
						/* Do not expose adapter cleanup errors. */
					}
					throw failure();
				}
			});
		this.tail = Promise.race([execution, retired])
			.catch(() => {})
			.finally(() => {
				finished = true;
				clearTimeout(timer);
				caller?.removeEventListener("abort", abort);
				this.pending.delete(pending);
			});
		return Promise.race([execution, interrupted]);
	}

	private allowedURL(raw: string): URL {
		const url = new URL(input(WorkspaceUrlSchema, raw));
		if (!this.options.allowWebNavigation && url.protocol !== "http:")
			throw new Error("Invalid local browser request");
		return url;
	}

	private async navigate(raw: string, operation: Operation): Promise<LocalBrowserState> {
		const url = this.allowedURL(raw);
		operation.signal.throwIfAborted();
		let active = this.active;
		if (!active || (!this.options.allowWebNavigation && active.origin !== url.origin)) {
			if (active) this.destroy(active);
			active = {
				id: randomUUID(),
				page: this.options.createPage(url.origin),
				viewport: this.viewport,
				origin: url.origin,
				closed: false,
				sequence: 0,
			};
			this.active = active;
			this.admit(active, operation);
			await this.resize(active, this.viewport, operation);
			active.page.present(this.bounds);
		}
		this.admit(active, operation);
		await active.page.loadURL(url.href);
		this.check(active, operation);
		return this.capture(active, operation);
	}

	private observedURL(active: OwnedPage, snapshot: BrowserSnapshot): string {
		const url = this.allowedURL(snapshot.url);
		if (!this.options.allowWebNavigation && url.origin !== active.origin) throw failure();
		return url.href;
	}

	private async capture(active: OwnedPage, operation: Operation): Promise<LocalBrowserState> {
		this.admit(active, operation);
		const snapshot = await active.page.snapshot();
		this.check(active, operation);
		const url = this.observedURL(active, snapshot);
		const history = historySchema.parse(
			active.page.history?.() ?? { canGoBack: false, canGoForward: false }
		);
		return LocalBrowserStateSchema.parse({
			url,
			title: snapshot.title,
			viewport: (snapshot as WorkspaceSnapshot).viewport ?? active.viewport,
			canGoBack: Boolean(active.page.back) && history.canGoBack,
			canGoForward: Boolean(active.page.forward) && history.canGoForward,
			provenance:
				new URL(url).protocol === "https:"
					? "website-unverified-revision"
					: "local-preview-unverified-revision",
		});
	}

	private nativePresentation(active: OwnedPage) {
		if (!active.page.presentation) throw new CommandUnavailable();
		return presentationSchema.parse(active.page.presentation());
	}

	private async resize(active: OwnedPage, viewport: BrowserViewport, operation: Operation) {
		this.admit(active, operation);
		await active.page.viewport(viewport);
		// An admitted resize can finish after turn cancellation. Retain its acknowledged
		// native size for the next observation, without publishing the cancelled result.
		if (!active.closed && this.active === active && !this.disposed) active.viewport = viewport;
		this.check(active, operation);
		this.viewport = viewport;
	}

	private requirePresented(active: OwnedPage): void {
		if (!this.nativePresentation(active).visible)
			throw new BrowserOperationError("BROWSER_NOT_PRESENTED");
	}

	private async observePage(active: OwnedPage, operation: Operation) {
		this.admit(active, operation);
		const snapshot: WorkspaceSnapshot = await active.page.snapshot();
		this.check(active, operation);
		if (!snapshot.documentId || !IdSchema.safeParse(snapshot.documentId).success)
			throw new CommandUnavailable();
		const url = this.observedURL(active, snapshot);
		const viewport = BrowserViewportSchema.parse(snapshot.viewport ?? active.viewport);
		const presentation = this.nativePresentation(active);
		// Include raw values before clipping, as well as document identity on identical reloads.
		// Presentation/bounds and observation timestamps never invalidate DOM references.
		const fingerprint = JSON.stringify({
			documentId: snapshot.documentId,
			url: snapshot.url,
			title: snapshot.title,
			text: snapshot.text,
			elements: snapshot.elements.map((element) => ({
				id: element.id,
				role: element.role,
				name: element.name,
				tag: element.tag,
				value: element.value,
				bounds: {
					x: element.bounds.x,
					y: element.bounds.y,
					width: element.bounds.width,
					height: element.bounds.height,
				},
				visible: element.visible,
				enabled: element.enabled,
			})),
			scroll: { x: snapshot.scroll.x, y: snapshot.scroll.y },
			viewport: { width: viewport.width, height: viewport.height },
		});
		const sequence =
			active.fingerprint === undefined || active.fingerprint === fingerprint
				? active.sequence
				: active.sequence + 1;
		if (new Set(snapshot.elements.map((element) => element.id)).size !== snapshot.elements.length)
			throw failure();
		const observation = WorkspaceBrowserObservationSchema.parse({
			browserId: active.id,
			documentId: snapshot.documentId,
			sequence,
			observedAt: new Date().toISOString(),
			url,
			title: snapshot.title.slice(0, 500),
			viewport,
			text: snapshot.text.slice(0, 16000),
			elements: snapshot.elements.slice(0, 150).map(({ location: _location, ...element }) => ({
				...element,
				role: element.role.slice(0, 100),
				name: element.name.slice(0, 500),
				tag: element.tag.slice(0, 50),
				...(element.value === undefined ? {} : { value: element.value.slice(0, 2000) }),
			})),
			scroll: snapshot.scroll,
			presented: presentation.visible,
			truncated:
				Boolean(snapshot.truncated) ||
				snapshot.text.length > 16000 ||
				snapshot.elements.length > 150,
			provenance: "website-unverified-revision",
		});
		this.check(active, operation);
		active.fingerprint = fingerprint;
		active.sequence = sequence;
		return { observation, snapshot };
	}

	private check(active: OwnedPage, operation: Operation): void {
		operation.signal.throwIfAborted();
		if (active.closed || this.active !== active || this.disposed) throw failure();
	}
	private admit(active: OwnedPage, operation: Operation): void {
		this.check(active, operation);
		operation.page = active;
	}

	private destroy(active: OwnedPage): void {
		if (active.closed) return;
		active.closed = true;
		if (this.active === active) this.active = undefined;
		active.page.close();
	}
}

/** Parent registers this under localBrowser and owns the surface's native page/lifecycle. */
export function createLocalBrowserRouter(getSurface: () => LocalBrowserSurface) {
	const invoke = async <T>(call: (surface: LocalBrowserSurface) => Promise<T>): Promise<T> => {
		try {
			return await call(getSurface());
		} catch {
			throw failure();
		}
	};
	return router({
		open: publicProcedure
			.input(requestSchema(openSchema))
			.output(LocalBrowserStateSchema)
			.mutation(({ input }) => invoke((surface) => surface.open(input))),
		state: publicProcedure
			.input(z.void())
			.output(LocalBrowserStateSchema.nullable())
			.query(() => invoke((surface) => surface.state())),
		command: publicProcedure
			.input(requestSchema(LocalBrowserCommandSchema))
			.output(LocalBrowserStateSchema)
			.mutation(({ input }) => invoke((surface) => surface.command(input))),
		present: publicProcedure
			.input(requestSchema(LocalBrowserPresentSchema))
			.output(z.void())
			.mutation(({ input }) => invoke((surface) => surface.present(input))),
		close: publicProcedure
			.input(z.void())
			.output(z.void())
			.mutation(() => invoke((surface) => surface.close())),
	});
}
