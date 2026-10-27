import { create } from "zustand";
import { type BrowserBounds, type BrowserState, BrowserStateSchema } from "../../shared/contracts";
import { useReview } from "./controller";
import { reviewSessionId } from "./conversation";
import { type BrowserAdapter, useServices } from "./services";

export const useBrowserOperation = create<{ busy: boolean; error: string }>(() => ({
	busy: false,
	error: "",
}));
let operation = 0;

/** Reject observations from another PR, session, revision or an older page snapshot. */
export function acceptBrowserState(input: BrowserState, replace = false) {
	const browser = BrowserStateSchema.parse(input);
	const state = useReview.getState();
	const pr = state.preparation.pr;
	if (
		browser.sessionId !== reviewSessionId ||
		browser.prId !== pr.id ||
		browser.repository !== pr.repository ||
		browser.commitSha !== (browser.revision === "base" ? pr.baseSha : pr.headSha)
	)
		return false;
	if (state.browser) {
		if (state.browser.browserId !== browser.browserId && !replace) return false;
		if (state.browser.browserId === browser.browserId && state.browser.sequence > browser.sequence)
			return false;
		if (
			state.browser.browserId === browser.browserId &&
			state.browser.sequence === browser.sequence
		)
			return JSON.stringify(state.browser) === JSON.stringify(browser);
	}
	useReview.setState({ browser });
	return true;
}

async function execute(action: (adapter: BrowserAdapter) => Promise<BrowserState>) {
	const adapter = useServices.getState().browser;
	if (!adapter || useBrowserOperation.getState().busy) return;
	const current = ++operation;
	const pr = useReview.getState().preparation.pr;
	useBrowserOperation.setState({ busy: true, error: "" });
	try {
		const browser = await action(adapter);
		const active = useReview.getState().preparation.pr;
		if (current !== operation || active.id !== pr.id || active.headSha !== pr.headSha) return;
		acceptBrowserState(browser, true);
	} catch {
		if (current === operation)
			useBrowserOperation.setState({
				error: "The browser could not complete this request. Try again.",
			});
	} finally {
		if (current === operation) useBrowserOperation.setState({ busy: false });
	}
}
export function openReviewBrowser(revision: "base" | "head" = "head") {
	useReview.getState().setPanel("browser");
	return execute((adapter) =>
		adapter.execute({
			kind: "open",
			sessionId: reviewSessionId,
			requestId: crypto.randomUUID(),
			prId: useReview.getState().preparation.pr.id,
			revision,
		})
	);
}
export function setBrowserViewport(mode: "desktop" | "phone") {
	const browser = useReview.getState().browser;
	if (!browser) return;
	return execute((adapter) =>
		adapter.execute({
			kind: "viewport",
			sessionId: reviewSessionId,
			requestId: crypto.randomUUID(),
			browserId: browser.browserId,
			viewport: mode === "phone" ? { width: 390, height: 844 } : { width: 1024, height: 768 },
		})
	);
}
export async function refreshReviewBrowser() {
	const adapter = useServices.getState().browser;
	if (!adapter || useBrowserOperation.getState().busy) return;
	const epoch = operation;
	const browser = await adapter.observe(reviewSessionId);
	if (browser && epoch === operation && !useBrowserOperation.getState().busy)
		acceptBrowserState(browser);
}

/** Serialize presentation updates so a slow resize can never overtake a later hide. */
export function createBrowserPresenter(adapter: BrowserAdapter, sessionId: string) {
	let pending = Promise.resolve();
	return (bounds: BrowserBounds | null) => {
		pending = pending.catch(() => {}).then(() => adapter.present(sessionId, bounds));
		return pending;
	};
}
