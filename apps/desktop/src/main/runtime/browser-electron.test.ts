import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import type { BrowserWindow } from "electron";
import { ModuleKind, transpileModule } from "typescript";
import * as browserDOM from "./browser-dom";
import type { createElectronBrowserPage } from "./browser-electron";
import * as browserPolicy from "./browser-policy";

// Exercise the actual adapter with an isolated Electron mock, without starting Electron
// or replacing the module globally for other tests. Native acceptance belongs to integration.
function adapterFixture() {
	let renderExists = false;
	let destroyed = false;
	let loading = false;
	let finishLoad = () => {};
	let created = 0;
	const calls: string[] = [];
	const emulations: Array<{ viewSize: { width: number; height: number }; scale: number }> = [];
	const contents = Object.assign(new EventEmitter(), {
		setWebRTCIPHandlingPolicy() {},
		setWindowOpenHandler() {},
		isDestroyed: () => destroyed,
		isLoadingMainFrame: () => loading,
		enableDeviceEmulation(parameters: (typeof emulations)[number]) {
			assert.equal(renderExists, true, "emulation must not precede the native render view");
			calls.push("emulate");
			emulations.push(parameters);
		},
		loadURL() {
			loading = true;
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
		async executeJavaScriptInIsolatedWorld(_world: number, scripts: { code: string }[]) {
			if (scripts[0]?.code === browserDOM.browserSnapshotScript) calls.push("observe");
			return {
				url: "http://127.0.0.1:43210/",
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
		setPermissionRequestHandler() {},
		setPermissionCheckHandler() {},
		setDevicePermissionHandler() {},
		webRequest: { onBeforeRequest() {} },
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
			constructor() {
				created++;
			}
			setVisible() {}
			setBounds() {
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
			if (id === "./browser-dom") return browserDOM;
			if (id === "./browser-policy") return browserPolicy;
			throw new Error(`Unexpected adapter dependency: ${id}`);
		},
	});
	const create = exports["createElectronBrowserPage"] as typeof createElectronBrowserPage;
	return {
		page: create("http://127.0.0.1:43210", () => window as unknown as BrowserWindow),
		contents,
		calls,
		emulations,
		children,
		finishLoad: () => finishLoad(),
		created: () => created,
		loseRenderer() {
			renderExists = false;
			contents.emit("render-process-gone");
		},
	};
}

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
