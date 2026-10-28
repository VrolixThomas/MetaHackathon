import assert from "node:assert/strict";
import { it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkspaceSnapshot } from "../../shared/contracts";
import { createPreparedApi } from "../prepared/api";
import { createPreparedController } from "../prepared/controller";
import { CanvasWorkspace } from "./CanvasWorkspace";
import { createWorkspaceController } from "./controller";
import { createLocalBrowserController } from "./local-browser";

it("shows actual document and one native browser in separate panes with accessible manual tabs", async () => {
	const snapshot: WorkspaceSnapshot = {
		sequence: 2,
		primaryId: "doc",
		secondaryId: "browser",
		codeView: "head",
		review: { sequence: 0, mode: "conversation", prId: null },
		browser: {
			url: "https://example.com/actual",
			title: "Actual page",
			viewport: { width: 1024, height: 768 },
			canGoBack: true,
			canGoForward: false,
			provenance: "website-unverified-revision",
		},
		canvases: [
			{ id: "review", kind: "review", title: "Code", revision: 1 },
			{
				id: "doc",
				kind: "document",
				title: "Explanation",
				revision: 2,
				markdown: "## Supplied title\n\nReal agent-authored text.",
				references: [],
				provenance: "agent-draft",
			},
			{ id: "browser", kind: "browser", title: "Actual page", revision: 1 },
		],
	};
	const call = async () => ({
		workspace: snapshot,
		browser: null,
		reviews: [],
		capabilities: ["documents", "visuals", "browser", "review"],
		savedCanvases: [
			{ kind: "document", id: "closed-document", title: "Previous draft", revision: 3 },
		],
	});
	const reviews = createPreparedController(createPreparedApi(call), "session");
	const browser = createLocalBrowserController(call);
	const controller = createWorkspaceController(call, reviews, browser, "session");
	try {
		await controller.start();
		const html = renderToStaticMarkup(
			<CanvasWorkspace
				controller={{
					...controller,
					store: { ...controller.store, getInitialState: controller.store.getState },
				}}
				reviews={reviews}
				browser={{
					...browser,
					store: { ...browser.store, getInitialState: browser.store.getState },
				}}
				obscured={false}
				onOpenRepository={() => {}}
			/>
		);
		assert.match(html, /data-primary-canvas="doc" data-secondary-canvas="browser"/);
		assert.match(html, /role="tablist" aria-label="Canvases"/);
		assert.equal((html.match(/role="tabpanel"/g) ?? []).length, 2);
		assert.equal((html.match(/data-native-browser-content="true"/g) ?? []).length, 1);
		assert.match(html, /<h2>Supplied title<\/h2>/);
		assert.match(html, /Real agent-authored text\./);
		assert.match(html, /Resize canvas panes/);
		assert.match(html, /Close Explanation/);
		assert.match(html, /aria-haspopup="dialog" aria-expanded="false">Recent/);
		assert.doesNotMatch(html, /Previous draft/);
		assert.doesNotMatch(html, /<iframe|<webview|srcdoc|fixture|demo/);
	} finally {
		controller.dispose();
		reviews.dispose();
		browser.dispose();
	}
});
