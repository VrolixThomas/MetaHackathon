import type { ReviewScreen } from "../../shared/contracts";
import { reviewFileStep } from "../review/keyboard-target";
import type { WorkspaceController } from "../workspace/controller";
import type { PreparedController } from "./controller";

/** Bind the default App's prepared source, using the same acknowledged command as Next/Back. */
export function connectPreparedFileNavigation(
	reviews: Pick<PreparedController, "store" | "getContext">,
	workspace: Pick<WorkspaceController, "store" | "command">,
	keyboard: Pick<Window, "addEventListener" | "removeEventListener" | "document">
) {
	const down = (event: KeyboardEvent) => {
		const step = reviewFileStep(event, keyboard.document);
		if (step === null) return;
		const state = reviews.store.getState();
		const canvas = workspace.store.getState();
		const snapshot = canvas.workspace;
		const plan = state.detail?.prepared;
		const file = state.file;
		if (
			canvas.busy ||
			!snapshot ||
			!snapshot.canvases.some(
				(entry) =>
					entry.kind === "review" &&
					(entry.id === snapshot.primaryId || entry.id === snapshot.secondaryId)
			) ||
			state.fileBusy ||
			state.stale ||
			state.detail?.status !== "ready" ||
			!plan ||
			!file
		)
			return;
		const matches = (screen: ReviewScreen | undefined) =>
			screen?.mode === "review" &&
			screen.prId === plan.pr.id &&
			screen.reviewId === plan.id &&
			screen.baseSha === plan.pr.baseSha &&
			screen.headSha === plan.pr.headSha &&
			screen.path === file.path;
		if (
			!matches(snapshot.review) ||
			!matches(reviews.getContext().screen) ||
			file.prId !== plan.pr.id ||
			file.base.commitSha !== plan.pr.baseSha ||
			file.head.commitSha !== plan.pr.headSha
		)
			return;
		const index = plan.files.findIndex((entry) => entry.path === file.path);
		if (index < 0) return;
		const next = plan.files[index + step];
		// Endpoints are a no-op: no redundant source load, progress write or reply interruption.
		if (!next) return;
		event.preventDefault();
		void workspace.command({ kind: "navigate-review", path: next.path });
	};
	keyboard.addEventListener("keydown", down as EventListener);
	return () => keyboard.removeEventListener("keydown", down as EventListener);
}
