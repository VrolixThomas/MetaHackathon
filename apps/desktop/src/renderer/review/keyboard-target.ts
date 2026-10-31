const interactiveSelector = [
	"input",
	"textarea",
	"select",
	"button",
	"a",
	"summary",
	"dialog",
	"[contenteditable]:not([contenteditable='false' i])",
	"[role='textbox']",
	"[role='combobox']",
	"[role='listbox']",
	"[role='dialog']",
	"[role='alertdialog']",
	"[role='menu']",
	"[role='menubar']",
	"[role^='menuitem']",
].join(", ");

/** Use node identity rather than the global Element constructor, including shadow/other realms. */
export function isInteractiveTarget(target: EventTarget | null) {
	const node = target as Node | null;
	const element = node?.nodeType === 1 ? (node as Element) : node?.parentElement;
	return !!element?.closest(interactiveSelector);
}

export type ReviewKeyboardDocument = Pick<
	Document,
	"activeElement" | "querySelector" | "hasFocus" | "hidden"
>;

/** Only bare, unhandled j/k presses belong to file navigation. */
export function reviewFileStep(event: KeyboardEvent, doc: ReviewKeyboardDocument): 1 | -1 | null {
	if (
		event.defaultPrevented ||
		event.repeat ||
		event.metaKey ||
		event.ctrlKey ||
		event.altKey ||
		event.shiftKey ||
		event.isComposing ||
		(event.key !== "j" && event.key !== "k") ||
		doc.hidden ||
		!doc.hasFocus()
	)
		return null;
	if (
		isInteractiveTarget(doc.activeElement) ||
		event.composedPath().some(isInteractiveTarget) ||
		doc.querySelector(
			"dialog[open], [role='dialog']:not([hidden]):not([aria-hidden='true']), [role='alertdialog']:not([hidden]):not([aria-hidden='true']), [aria-modal='true']:not([hidden]):not([aria-hidden='true']), [role='menu']:not([hidden]):not([aria-hidden='true'])"
		)
	)
		return null;
	return event.key === "j" ? 1 : -1;
}
