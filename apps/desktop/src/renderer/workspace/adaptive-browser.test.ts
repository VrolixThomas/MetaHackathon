import assert from "node:assert/strict";
import { it } from "node:test";
import type { LocalBrowserState } from "../../shared/contracts";
import { createLocalBrowserController } from "./local-browser";

const page: LocalBrowserState = {
	url: "https://example.com/",
	title: "Actual website",
	viewport: { width: 1024, height: 768 },
	viewportMode: "desktop",
	canGoBack: false,
	canGoForward: false,
	provenance: "website-unverified-revision",
};
it("presentation publishes the returned native desktop viewport before it settles", async () => {
	const fitted = { ...page, viewport: { width: 1230, height: 820 } };
	const ui = createLocalBrowserController(async (_type, path) =>
		path === "localBrowser.state" ? fitted : undefined
	);
	try {
		ui.adopt(page);
		await ui.present({ x: 370, y: 100, width: 1230, height: 820 });
		assert.deepEqual(ui.store.getState().page, fitted);
	} finally {
		ui.dispose();
	}
});
it("a hide during the native viewport read rejects late presentation state", async () => {
	let finish: (value: LocalBrowserState) => void = () => {};
	let reading = false;
	const ui = createLocalBrowserController(async (_type, path) =>
		path === "localBrowser.state"
			? new Promise((resolve) => {
					reading = true;
					finish = resolve;
				})
			: undefined
	);
	try {
		ui.adopt(page);
		const showing = ui.present({ x: 370, y: 100, width: 1230, height: 820 });
		for (let i = 0; i < 20 && !reading; i++) await Promise.resolve();
		assert.ok(reading);
		await ui.present(null);
		finish({ ...page, title: "Late result", viewport: { width: 1230, height: 820 } });
		await showing;
		assert.deepEqual(ui.store.getState().page, page);
	} finally {
		ui.dispose();
	}
});
