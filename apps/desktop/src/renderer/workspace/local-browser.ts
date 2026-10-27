import { createStore } from "zustand/vanilla";
import {
	type BrowserBounds,
	type BrowserViewport,
	type LocalBrowserCommand,
	LocalBrowserCommandSchema,
	LocalBrowserPresentSchema,
	type LocalBrowserState,
	LocalBrowserStateSchema,
	LocalBrowserUrlSchema,
} from "../../shared/contracts";
import type { ConversationApi } from "../conversation/api";

/** Only root can create/navigate the native view; no URL is opened by renderer startup. */
export function createLocalBrowserController(call: ConversationApi["call"]) {
	const store = createStore<{ page: LocalBrowserState | null; busy: boolean; error: string }>(
		() => ({ page: null, busy: false, error: "" })
	);
	let disposed = false;
	let epoch = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let mutations: Promise<unknown> = Promise.resolve();
	let latestBounds: BrowserBounds | null = null;
	let presentations = Promise.resolve();
	let lastPresentation: string | undefined;
	let presentationEpoch = 0;
	async function sendPresentation(input: {
		bounds: BrowserBounds | null;
		viewport?: BrowserViewport;
	}) {
		const key = JSON.stringify(input);
		if (key === lastPresentation) return;
		const current = ++presentationEpoch;
		// A pending show may already be visible, even if the last settled call hid it.
		lastPresentation = undefined;
		await call("mutation", "localBrowser.present", input);
		if (current === presentationEpoch) lastPresentation = key;
	}
	function queuePresentation(viewport?: BrowserViewport) {
		const next = presentations
			.catch(() => {})
			.then(async () => {
				// Read at dispatch so a queued resize cannot restore bounds from before a modal/drag.
				const input = LocalBrowserPresentSchema.parse({
					bounds: latestBounds,
					...(viewport ? { viewport } : {}),
				});
				await sendPresentation(input);
			});
		presentations = next;
		return next;
	}
	function present(bounds: BrowserBounds | null) {
		latestBounds = LocalBrowserPresentSchema.parse({ bounds }).bounds;
		// Native views sit above dialogs. A hide must reach main even while a show RPC is stalled.
		if (latestBounds === null) return sendPresentation({ bounds: null });
		return queuePresentation();
	}
	function schedule() {
		clearTimeout(timer);
		if (!disposed && store.getState().page) timer = setTimeout(() => void poll(), 1000);
	}
	async function poll() {
		if (disposed || store.getState().busy) return;
		const current = epoch;
		try {
			const page = LocalBrowserStateSchema.nullable().parse(
				await call("query", "localBrowser.state")
			);
			if (!disposed && current === epoch) store.setState({ page });
		} catch {
			if (!disposed && current === epoch)
				store.setState({ error: "Local preview is unavailable. Try opening it again." });
		} finally {
			schedule();
		}
	}
	async function change(work: () => Promise<LocalBrowserState | null>) {
		if (disposed) return;
		const current = ++epoch;
		clearTimeout(timer);
		store.setState({ busy: true, error: "" });
		const operation = mutations.catch(() => {}).then(work);
		mutations = operation;
		try {
			const page = await operation;
			if (!disposed && current === epoch) store.setState({ page });
		} catch {
			if (!disposed && current === epoch)
				store.setState({
					error: "Could not open the local page. Check that its server is running.",
				});
		} finally {
			if (!disposed && current === epoch) {
				store.setState({ busy: false });
				schedule();
			}
		}
	}
	return {
		store,
		present,
		start: () => {
			void poll();
		},
		open: (url: string) => {
			const parsed = LocalBrowserUrlSchema.safeParse(url.trim());
			if (!parsed.success) {
				store.setState({ error: "Enter a running localhost HTTP address without credentials." });
				return Promise.resolve();
			}
			return change(async () =>
				LocalBrowserStateSchema.parse(
					await call("mutation", "localBrowser.open", { url: parsed.data })
				)
			);
		},
		setViewport: (mode: "desktop" | "phone", bounds?: BrowserBounds | null) => {
			if (!store.getState().page || store.getState().busy) return Promise.resolve();
			if (bounds !== undefined) latestBounds = LocalBrowserPresentSchema.parse({ bounds }).bounds;
			const viewport =
				mode === "phone" ? { width: 390, height: 844 } : { width: 1024, height: 768 };
			return change(async () => {
				await queuePresentation(viewport);
				return LocalBrowserStateSchema.parse(await call("query", "localBrowser.state"));
			});
		},
		command: (input: LocalBrowserCommand) => {
			const parsed = LocalBrowserCommandSchema.safeParse(
				input.kind === "navigate" ? { ...input, url: input.url.trim() } : input
			);
			if (!parsed.success) {
				store.setState({ error: "Enter a running localhost HTTP address without credentials." });
				return Promise.resolve();
			}
			if (!store.getState().page || store.getState().busy) return Promise.resolve();
			return change(async () =>
				LocalBrowserStateSchema.parse(await call("mutation", "localBrowser.command", parsed.data))
			);
		},
		close: () => {
			store.setState({ page: null });
			void present(null).catch(() => {});
			return change(async () => {
				await call("mutation", "localBrowser.close");
				return null;
			});
		},
		dispose: () => {
			if (disposed) return;
			disposed = true;
			epoch++;
			clearTimeout(timer);
			void present(null).catch(() => {});
			void mutations
				.catch(() => {})
				.then(() => call("mutation", "localBrowser.close"))
				.catch(() => {});
		},
	};
}
export type LocalBrowserController = ReturnType<typeof createLocalBrowserController>;
