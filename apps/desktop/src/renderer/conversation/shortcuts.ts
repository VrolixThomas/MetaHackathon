import type { ElectronAPI } from "../../shared/types";
import type { ConversationController } from "./controller";

/** Escape explicitly ends speech and listening, unless a dialog consumed it.
 * Native guest Escape does the same. Ordinary browsing never interrupts a reply. */
export function connectShortcuts(
	shortcuts: ElectronAPI["voiceShortcut"] | undefined,
	controller: Pick<
		ConversationController,
		"press" | "release" | "toggle" | "stop" | "interruptReply"
	>,
	keyboard?: Pick<Window, "addEventListener" | "removeEventListener">
) {
	const onEscape = (event: KeyboardEvent) => {
		if (event.defaultPrevented || event.isComposing || event.repeat) return;
		if (event.key === "." && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
			event.preventDefault();
			controller.interruptReply();
			return;
		}
		if (event.key !== "Escape") return;
		controller.stop("escape");
	};
	keyboard?.addEventListener("keydown", onEscape as EventListener);
	const unsubscribe =
		shortcuts?.subscribe(({ phase }) => {
			if (phase === "press") controller.press();
			else if (phase === "release") controller.release();
			else if (phase === "toggle") controller.toggle();
			else controller.stop("escape");
		}) ?? (() => {});
	return () => {
		unsubscribe();
		keyboard?.removeEventListener("keydown", onEscape as EventListener);
	};
}
