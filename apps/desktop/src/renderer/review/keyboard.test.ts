import assert from "node:assert/strict";
import { it } from "node:test";
import { isInteractiveTarget, reviewFileStep } from "./keyboard-target";

function focusedElement(selector: string) {
	const element = {
		nodeType: 1,
		closest: (query: string) => (query.split(", ").includes(selector) ? element : null),
	};
	return element as unknown as Element;
}

function key(key: string, changes: Partial<KeyboardEvent> = {}) {
	return {
		key,
		composedPath: () => [],
		...changes,
	} as unknown as KeyboardEvent;
}

it("leaves typing, native controls, editable variants, dialogs and menus in control of keys", () => {
	for (const selector of [
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
	]) {
		const element = focusedElement(selector);
		const doc = {
			activeElement: element,
			querySelector: () => null,
			hasFocus: () => true,
			hidden: false,
		};
		assert.equal(isInteractiveTarget(element), true, selector);
		assert.equal(reviewFileStep(key("j"), doc), null, `focused ${selector}`);
		assert.equal(
			reviewFileStep(key("k", { composedPath: () => [element] }), { ...doc, activeElement: null }),
			null,
			`shadow/composed path ${selector}`
		);
		assert.equal(
			isInteractiveTarget({ nodeType: 3, parentElement: element } as unknown as EventTarget),
			true,
			`text child ${selector}`
		);
	}
	assert.equal(isInteractiveTarget(null), false);
	assert.equal(isInteractiveTarget(new EventTarget()), false);
});

it("accepts bare j/k and preserves modifiers, composition, repeats and existing shortcuts", () => {
	const doc = {
		activeElement: null,
		querySelector: () => null,
		hasFocus: () => true,
		hidden: false,
	};
	assert.equal(reviewFileStep(key("j"), doc), 1);
	assert.equal(reviewFileStep(key("k"), doc), -1);
	for (const changes of [
		{ defaultPrevented: true },
		{ repeat: true },
		{ metaKey: true },
		{ ctrlKey: true },
		{ altKey: true },
		{ shiftKey: true },
		{ isComposing: true },
	])
		assert.equal(reviewFileStep(key("j", changes), doc), null);
	for (const other of ["Escape", " ", "Enter", "ArrowDown", "J", "K"])
		assert.equal(reviewFileStep(key(other), doc), null, other);
	assert.equal(reviewFileStep(key("j"), { ...doc, hidden: true }), null);
	assert.equal(reviewFileStep(key("j"), { ...doc, hasFocus: () => false }), null);
	assert.equal(
		reviewFileStep(key("j"), { ...doc, querySelector: () => focusedElement("dialog") }),
		null,
		"an open modal/menu blocks navigation even before it receives focus"
	);
});
