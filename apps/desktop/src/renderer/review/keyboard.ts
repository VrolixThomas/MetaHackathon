import { useEffect } from "react";
import { useReview } from "./controller";
import { cancelActiveQuestion } from "./conversation";
import { isInteractiveTarget } from "./keyboard-target";
import { cancelRuntimeAction } from "./runtime-actions";

export { isInteractiveTarget };

/** The only global Space listener belongs to the UI lane. */
export function useReviewKeyboard({
	modalOpen,
	closeModal,
	startCapture,
	endCapture,
}: {
	modalOpen: boolean;
	closeModal: () => void;
	startCapture: () => void;
	endCapture: () => void;
}) {
	useEffect(() => {
		let spaceHeld = false;
		const release = () => {
			if (spaceHeld) {
				spaceHeld = false;
				endCapture();
			}
		};
		const down = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				endCapture();
				cancelRuntimeAction();
				void cancelActiveQuestion("escape");
				release();
				if (modalOpen) closeModal();
				else useReview.getState().setPanel(null);
				return;
			}
			if (
				modalOpen ||
				isInteractiveTarget(event.target) ||
				event.metaKey ||
				event.ctrlKey ||
				event.altKey ||
				event.isComposing
			)
				return;
			if (event.code === "Space") {
				event.preventDefault();
				if (!event.repeat && !spaceHeld && document.hasFocus()) {
					spaceHeld = true;
					startCapture();
				}
			} else if (event.key.toLowerCase() === "j" || event.key.toLowerCase() === "k") {
				event.preventDefault();
				useReview.getState().moveCursor(event.key.toLowerCase() === "j" ? 1 : -1);
			} else if (event.key === "Enter") {
				event.preventDefault();
				useReview.getState().openCursor();
			}
		};
		const up = (event: KeyboardEvent) => {
			if (event.code === "Space") release();
		};
		const visibility = () => {
			if (document.hidden) release();
		};
		window.addEventListener("keydown", down);
		window.addEventListener("keyup", up);
		window.addEventListener("blur", release);
		document.addEventListener("visibilitychange", visibility);
		return () => {
			release();
			window.removeEventListener("keydown", down);
			window.removeEventListener("keyup", up);
			window.removeEventListener("blur", release);
			document.removeEventListener("visibilitychange", visibility);
		};
	}, [modalOpen, closeModal, startCapture, endCapture]);
}
