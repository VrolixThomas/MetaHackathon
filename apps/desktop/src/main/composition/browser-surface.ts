import { z } from "zod";
import {
	type BrowserBounds,
	type BrowserViewport,
	type LocalBrowserCommand,
	LocalBrowserCommandSchema,
	type LocalBrowserPresent,
	LocalBrowserPresentSchema,
	type LocalBrowserState,
	LocalBrowserStateSchema,
	LocalBrowserUrlSchema,
} from "../../shared/contracts";
import type { BrowserPage } from "../runtime/browser";
import { publicProcedure, router } from "../trpc";

const openSchema = z.strictObject({ url: LocalBrowserUrlSchema });
const defaultViewport = (): BrowserViewport => ({ width: 1024, height: 768 });
const failure = () => new Error("Local browser operation failed");
const historySchema = z.strictObject({ canGoBack: z.boolean(), canGoForward: z.boolean() });
class CommandUnavailable extends Error {}

// Optional native capabilities also allow adapters predating the runtime history addition.
interface HistoryPage extends BrowserPage {
	history?(): { canGoBack: boolean; canGoForward: boolean };
	back?(): Promise<void>;
	forward?(): Promise<void>;
	reload?(): Promise<void>;
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
	page: HistoryPage;
	origin: string;
	closed: boolean;
}

/** A reviewer-supplied local URL, with no PR identity, server execution or synthetic page. */
export class LocalBrowserSurface {
	private active?: OwnedPage;
	private viewport = defaultViewport();
	private bounds: BrowserBounds | null = null;
	private hideEpoch = 0;
	private tail: Promise<unknown> = Promise.resolve();
	private readonly pending = new Set<AbortController>();
	private disposed = false;
	private readonly timeoutMs: number;

	constructor(
		private readonly options: { createPage: (origin: string) => BrowserPage; timeoutMs?: number }
	) {
		this.timeoutMs = options.timeoutMs ?? 15_000;
		if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000)
			throw new Error("Invalid local browser timeout");
	}

	async open(raw: { url: string }): Promise<LocalBrowserState> {
		const { url } = input(openSchema, raw);
		return this.enqueue((signal) => this.navigate(url, signal));
	}

	state(): Promise<LocalBrowserState | null> {
		return this.enqueue(async (signal) => (this.active ? this.capture(this.active, signal) : null));
	}

	async command(raw: LocalBrowserCommand): Promise<LocalBrowserState> {
		const command = input(LocalBrowserCommandSchema, raw);
		return this.enqueue(async (signal) => {
			if (command.kind === "navigate") return this.navigate(command.url, signal);
			// History support is supplied by the native page, never synthesized in this service.
			const active = this.active;
			if (!active) throw new CommandUnavailable();
			const action = active.page[command.kind];
			if (!action) throw new CommandUnavailable();
			await this.capture(active, signal);
			this.check(active, signal);
			await action.call(active.page);
			this.check(active, signal);
			return this.capture(active, signal);
		});
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
		return this.enqueue(async (signal) => {
			if (epoch !== this.hideEpoch) return;
			const active = this.active;
			if (active) {
				if (presentation.viewport) {
					await active.page.viewport(presentation.viewport);
					this.check(active, signal);
					this.viewport = presentation.viewport;
				}
				if (epoch !== this.hideEpoch) return;
				active.page.present(presentation.bounds);
			}
			signal.throwIfAborted();
			this.bounds = presentation.bounds;
			if (presentation.viewport) this.viewport = presentation.viewport;
		});
	}

	async close(): Promise<void> {
		// Do not queue teardown behind page APIs that may never settle.
		const active = this.active;
		this.active = undefined;
		this.hideEpoch++;
		for (const controller of this.pending) controller.abort();
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

	private enqueue<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
		if (this.disposed) return Promise.reject(new Error("Local browser has shut down"));
		if (this.pending.size >= 32) return Promise.reject(new Error("Local browser queue is full"));
		const controller = new AbortController();
		this.pending.add(controller);
		let running = false;
		let rejectAbort: () => void = () => {};
		const interrupted = new Promise<never>((_resolve, reject) => {
			rejectAbort = () => reject(new Error("Local browser operation cancelled"));
		});
		const abort = () => {
			if (running && this.active) {
				try {
					this.destroy(this.active);
				} catch {
					/* Adapter cleanup must not delay cancellation. */
				}
			}
			rejectAbort();
		};
		controller.signal.addEventListener("abort", abort, { once: true });
		// The deadline includes queue time, so polling cannot build an unbounded backlog.
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		const execution = this.tail
			.catch(() => {})
			.then(async () => {
				controller.signal.throwIfAborted();
				running = true;
				try {
					const result = await work(controller.signal);
					controller.signal.throwIfAborted();
					return result;
				} catch (error) {
					if (!(error instanceof CommandUnavailable) && !controller.signal.aborted && this.active)
						this.destroy(this.active);
					throw failure();
				}
			});
		const done = Promise.race([execution, interrupted])
			.catch(() => {
				throw failure();
			})
			.finally(() => {
				clearTimeout(timer);
				controller.signal.removeEventListener("abort", abort);
				this.pending.delete(controller);
			});
		this.tail = done.catch(() => {});
		return done;
	}

	private async navigate(raw: string, signal: AbortSignal): Promise<LocalBrowserState> {
		const url = new URL(input(LocalBrowserUrlSchema, raw));
		signal.throwIfAborted();
		let active = this.active;
		if (!active || active.origin !== url.origin) {
			if (active) this.destroy(active);
			active = { page: this.options.createPage(url.origin), origin: url.origin, closed: false };
			this.active = active;
			await active.page.viewport(this.viewport);
			this.check(active, signal);
			active.page.present(this.bounds);
		}
		await active.page.loadURL(url.href);
		this.check(active, signal);
		return this.capture(active, signal);
	}

	private async capture(active: OwnedPage, signal: AbortSignal): Promise<LocalBrowserState> {
		const snapshot = await active.page.snapshot();
		this.check(active, signal);
		const url = input(LocalBrowserUrlSchema, snapshot.url);
		if (new URL(url).origin !== active.origin) throw failure();
		const history = historySchema.parse(
			active.page.history?.() ?? { canGoBack: false, canGoForward: false }
		);
		return LocalBrowserStateSchema.parse({
			url,
			title: snapshot.title,
			viewport: this.viewport,
			canGoBack: Boolean(active.page.back) && history.canGoBack,
			canGoForward: Boolean(active.page.forward) && history.canGoForward,
			provenance: "local-preview-unverified-revision",
		});
	}

	private check(active: OwnedPage, signal: AbortSignal): void {
		signal.throwIfAborted();
		if (active.closed || this.active !== active || this.disposed) throw failure();
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
