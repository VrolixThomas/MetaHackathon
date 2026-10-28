import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as timers from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import type { BrowserWindow } from "electron";
import { ModuleKind, transpileModule } from "typescript";
import * as browserDOM from "./browser-dom";
import type { ElectronBrowserPageOptions, createElectronBrowserPage } from "./browser-electron";
import * as browserPolicy from "./browser-policy";

// Exercise the actual adapter with an isolated Electron mock, without starting Electron
// or replacing the module globally for other tests. Native acceptance belongs to integration.
function adapterFixture(options?: ElectronBrowserPageOptions) {
	let renderExists = false;
	let destroyed = false;
	let loading = false;
	let finishLoad = () => {};
	let afterAction: (() => void) | undefined;
	let created = 0;
	let visible = false;
	let nativeBounds = { x: 0, y: 0, width: 0, height: 0 };
	let preferences: Record<string, unknown> = {};
	let requestPermission = (
		_contents: unknown,
		_permission: string,
		_done: (v: boolean) => void
	) => {};
	let checkPermission = () => true;
	let checkDevice = () => true;
	let request = (_details: { url: string }, _done: (v: { cancel: boolean }) => void) => {};
	let popup = () => ({ action: "allow" });
	const entries: string[] = [];
	let activeIndex = -1;
	const calls: string[] = [];
	const emulations: Array<{ viewSize: { width: number; height: number }; scale: number }> = [];
	const contents = Object.assign(new EventEmitter(), {
		setWebRTCIPHandlingPolicy() {},
		setWindowOpenHandler(handler: typeof popup) {
			popup = handler;
		},
		isDestroyed: () => destroyed,
		isLoadingMainFrame: () => loading,
		getURL: () => entries[activeIndex] ?? "about:blank",
		navigationHistory: {
			canGoBack: () => activeIndex > 0,
			canGoForward: () => activeIndex >= 0 && activeIndex < entries.length - 1,
			goBack() {
				calls.push("back");
				activeIndex--;
				void contents.loadURL();
			},
			goForward() {
				calls.push("forward");
				activeIndex++;
				void contents.loadURL();
			},
		},
		reload() {
			calls.push("reload");
			void contents.loadURL();
		},
		enableDeviceEmulation(parameters: (typeof emulations)[number]) {
			assert.equal(renderExists, true, "emulation must not precede the native render view");
			calls.push("emulate");
			emulations.push(parameters);
		},
		loadURL(url?: string) {
			if (url) {
				entries.splice(activeIndex + 1);
				entries.push(url);
				activeIndex = entries.length - 1;
			}
			loading = true;
			contents.emit("did-start-loading");
			return new Promise<void>((resolve) => {
				finishLoad = () => {
					renderExists = true;
					loading = false;
					calls.push("loaded");
					contents.emit("did-finish-load");
					contents.emit("did-stop-loading");
					resolve();
				};
			});
		},
		async executeJavaScriptInIsolatedWorld(
			_world: number,
			scripts: { code: string }[]
		): Promise<unknown> {
			const code = scripts[0]?.code ?? "";
			if (code.includes("new Promise")) {
				// Model a renderer timer lost when form navigation destroys its document.
				calls.push("renderer-timer");
				return new Promise(() => {});
			}
			if (code === browserDOM.browserSnapshotScript) calls.push("observe");
			else {
				calls.push("act");
				afterAction?.();
			}
			return {
				url: contents.getURL(),
				title: "Mock page",
				text: "",
				elements: [],
				scroll: { x: 0, y: 0 },
			};
		},
		close() {
			destroyed = true;
			contents.emit("destroyed");
		},
	});
	const isolated = Object.assign(new EventEmitter(), {
		setPermissionRequestHandler(handler: typeof requestPermission) {
			requestPermission = handler;
		},
		setPermissionCheckHandler(handler: typeof checkPermission) {
			checkPermission = handler;
		},
		setDevicePermissionHandler(handler: typeof checkDevice) {
			checkDevice = handler;
		},
		webRequest: {
			onBeforeRequest(handler: typeof request) {
				request = handler;
			},
		},
		async clearStorageData() {},
	});
	const children: unknown[] = [];
	const window = {
		isDestroyed: () => false,
		getContentBounds: () => ({ width: 1200, height: 900 }),
		contentView: {
			addChildView(view: unknown) {
				children.push(view);
			},
			removeChildView() {
				children.pop();
			},
		},
	};
	const electron = {
		session: { fromPartition: () => isolated },
		WebContentsView: class {
			webContents = contents;
			constructor(options: { webPreferences: Record<string, unknown> }) {
				created++;
				preferences = options.webPreferences;
			}
			setVisible(value: boolean) {
				visible = value;
				calls.push(value ? "show" : "hide");
			}
			getVisible() {
				return visible;
			}
			getBounds() {
				return nativeBounds;
			}
			setBounds(value: typeof nativeBounds) {
				nativeBounds = value;
				calls.push("bounds");
			}
		},
	};
	const output = transpileModule(
		readFileSync(new URL("./browser-electron.ts", import.meta.url), "utf8"),
		{ compilerOptions: { module: ModuleKind.CommonJS } }
	).outputText;
	const exports: Record<string, unknown> = {};
	runInNewContext(output, {
		exports,
		require: (id: string) => {
			if (id === "electron") return electron;
			if (id === "node:crypto") return { randomUUID: () => "test-partition" };
			if (id === "node:timers") return timers;
			if (id === "./browser-dom") return browserDOM;
			if (id === "./browser-policy") return browserPolicy;
			throw new Error(`Unexpected adapter dependency: ${id}`);
		},
	});
	const create = exports["createElectronBrowserPage"] as typeof createElectronBrowserPage;
	return {
		page: create("http://127.0.0.1:43210", () => window as unknown as BrowserWindow, options),
		contents,
		calls,
		emulations,
		children,
		finishLoad: () => finishLoad(),
		afterAction(callback: () => void) {
			afterAction = callback;
		},
		created: () => created,
		visible: () => visible,
		nativeBounds: () => nativeBounds,
		preferences: () => preferences,
		requestAllowed(url: string) {
			let allowed: boolean | undefined;
			request({ url }, ({ cancel }) => {
				allowed = !cancel;
			});
			return allowed;
		},
		navigationAllowed(eventName: string, url: string) {
			let allowed = true;
			contents.emit(
				eventName,
				{
					url,
					preventDefault: () => {
						allowed = false;
					},
				},
				url
			);
			return allowed;
		},
		permissionsDenied() {
			const responses: boolean[] = [];
			for (const permission of ["media", "microphone", "camera", "geolocation", "notifications"])
				requestPermission(contents, permission, (allowed) => responses.push(allowed));
			return responses.every((allowed) => !allowed) && !checkPermission() && !checkDevice();
		},
		popup: () => popup(),
		downloadAllowed() {
			let allowed = true;
			isolated.emit("will-download", {
				preventDefault: () => {
					allowed = false;
				},
			});
			return allowed;
		},
		loseRenderer() {
			renderExists = false;
			contents.emit("render-process-gone");
		},
	};
}

for (const navigationPolicy of [undefined, "preview", "workspace"] as const)
	test(`native policy gates requests, navigation, redirects and frames: ${navigationPolicy ?? "default"}`, async () => {
		const f = adapterFixture(navigationPolicy ? { navigationPolicy } : undefined);
		const permitted = ["http://127.0.0.1:43210/page"];
		const workspaceOnly = [
			"https://example.com/page",
			"https://cdn.example.net/assets/font.woff2",
			"https://other.example.org/app.js",
			"http://localhost:3000/",
			"http://127.0.0.1:4567/",
			"http://[::1]:8080/",
		];
		const denied = [
			"http://example.com/",
			"http://192.168.1.5/",
			"http://localhost.attacker.example/",
			"http://user:pass@127.0.0.1:43210/",
			"https://user:pass@example.com/",
			"file:///etc/passwd",
			"javascript:alert(1)",
			"data:text/html,hello",
			"blob:https://example.com/fake",
			"about:blank",
			"chrome://settings",
			"devtools://devtools/",
			"electron://app/",
			"metahackathon://app/",
			"ftp://example.com/",
			"not a url",
		];
		try {
			for (const url of [...permitted, ...workspaceOnly, ...denied]) {
				const allowed =
					permitted.includes(url) ||
					(navigationPolicy === "workspace" && workspaceOnly.includes(url));
				assert.equal(f.requestAllowed(url), allowed, `resource: ${url}`);
				for (const event of ["will-navigate", "will-redirect", "will-frame-navigate"])
					assert.equal(f.navigationAllowed(event, url), allowed, `${event}: ${url}`);
				if (!allowed) await assert.rejects(f.page.loadURL(url), /blocked/);
			}
			const prefs = f.preferences();
			assert.equal(prefs["sandbox"], true);
			assert.equal(prefs["contextIsolation"], true);
			assert.equal(prefs["nodeIntegration"], false);
			assert.equal(prefs["webSecurity"], true);
			assert.equal(prefs["allowRunningInsecureContent"], false);
			assert.equal("preload" in prefs, false);
			assert.equal(f.permissionsDenied(), true);
			assert.equal(f.downloadAllowed(), false);
			assert.equal(f.popup().action, "deny");
			assert.equal(f.navigationAllowed("will-attach-webview", permitted[0] ?? ""), false);
			assert.equal(f.created(), 1);
		} finally {
			f.page.close();
		}
	});

test("workspace cross-origin history, actions and observations use one attached native page", async () => {
	const f = adapterFixture({ navigationPolicy: "workspace" });
	f.page.present({ x: 10, y: 20, width: 1000, height: 800 });
	try {
		for (const url of [
			"https://first.example/page",
			"https://second.example/page",
			"http://localhost:3000/local",
		]) {
			const loading = f.page.loadURL(url);
			f.finishLoad();
			await loading;
			assert.equal((await f.page.snapshot()).url, url);
		}
		assert.equal(f.page.history?.().canGoBack, true);
		const back = f.page.back?.();
		f.finishLoad();
		await back;
		assert.equal((await f.page.snapshot()).url, "https://second.example/page");
		assert.equal(f.page.history?.().canGoForward, true);
		const forward = f.page.forward?.();
		f.finishLoad();
		await forward;
		assert.equal((await f.page.snapshot()).url, "http://localhost:3000/local");
		await f.page.act(
			{ kind: "scroll", sessionId: "s", requestId: "r", browserId: "b", y: 10 },
			await f.page.snapshot()
		);
		assert.equal(f.calls.filter((call) => call === "act").length, 1);
		assert.equal(f.created(), 1);
		assert.equal(f.children.length, 1);
	} finally {
		f.page.close();
	}
});

test("presentation reports clamped native bounds and hides without replacing the page", async () => {
	const f = adapterFixture({ navigationPolicy: "workspace" });
	assert.ok(f.page.presentation);
	assert.equal(f.page.presentation().visible, false);
	assert.equal(f.page.presentation().bounds, null);
	const bounds = { x: 1100, y: 800, width: 400, height: 300 };
	f.page.present(bounds);
	const shown = f.page.presentation();
	assert.equal(shown.visible, true);
	assert.equal(JSON.stringify(shown.bounds), JSON.stringify(f.nativeBounds()));
	assert.ok(shown.bounds);
	assert.ok(shown.bounds.x + shown.bounds.width <= 1200);
	assert.ok(shown.bounds.y + shown.bounds.height <= 900);
	shown.bounds.x = -1;
	bounds.x = -2;
	assert.equal(f.page.presentation().bounds?.x, 1100, "reported bounds are not mutable aliases");
	f.page.present(null);
	assert.equal(f.page.presentation().visible, false);
	assert.equal(f.page.presentation().bounds, null);
	await f.page.viewport({ width: 390, height: 844 });
	assert.equal(f.page.presentation().visible, false);
	f.page.present({ x: 0, y: 0, width: 0, height: 0 });
	assert.equal(f.page.presentation().visible, false);
	assert.equal(f.page.presentation().bounds, null);
	assert.equal(f.created(), 1);
	f.page.close();
	assert.equal(f.page.presentation().visible, false);
	assert.equal(f.page.presentation().bounds, null);
});

test("native adapter defers emulation until load and applies the latest viewport before observing", async () => {
	const f = adapterFixture();
	await f.page.viewport({ width: 1024, height: 768 });
	f.page.present({ x: 250, y: 80, width: 850, height: 650 });
	assert.equal(f.emulations.length, 0);
	assert.ok(f.calls.includes("bounds"));
	const loading = f.page.loadURL("http://127.0.0.1:43210/");
	await f.page.viewport({ width: 390, height: 844 });
	assert.equal(f.emulations.length, 0);
	f.finishLoad();
	await loading;
	await f.page.snapshot();
	assert.equal(f.emulations[0]?.viewSize.width, 390);
	assert.equal(f.emulations[0]?.viewSize.height, 844);
	assert.equal(f.emulations[0]?.scale, 650 / 844);
	assert.ok(f.calls.indexOf("loaded") < f.calls.indexOf("emulate"));
	assert.ok(f.calls.indexOf("emulate") < f.calls.indexOf("observe"));
	await f.page.viewport({ width: 1024, height: 768 });
	assert.equal(f.emulations.at(-1)?.viewSize.width, 1024);
	assert.equal(f.created(), 1);
	assert.equal(f.children.length, 1);
	f.loseRenderer();
	const count = f.emulations.length;
	await f.page.viewport({ width: 390, height: 844 });
	assert.equal(f.emulations.length, count);
	const reloading = f.page.loadURL("http://127.0.0.1:43210/cart");
	f.finishLoad();
	await reloading;
	assert.equal(f.emulations.length, count + 1);
	f.page.close();
	f.contents.emit("did-finish-load");
	assert.equal(f.emulations.length, count + 1);
	assert.equal(f.children.length, 0);
});

test("form navigation starting after click acknowledgement settles in main before observation", async () => {
	const f = adapterFixture();
	const opening = f.page.loadURL("http://127.0.0.1:43210/");
	f.finishLoad();
	await opening;
	f.calls.length = 0;
	let navigation: Promise<void> | undefined;
	f.afterAction(() => {
		navigation = (async () => {
			await delay(5); // Evaluation acknowledged while isLoadingMainFrame is still false.
			const loading = f.contents.loadURL();
			await delay(60); // Navigation outlasts the old renderer's 32 ms timer.
			f.finishLoad();
			await loading;
		})();
	});
	const command = {
		kind: "click",
		sessionId: "test",
		requestId: "click",
		browserId: "page",
		elementId: "apply",
		observationSequence: 1,
	} as const;
	const expected = {
		url: "http://127.0.0.1:43210/",
		title: "Mock page",
		text: "",
		elements: [],
		scroll: { x: 0, y: 0 },
	};
	let deadline: ReturnType<typeof timers.setTimeout> | undefined;
	try {
		await Promise.race([
			f.page.act(command, expected).then(() => f.page.snapshot()),
			new Promise<never>((_resolve, reject) => {
				deadline = timers.setTimeout(
					() => reject(new Error("Action waited on a destroyed renderer timer")),
					1000
				);
			}),
		]);
		assert.equal(f.calls.filter((call) => call === "act").length, 1);
		assert.ok(f.calls.indexOf("loaded") < f.calls.indexOf("observe"));
		assert.ok(!f.calls.includes("renderer-timer"));
		assert.equal(f.contents.listenerCount("did-start-loading"), 0);
		assert.equal(f.contents.listenerCount("did-stop-loading"), 0);
		assert.equal(f.contents.listenerCount("destroyed"), 0);
	} finally {
		timers.clearTimeout(deadline);
		await navigation;
		f.page.close();
	}
});

test("closing during the main-process settle wait rejects and removes listeners", async () => {
	const f = adapterFixture();
	const observing = assert.rejects(f.page.snapshot(), /Browser page closed/);
	f.page.close();
	await observing;
	assert.equal(f.contents.listenerCount("did-start-loading"), 0);
	assert.equal(f.contents.listenerCount("did-stop-loading"), 0);
	assert.equal(f.contents.listenerCount("destroyed"), 0);
});

test("native history capabilities, back, forward and reload use the same page and await loading", async () => {
	const f = adapterFixture();
	const { history, back, forward, reload } = f.page;
	assert.ok(history && back && forward && reload);
	assert.equal(history().canGoBack, false);
	assert.equal(history().canGoForward, false);
	await back();
	await forward();
	assert.ok(!f.calls.includes("back") && !f.calls.includes("forward"));
	for (const path of ["first", "second"]) {
		const load = f.page.loadURL(`http://127.0.0.1:43210/${path}`);
		f.finishLoad();
		await load;
	}
	assert.equal(history().canGoBack, true);
	assert.equal(history().canGoForward, false);
	let settled = false;
	const goingBack = back().then(() => {
		settled = true;
	});
	await delay(40);
	assert.equal(settled, false);
	f.finishLoad();
	await goingBack;
	assert.equal(f.contents.getURL(), "http://127.0.0.1:43210/first");
	assert.equal(history().canGoBack, false);
	assert.equal(history().canGoForward, true);
	const goingForward = forward();
	f.finishLoad();
	await goingForward;
	assert.equal(f.contents.getURL(), "http://127.0.0.1:43210/second");
	const reloading = reload();
	f.finishLoad();
	await reloading;
	assert.equal(f.contents.getURL(), "http://127.0.0.1:43210/second");
	assert.equal(history().canGoBack, true);
	assert.equal(history().canGoForward, false);
	assert.equal(f.created(), 1);
	assert.deepEqual(
		f.calls.filter((call) => ["back", "forward", "reload"].includes(call)),
		["back", "forward", "reload"]
	);
	await assert.rejects(f.page.loadURL("https://outside.example/"), /outside/);
	f.page.close();
	assert.throws(history, /closed/);
	await assert.rejects(back(), /closed/);
	await assert.rejects(forward(), /closed/);
	await assert.rejects(reload(), /closed/);
});

test("closing during native history navigation rejects its pending settle wait", async () => {
	const f = adapterFixture();
	assert.ok(f.page.back);
	for (const path of ["first", "second"]) {
		const load = f.page.loadURL(`http://127.0.0.1:43210/${path}`);
		f.finishLoad();
		await load;
	}
	const stopped = assert.rejects(f.page.back(), /closed/);
	f.page.close();
	await stopped;
	assert.equal(f.contents.listenerCount("did-start-loading"), 0);
	assert.equal(f.contents.listenerCount("did-stop-loading"), 0);
	assert.equal(f.contents.listenerCount("destroyed"), 0);
});

test("hide precedes native layout changes and preserves the hidden viewport and document", async () => {
	const f = adapterFixture();
	const bounds = { x: 400, y: 100, width: 390, height: 700 };
	await f.page.viewport({ width: 390, height: 844 });
	f.page.present(bounds);
	const loading = f.page.loadURL("http://127.0.0.1:43210/current");
	f.finishLoad();
	await loading;
	assert.equal(f.visible(), true);
	f.calls.length = 0;
	f.page.present(null);
	assert.deepEqual(f.calls, ["hide", "bounds", "emulate", "hide"]);
	assert.equal(f.visible(), false);
	assert.equal(f.emulations.at(-1)?.viewSize.width, 390);
	assert.equal(f.emulations.at(-1)?.viewSize.height, 844);

	// Explicit viewport updates and late load events must also remain hidden.
	f.calls.length = 0;
	await f.page.viewport({ width: 1024, height: 768 });
	assert.deepEqual(f.calls, ["hide", "bounds", "emulate", "hide"]);
	f.calls.length = 0;
	f.contents.emit("did-finish-load");
	assert.deepEqual(f.calls, ["hide", "bounds", "emulate", "hide"]);
	assert.equal(f.visible(), false);
	assert.equal(f.emulations.at(-1)?.viewSize.width, 1024);
	assert.equal(f.emulations.at(-1)?.viewSize.height, 768);

	f.calls.length = 0;
	f.page.present(bounds);
	assert.deepEqual(f.calls, ["bounds", "emulate", "show"]);
	assert.equal(f.visible(), true);
	assert.equal(f.emulations.at(-1)?.viewSize.width, 1024);
	assert.equal(f.emulations.at(-1)?.viewSize.height, 768);
	assert.equal(f.contents.getURL(), "http://127.0.0.1:43210/current");
	assert.equal(f.created(), 1);
	f.page.close();
});
