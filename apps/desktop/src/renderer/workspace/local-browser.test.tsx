import assert from "node:assert/strict";
import { it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { LocalBrowserState } from "../../shared/contracts";
import { WorkSplit } from "./WorkSplit";
import { createLocalBrowserController } from "./local-browser";

const page: LocalBrowserState = {
	url: "http://localhost:3000/actual",
	title: "Local app",
	viewport: { width: 1024, height: 768 },
	canGoBack: false,
	canGoForward: false,
	provenance: "local-preview-unverified-revision",
};
it("opens only explicit local addresses and never creates a placeholder browser", async () => {
	const paths: string[] = [];
	const controller = createLocalBrowserController(async (_type, path) => {
		paths.push(path);
		return path === "localBrowser.open" ? page : null;
	});
	try {
		assert.equal(controller.store.getState().page, null);
		assert.deepEqual(paths, []);
		await controller.open("https://example.com");
		await controller.open("http://name:secret@localhost:3000");
		assert.deepEqual(paths, []);
		await controller.open(page.url);
		assert.deepEqual(paths, ["localBrowser.open"]);
		assert.deepEqual(controller.store.getState().page, page);
		const html = renderToStaticMarkup(
			<WorkSplit
				obscured={false}
				browser={{
					...controller,
					store: { ...controller.store, getInitialState: controller.store.getState },
				}}
			>
				<div>Review work</div>
			</WorkSplit>
		);
		assert.match(html, /Resize work and browser panes/);
		assert.match(html, /Local preview · revision unverified/);
		assert.match(html, /data-native-browser-content="true"/);
		assert.doesNotMatch(html, /<iframe|<webview|srcdoc/);
	} finally {
		controller.dispose();
	}
});
it("a close during pending open cannot resurrect the native page in the renderer", async () => {
	let finish: (value: unknown) => void = () => {};
	const paths: string[] = [];
	const controller = createLocalBrowserController(async (_type, path) => {
		paths.push(path);
		if (path === "localBrowser.open")
			return new Promise((resolve) => {
				finish = resolve;
			});
		return undefined;
	});
	try {
		const opening = controller.open(page.url);
		await Promise.resolve();
		await Promise.resolve();
		const closing = controller.close();
		finish(page);
		await Promise.all([opening, closing]);
		assert.equal(controller.store.getState().page, null);
		assert.deepEqual(
			paths.filter((path) => path !== "localBrowser.present"),
			["localBrowser.open", "localBrowser.close"]
		);
	} finally {
		controller.dispose();
	}
});
