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
it("opens an empty conversation with visible talk and typed controls", () => {
	const html = renderToStaticMarkup(createElement(App));
	assert.match(html, /Start a conversation/);
	assert.match(html, /aria-label="Hold to talk"/);
	assert.match(html, /<textarea[^>]*name="question"/);
	assert.doesNotMatch(
		html,
		/class="exchange"|Load local demo|Scenario C|Sign-off|Checkout|type="password"/
	);
});
