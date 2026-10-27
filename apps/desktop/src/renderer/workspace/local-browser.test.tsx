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

it("changes viewport with latest real bounds and displays only the returned viewport", async () => {
	const calls: Array<{ path: string; input: unknown }> = [];
	let current = page;
	const controller = createLocalBrowserController(async (_type, path, input) => {
		calls.push({ path, input });
		if (path === "localBrowser.present") {
			const value = input as { viewport?: { width: number; height: number } };
			if (value.viewport) current = { ...current, viewport: value.viewport };
		}
		return path === "localBrowser.open" || path === "localBrowser.state" ? current : undefined;
	});
	try {
		await controller.open(page.url);
		await controller.present({ x: 600, y: 80, width: 440, height: 650 });
		const actual = { x: 610, y: 104, width: 430, height: 620 };
		await controller.setViewport("phone", actual);
		assert.deepEqual(calls.filter((call) => call.path === "localBrowser.present").at(-1)?.input, {
			bounds: actual,
			viewport: { width: 390, height: 844 },
		});
		assert.deepEqual(controller.store.getState().page?.viewport, { width: 390, height: 844 });
		await controller.setViewport("desktop");
		assert.deepEqual(calls.filter((call) => call.path === "localBrowser.present").at(-1)?.input, {
			bounds: actual,
			viewport: { width: 1024, height: 768 },
		});
		assert.equal(controller.store.getState().page?.viewport.width, 1024);
	} finally {
		controller.dispose();
	}
});

it("a queued viewport change cannot reveal a pane hidden while presentation was pending", async () => {
	const calls: Array<{ bounds: unknown; viewport?: { width: number; height: number } }> = [];
	let finish = () => {};
	let current = page;
	const controller = createLocalBrowserController(async (_type, path, input) => {
		if (path === "localBrowser.present") {
			const value = input as { bounds: unknown; viewport?: { width: number; height: number } };
			calls.push(value);
			if (calls.length === 1)
				await new Promise<void>((resolve) => {
					finish = resolve;
				});
			if (value.viewport) current = { ...current, viewport: value.viewport };
		}
		return path === "localBrowser.open" || path === "localBrowser.state" ? current : undefined;
	});
	try {
		await controller.open(page.url);
		const presenting = controller.present({ x: 500, y: 100, width: 500, height: 600 });
		await Promise.resolve();
		await Promise.resolve();
		const resizing = controller.setViewport("phone");
		const hidden = controller.present(null);
		finish();
		await Promise.all([presenting, resizing, hidden]);
		assert.equal(calls.find((call) => call.viewport)?.bounds, null);
		assert.equal(calls.at(-1)?.bounds, null);
	} finally {
		controller.dispose();
	}
});

it("reports malformed navigation addresses without calling IPC or losing the current page", async () => {
	const calls: string[] = [];
	const controller = createLocalBrowserController(async (_type, path) => {
		calls.push(path);
		return path === "localBrowser.open" ? page : undefined;
	});
	try {
		await controller.open(page.url);
		calls.length = 0;
		for (const url of [
			"not an address",
			"http://",
			"https://example.com",
			"http://user:secret@localhost",
		]) {
			await controller.command({ kind: "navigate", url });
			assert.match(controller.store.getState().error, /localhost HTTP address/);
			assert.deepEqual(controller.store.getState().page, page);
		}
		assert.deepEqual(calls, []);
	} finally {
		controller.dispose();
	}
});
