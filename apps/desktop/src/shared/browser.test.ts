import { describe, expect, test } from "bun:test";
import { BrowserCommandSchema, BrowserStateSchema } from "./contracts";

describe("visible browser boundary", () => {
	test("element actions require an observation and scroll cannot be empty", () => {
		const target = { sessionId: "review", requestId: "effect", browserId: "page" };
		expect(
			BrowserCommandSchema.safeParse({ ...target, kind: "click", elementId: "e1" }).success
		).toBe(false);
		expect(BrowserCommandSchema.safeParse({ ...target, kind: "scroll" }).success).toBe(false);
		expect(
			BrowserCommandSchema.safeParse({ ...target, kind: "scroll", elementId: "e1" }).success
		).toBe(false);
		expect(
			BrowserCommandSchema.parse({
				...target,
				kind: "scroll",
				elementId: "e1",
				observationSequence: 3,
			}).kind
		).toBe("scroll");
	});
	test("observations stay bounded and element IDs are unambiguous", () => {
		const state = {
			browserId: "page",
			sessionId: "review",
			prId: "pr",
			repository: "demo/shop-web",
			commitSha: "1".repeat(40),
			revision: "head",
			url: "http://127.0.0.1:3000/checkout",
			title: "Checkout",
			viewport: { width: 1024, height: 768 },
			sequence: 0,
			observedAt: "2026-10-27T00:00:00.000Z",
			text: "",
			elements: [],
			scroll: { x: 0, y: 0 },
			provenance: "live-browser",
		};
		expect(BrowserStateSchema.safeParse(state).success).toBe(true);
		expect(BrowserStateSchema.safeParse({ ...state, text: "a".repeat(16001) }).success).toBe(false);
		const element = {
			id: "e1",
			role: "button",
			name: "Pay",
			tag: "button",
			bounds: { x: 0, y: -20, width: 20, height: 20 },
			visible: false,
			enabled: true,
		};
		expect(BrowserStateSchema.safeParse({ ...state, elements: [element, element] }).success).toBe(
			false
		);
		expect(BrowserStateSchema.safeParse({ ...state, provenance: "fixture" }).success).toBe(false);
	});
});
