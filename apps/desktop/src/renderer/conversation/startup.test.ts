import assert from "node:assert/strict";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "../App";

it("bundles the real startup without fixtures or the legacy artifact workspace", async () => {
	const result = await build({
		entryPoints: [fileURLToPath(new URL("../main.tsx", import.meta.url))],
		bundle: true,
		platform: "browser",
		write: false,
		metafile: true,
		loader: { ".css": "empty" },
		logLevel: "silent",
	});
	const inputs = Object.keys(result.metafile.inputs);
	assert.equal(
		inputs.some((path) => /\/fixtures\/|\/renderer\/review\//.test(path)),
		false
	);
	assert.ok(inputs.some((path) => path.endsWith("conversation/ConversationApp.tsx")));
});
it("opens a canvas workspace with persistent voice and a collapsed accessible conversation panel", () => {
	const html = renderToStaticMarkup(createElement(App));
	assert.match(html, /aria-label="Workspace canvases"/);
	assert.match(html, /Open repository/);
	assert.match(html, /data-testid="repository-selector"[^>]*aria-haspopup="dialog"/);
	assert.match(html, /data-testid="workspace-more"[^>]*aria-haspopup="dialog"/);
	const header = html.match(/<header class="app-header">(.*?)<\/header>/)?.[1] ?? "";
	assert.equal((header.match(/<button/g) ?? []).length, 2);
	assert.doesNotMatch(header, /Conversation|Local preview|Configuration/);
	assert.match(html, /id="conversation-panel"[^>]*hidden=""/);
	assert.match(html, /<footer[^>]*class="voice-bar"/);
	assert.doesNotMatch(html, /<iframe|<webview|data-native-browser-content/);
	assert.match(html, /aria-label="Start conversation"/);
	assert.match(html, /<textarea[^>]*name="question"/);
	assert.doesNotMatch(
		html,
		/class="exchange"|Load local demo|Scenario C|Sign-off|Checkout|type="password"/
	);
});
