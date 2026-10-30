import type { ElectronAPI } from "../../shared/types";
import type { AttentionSafetyPort, AttentionSafetySnapshot } from "./attention";
import type { ConversationController } from "./controller";

/** Read-only UI eligibility. Native guest input is reported without exposing its text or keys. */
export function createAttentionSafety(
	ui: ConversationController,
	activity: ElectronAPI["attentionActivity"],
	root: Window = window,
	doc: Document = document,
	options: { now?: () => number; recentMs?: number } = {}
): AttentionSafetyPort & { dispose(): void } {
	const now = options.now ?? Date.now;
	const recentMs = options.recentMs ?? 2500;
	let nativeFocused: boolean | null = null;
	let lastActivity = now();
	let lastInput = Number.NEGATIVE_INFINITY;
	let sequence = 0;
	let composing = false;
	let disposed = false;
	const listeners = new Set<() => void>();
	const notify = () => {
		if (disposed) return;
		for (const listener of listeners) listener();
	};
	const changed = () => {
		lastActivity = now();
		sequence++;
		notify();
	};
	const input = () => {
		lastInput = now();
		changed();
	};
	const compositionStart = () => {
		composing = true;
		input();
	};
	const compositionEnd = () => {
		composing = false;
		input();
	};
	const events = ["pointerdown", "keydown", "wheel", "focusin", "submit"] as const;
	for (const event of events) doc.addEventListener(event, changed, true);
	doc.addEventListener("input", input, true);
	doc.addEventListener("compositionstart", compositionStart, true);
	doc.addEventListener("compositionend", compositionEnd, true);
	root.addEventListener("focus", changed);
	root.addEventListener("blur", changed);
	doc.addEventListener("visibilitychange", changed);
	const unsubscribeNative = activity?.subscribe((event) => {
		nativeFocused = event.focused;
		changed();
	});
	const unsubscribeController = ui.store.subscribe(notify);
	const mutations = new MutationObserver((records) => {
		if (
			records.some(
				(record) =>
					record.target instanceof HTMLDialogElement ||
					[...record.addedNodes, ...record.removedNodes].some(
						(node) =>
							node instanceof Element &&
							(node.matches("dialog,[role=dialog]") || !!node.querySelector("dialog,[role=dialog]"))
					)
			)
		)
			changed();
	});
	mutations.observe(doc.documentElement, {
		subtree: true,
		childList: true,
		attributes: true,
		attributeFilter: ["open"],
	});
	return {
		getSnapshot(): AttentionSafetySnapshot {
			return {
				enabled: !disposed && ui.store.getState().handsFree,
				focused: !doc.hidden && (nativeFocused ?? doc.hasFocus()),
				obscured: !!doc.querySelector("dialog,[role=dialog]"),
				typing: composing || now() - lastInput < recentMs,
				recentInteraction: now() - lastActivity < recentMs,
				activitySequence: sequence,
			};
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			mutations.disconnect();
			unsubscribeNative?.();
			unsubscribeController();
			for (const event of events) doc.removeEventListener(event, changed, true);
			doc.removeEventListener("input", input, true);
			doc.removeEventListener("compositionstart", compositionStart, true);
			doc.removeEventListener("compositionend", compositionEnd, true);
			doc.removeEventListener("visibilitychange", changed);
			root.removeEventListener("focus", changed);
			root.removeEventListener("blur", changed);
			listeners.clear();
		},
	};
}
