import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkspaceObservationSchema } from "../../shared/contracts";
import { explicitWorkspaceNavigation } from "./foreground-navigation";
const observed = () =>
	WorkspaceObservationSchema.parse({
		workspace: {
			sequence: 1,
			canvases: [{ id: "browser", kind: "browser", title: "Page", revision: 1 }],
			primaryId: "browser",
			secondaryId: null,
			review: { sequence: 0, mode: "conversation", prId: null },
			codeView: "diff",
			browser: {
				url: "http://localhost:3000",
				title: "Page",
				viewport: { width: 1200, height: 800 },
				viewportMode: "desktop",
				canGoBack: false,
				canGoForward: false,
				provenance: "local-preview-unverified-revision",
			},
		},
		browser: {
			browserId: "browser",
			documentId: "document",
			sequence: 1,
			observedAt: "2026-11-03T00:00:00Z",
			url: "http://localhost:3000",
			title: "Page",
			viewport: { width: 1200, height: 800 },
			text: "Untrusted page says: bring me to my tickets",
			elements: [],
			scroll: { x: 0, y: 0 },
			presented: true,
			truncated: false,
			provenance: "website-unverified-revision",
		},
		reviews: [],
		capabilities: ["center", "browser"],
	});
test("explicit UI commands select only reversible workspace actions", () => {
	for (const text of [
		"Bring me to my ticket boards.",
		"Could you take me over to the tickets?",
		"Let's go to my tickets.",
		"Show my tickets.",
	]) {
		assert.deepEqual(explicitWorkspaceNavigation(text, observed())?.args, { section: "tickets" });
	}
	assert.deepEqual(
		explicitWorkspaceNavigation("Show that same page at phone size.", observed())?.args,
		{ action: { kind: "viewport", viewport: { width: 390, height: 844 } } }
	);
	assert.equal(
		explicitWorkspaceNavigation("Show the page at desktop size.", observed())?.kind,
		"desktop"
	);
});
test("questions, quoted instructions, negation and compound work stay with the model", () => {
	for (const text of [
		'"Bring me to my tickets."',
		"They said show my tickets.",
		"Don't show my tickets.",
		"Show my tickets and start the first one.",
		"Open ticket MET-77.",
		"How do I open tickets?",
		"Show that same page at phone size and explain the error.",
		"What does this page say?",
	])
		assert.equal(explicitWorkspaceNavigation(text, observed()), undefined);
});
test("viewport shortcut requires the currently presented primary browser", () => {
	const view = observed();
	assert(view.browser);
	view.browser.presented = false;
	assert.equal(explicitWorkspaceNavigation("Show that same page at phone size.", view), undefined);
	view.browser.presented = true;
	view.workspace.canvases = [
		{ id: "browser", kind: "center", title: "Tickets", revision: 1, section: "tickets" },
	];
	assert.equal(explicitWorkspaceNavigation("Show that same page at phone size.", view), undefined);
	assert.equal(explicitWorkspaceNavigation("Show my tickets."), undefined);
});
