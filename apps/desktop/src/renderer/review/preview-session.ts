import type { Preview } from "../../shared/contracts";
import { validateViewportResult } from "./artifacts/preview-model";
import { useReview } from "./controller";
import type { ArtifactAdapter } from "./services";

let generation = 0;
let pending: AbortController | null = null;

/** Validate before publishing. A late resize must never replace another review's preview. */
export async function resizeActivePreview(
	adapter: ArtifactAdapter,
	mode: Preview["viewport"]["mode"],
	rendererOrigin = typeof window === "undefined" ? undefined : window.location.origin
) {
	const state = useReview.getState();
	const preview = state.preview;
	if (!preview || state.panel !== "preview") throw new Error("No active preview");
	const token = ++generation;
	pending?.abort();
	const controller = new AbortController();
	pending = controller;
	const unsubscribe = useReview.subscribe((current) => {
		if (
			current.preparation.pr.id !== state.preparation.pr.id ||
			current.preparation.pr.headSha !== state.preparation.pr.headSha ||
			current.preview?.id !== preview.id ||
			current.panel !== "preview"
		)
			controller.abort();
	});
	try {
		const result = await adapter.resizePreview(preview, mode, controller.signal);
		controller.signal.throwIfAborted();
		if (token !== generation) throw new DOMException("Superseded preview", "AbortError");
		const next = validateViewportResult(preview, result, mode, rendererOrigin);
		unsubscribe();
		useReview.setState((current) => ({ preview: next, sequence: current.sequence + 1 }));
		return next;
	} finally {
		unsubscribe();
		if (pending === controller) pending = null;
	}
}
