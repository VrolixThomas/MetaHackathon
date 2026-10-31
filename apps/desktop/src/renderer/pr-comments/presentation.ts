import {
	type DraftedComment,
	type PRCommentPresentation,
	PRCommentPresentationSchema,
} from "../../shared/contracts";
import type { PRCommentController } from "./controller";

/** Root maps its shared action contract to this controller input; no competing draft is created. */
export type CommentPresentationInput = PRCommentPresentation;
export function visibleCommentDraft(draft: DraftedComment) {
	const dialog = document.getElementById("pr-comment-composer");
	const marker = dialog?.querySelector<HTMLElement>("[data-comment-draft-id]");
	const body = marker?.querySelector("[aria-label='Exact comment body']");
	return (
		document.visibilityState === "visible" &&
		dialog instanceof HTMLDialogElement &&
		dialog.open &&
		dialog.getClientRects().length > 0 &&
		marker?.dataset["commentDraftId"] === draft.id &&
		marker.dataset["commentDraftRevision"] === String(draft.revision) &&
		marker.dataset["commentHead"] === draft.headSha &&
		body?.textContent === draft.body
	);
}
export async function presentPRComment(
	controller: PRCommentController,
	raw: CommentPresentationInput,
	signal: AbortSignal,
	options: {
		frame?: () => Promise<void>;
		visible?: (draft: DraftedComment) => boolean;
		timeoutMs?: number;
	} = {}
) {
	const input = PRCommentPresentationSchema.parse(raw);
	const draft = input.draft;
	const receipt = (status: "applied" | "ignored") => ({
		requestId: input.requestId,
		sessionId: input.sessionId,
		turnId: input.turnId,
		generation: input.generation,
		status,
		draft: structuredClone(draft),
	});
	if (signal.aborted || !controller.adoptDraft(draft, input.reviewId)) return receipt("ignored");
	const frame =
		options.frame ?? (() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
	const visible = options.visible ?? visibleCommentDraft;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abort = () => {};
	const stopped = new Promise<never>((_, reject) => {
		abort = () => reject(new Error("Comment presentation cancelled"));
		signal.addEventListener("abort", abort, { once: true });
		timer = setTimeout(abort, options.timeoutMs ?? 8000);
	});
	try {
		let committedFrames = 0;
		for (let count = 0; count < 240; count++) {
			await Promise.race([frame(), stopped]);
			controller.refreshContext();
			const state = controller.getSnapshot();
			if (
				signal.aborted ||
				!state.open ||
				state.phase !== "review" ||
				state.context?.reviewId !== input.reviewId ||
				JSON.stringify(state.draft) !== JSON.stringify(draft)
			)
				return receipt("ignored");
			committedFrames = visible(draft) ? committedFrames + 1 : 0;
			if (committedFrames === 2) return receipt("applied");
		}
		return receipt("ignored");
	} catch {
		return receipt("ignored");
	} finally {
		if (timer) clearTimeout(timer);
		signal.removeEventListener("abort", abort);
	}
}
