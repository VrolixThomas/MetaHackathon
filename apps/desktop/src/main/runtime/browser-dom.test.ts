import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import type { BrowserSnapshot } from "./browser";
import { browserActionScript, browserSnapshotScript } from "./browser-dom";

// A small DOM port executes the production isolated-world scripts without Electron,
// a server, network access or new dependencies. Native DOM acceptance stays in integration.
class Element {
	name = "";
	id = "";
	autocomplete = "";
	innerText = "";
	disabled = false;
	readOnly = false;
	isConnected = true;
	hidden = false;
	clicks = 0;
	focuses = 0;
	scrolled = 0;
	events: string[] = [];
	attributes: Record<string, string> = {};
	rect = { x: 10, y: 10, width: 100, height: 30 };
	constructor(
		public tagName = "BUTTON",
		public type = ""
	) {}
	getAttribute(name: string) {
		return this.attributes[name] ?? null;
	}
	getBoundingClientRect() {
		const { x, y, width, height } = this.rect;
		return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height };
	}
	matches() {
		return this.tagName === "INPUT" && ["password", "file", "hidden"].includes(this.type);
	}
	closest(selector: string) {
		if (selector.includes("[hidden]")) return this.hidden ? this : null;
		return selector.split(",").includes(this.tagName.toLowerCase()) ? this : null;
	}
	contains(element: Element) {
		return element === this;
	}
	click() {
		this.clicks++;
	}
	focus() {
		this.focuses++;
	}
	dispatchEvent(event: { type: string }) {
		this.events.push(event.type);
	}
	scrollIntoView() {
		this.scrolled++;
	}
}

class Input extends Element {
	private rawValue = "";
	constructor(value = "", type = "text") {
		super("INPUT", type);
		this.value = value;
	}
	get value() {
		return this.rawValue;
	}
	set value(value: string) {
		this.rawValue = value;
	}
}
class Textarea extends Input {
	constructor(value = "") {
		super(value, "textarea");
		this.tagName = "TEXTAREA";
	}
	override get value() {
		return super.value;
	}
	override set value(value: string) {
		super.value = value;
	}
}
interface TextNode {
	textContent: string;
	parentElement: Element;
}

function domFixture(elements: Element[] = [], text: TextNode[] = []) {
	const document = {
		title: "Untrusted website",
		body: {},
		querySelectorAll: () => elements,
		elementFromPoint: (x: number, y: number) =>
			elements.find((el) => {
				const rect = el.getBoundingClientRect();
				return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
			}),
		createTreeWalker: () => {
			let index = -1;
			return {
				currentNode: undefined as TextNode | undefined,
				nextNode() {
					this.currentNode = text[++index];
					return this.currentNode;
				},
			};
		},
		createRange: () => {
			let selected: TextNode;
			return {
				selectNodeContents(node: TextNode) {
					selected = node;
				},
				getClientRects: () => [selected.parentElement.getBoundingClientRect()],
			};
		},
	};
	const environment = {
		document,
		location: { href: "https://example.com/" },
		crypto: { randomUUID },
		NodeFilter: { SHOW_TEXT: 4 },
		getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
		HTMLInputElement: Input,
		HTMLTextAreaElement: Textarea,
		Event: class {
			constructor(public type: string) {}
		},
		innerWidth: 1024,
		innerHeight: 768,
		scrollX: 0,
		scrollY: 0,
		scrollTo: ({ left, top }: { left: number; top: number }) => {
			environment.scrollX = left;
			environment.scrollY = top;
		},
	};
	const context = createContext(environment);
	return {
		document,
		environment,
		elements,
		text,
		snapshot: () => runInContext(browserSnapshotScript, context) as BrowserSnapshot,
		act: (command: object, expected: BrowserSnapshot) =>
			runInContext(browserActionScript(command, JSON.stringify(expected)), context),
		replaceDocument() {
			environment.document = { ...document };
		},
	};
}

test("isolated document ID and refs persist through observations, hash navigation and DOM changes", () => {
	const button = new Element();
	const f = domFixture([button]);
	const first = f.snapshot();
	assert.match(first.documentId ?? "", /^[0-9a-f-]{36}$/);
	assert.equal(first.elements[0]?.id, `${first.documentId}:1`);
	assert.equal(f.snapshot().documentId, first.documentId);
	assert.equal(f.snapshot().elements[0]?.id, first.elements[0]?.id);
	f.environment.location.href += "#section";
	button.innerText = "Updated page";
	assert.equal(f.snapshot().documentId, first.documentId);
	const second = new Element();
	f.elements.push(second);
	assert.equal(f.snapshot().elements[1]?.id, `${first.documentId}:2`);
	// Same URL/content in a replacement document must still invalidate old observations.
	const before = f.snapshot();
	f.replaceDocument();
	const after = f.snapshot();
	assert.equal(after.url, before.url);
	assert.notEqual(after.documentId, before.documentId);
	assert.notEqual(after.elements[0]?.id, before.elements[0]?.id);
	assert.throws(
		() => f.act({ kind: "click", elementId: before.elements[0]?.id }, before),
		/observation changed/
	);
	assert.equal(button.clicks, 0);
});

test("workspace and legacy observations both gate actions while input whitespace stays exact", () => {
	const input = new Input("  two  words \n");
	const f = domFixture([input]);
	const first = f.snapshot();
	assert.equal(first.elements[0]?.value, "  two  words \n");
	input.value = "two words";
	assert.throws(
		() => f.act({ kind: "type", elementId: first.elements[0]?.id, text: "late" }, first),
		/observation changed/
	);
	assert.equal(input.value, "two words");
	const { url, title, text, elements, scroll } = f.snapshot();
	const legacy = { url, title, text, elements, scroll };
	f.act({ kind: "type", elementId: elements[0]?.id, text: " exact \tvalue " }, legacy);
	assert.equal(input.value, " exact \tvalue ");
	assert.deepEqual(input.events, ["input", "change"]);
	const current = f.snapshot();
	f.act({ kind: "click", elementId: current.elements[0]?.id }, current);
	assert.equal(input.clicks, 1);
	f.act({ kind: "scroll", y: 300 }, f.snapshot());
	assert.equal(f.snapshot().scroll.y, 300);
	f.act({ kind: "scroll", elementId: current.elements[0]?.id }, f.snapshot());
	assert.equal(input.scrolled, 1);
});

test("snapshot limits report truncation only when visible text or eligible refs exceed their bounds", () => {
	const parent = new Element("P");
	const elements = Array.from({ length: 150 }, () => new Element());
	const f = domFixture(elements, [{ parentElement: parent, textContent: "x".repeat(16000) }]);
	const exact = f.snapshot();
	assert.equal(exact.text.length, 16000);
	assert.equal(exact.elements.length, 150);
	assert.equal(exact.truncated, false);
	f.text.push({ parentElement: parent, textContent: "extra" });
	assert.equal(f.snapshot().text.length, 16000);
	assert.equal(f.snapshot().truncated, true);
	f.text.pop();
	f.text[0] = { parentElement: parent, textContent: "x".repeat(16001) };
	assert.equal(f.snapshot().truncated, true);
	f.text.length = 0;
	const hidden = new Element();
	hidden.hidden = true;
	f.elements.push(hidden, new Input("secret", "password"));
	assert.equal(f.snapshot().truncated, false);
	f.elements.push(new Element());
	assert.equal(f.snapshot().elements.length, 150);
	assert.equal(f.snapshot().truncated, true);
});

test("visible text is normalized and bounded with real separators; sensitive fields stay absent", () => {
	const parent = new Element("P");
	const input = new Input("private");
	input.name = "api_key";
	const password = new Input("private", "password");
	const f = domFixture(
		[input, password],
		[
			{ parentElement: parent, textContent: "  One \n\t two  " },
			{ parentElement: parent, textContent: "three" },
			{ parentElement: input, textContent: "private" },
			{ parentElement: new Element("SCRIPT"), textContent: "script text" },
		]
	);
	assert.equal(f.snapshot().text, "One two\nthree");
	assert.equal(f.snapshot().elements.length, 0);
	f.text[0] = { parentElement: parent, textContent: "x".repeat(15999) };
	assert.equal(f.snapshot().text.length, 15999);
	assert.equal(f.snapshot().truncated, true);
});

test("checked DOM actions reject missing, disabled, obscured, offscreen and readonly targets", () => {
	const input = new Input("original");
	const f = domFixture([input]);
	const act = (kind = "click", elementId = f.snapshot().elements[0]?.id) =>
		f.act({ kind, elementId, text: "replacement" }, f.snapshot());
	assert.throws(() => act("click", "missing"), /Stale browser element/);
	input.disabled = true;
	assert.throws(() => act(), /disabled/);
	input.disabled = false;
	input.readOnly = true;
	assert.throws(() => act("type"), /not an editable/);
	input.readOnly = false;
	input.rect.y = 900;
	assert.throws(() => act(), /Scroll browser element/);
	input.rect.y = 10;
	const overlay = new Element();
	f.elements.unshift(overlay);
	const inputId = f.snapshot().elements[1]?.id;
	assert.throws(() => act("click", inputId), /obscured/);
	f.elements.shift();
	input.isConnected = false;
	assert.throws(() => act(), /Stale browser element/);
	assert.equal(input.clicks, 0);
	assert.equal(input.value, "original");
});
