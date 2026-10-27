import { createStore } from "zustand/vanilla";
import {
	type BrowserBounds,
	type LocalBrowserCommand,
	LocalBrowserCommandSchema,
	LocalBrowserPresentSchema,
	type LocalBrowserState,
	LocalBrowserStateSchema,
	LocalBrowserUrlSchema,
} from "../../shared/contracts";
import type { ConversationApi } from "../conversation/api";
import { createSurfacePresenter } from "./layout";

/** Only root can create/navigate the native view; no URL is opened by renderer startup. */
export function createLocalBrowserController(call: ConversationApi["call"]) {
	const store = createStore<{ page: LocalBrowserState | null; busy: boolean; error: string }>(
		() => ({ page: null, busy: false, error: "" })
	);
	let disposed = false;
	let epoch = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let mutations: Promise<unknown> = Promise.resolve();
	const present = createSurfacePresenter(async (bounds: BrowserBounds | null) => {
		await call("mutation", "localBrowser.present", LocalBrowserPresentSchema.parse({ bounds }));
	});
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
		command: (input: LocalBrowserCommand) => {
			if (!store.getState().page || store.getState().busy) return Promise.resolve();
			return change(async () =>
				LocalBrowserStateSchema.parse(
					await call("mutation", "localBrowser.command", LocalBrowserCommandSchema.parse(input))
				)
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
