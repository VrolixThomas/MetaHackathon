import type { ElectronAPI } from "../../shared/types";
import type { ConversationController } from "./controller";

/** Native shortcut events are explicit; ordinary keyboard input never passes through here. */
export function connectShortcuts(
	shortcuts: ElectronAPI["voiceShortcut"] | undefined,
	controller: Pick<ConversationController, "press" | "release" | "toggle" | "stop">,
	keyboard?: Pick<Window, "addEventListener" | "removeEventListener">
) {
	const onEscape = (event: KeyboardEvent) => {
		if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
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
