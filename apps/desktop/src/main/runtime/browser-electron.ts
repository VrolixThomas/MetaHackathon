import { randomUUID } from "node:crypto";
import { type BrowserWindow, WebContentsView, session } from "electron";
import type { BrowserBounds, BrowserViewport } from "../../shared/contracts";
import type { BrowserPage, BrowserSnapshot } from "./browser";
import { browserActionScript, browserSnapshotScript } from "./browser-dom";
import { allowedBrowserURL } from "./browser-policy";

/** Main supplies its window; this is the only page both the reviewer and agent operate. */
export function createElectronBrowserPage(
	origin: string,
	getWindow: () => BrowserWindow
): BrowserPage {
	const isolated = session.fromPartition(`review-browser-${randomUUID()}`);
	isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
	isolated.setPermissionCheckHandler(() => false);
	isolated.setDevicePermissionHandler(() => false);
	isolated.webRequest.onBeforeRequest((details, callback) =>
		callback({ cancel: !allowedBrowserURL(details.url, origin) })
	);
	isolated.on("will-download", (event) => event.preventDefault());
	const view = new WebContentsView({
		webPreferences: {
			session: isolated,
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			webSecurity: true,
			allowRunningInsecureContent: false,
			backgroundThrottling: false,
			disableDialogs: true,
		},
	});
	const contents = view.webContents;
	contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
	contents.setWindowOpenHandler(() => ({ action: "deny" }));
	contents.on("will-navigate", (event, url) => {
		if (!allowedBrowserURL(url, origin)) event.preventDefault();
	});
	contents.on("will-redirect", (event, url) => {
		if (!allowedBrowserURL(url, origin)) event.preventDefault();
	});
	contents.on("will-frame-navigate", (event) => {
		if (!allowedBrowserURL(event.url, origin)) event.preventDefault();
	});
	contents.on("will-attach-webview", (event) => event.preventDefault());
	let owner: BrowserWindow | undefined;
	let closed = false;
	let renderReady = false;
	let viewport: BrowserViewport = { width: 1024, height: 768 };
	let bounds: BrowserBounds | null = null;
	view.setVisible(false);
	const check = () => {
		if (closed || contents.isDestroyed()) throw new Error("Browser page closed");
	};
	const layout = () => {
		check();
		const requested = bounds ?? { x: 0, y: 0, width: viewport.width, height: viewport.height };
		const host = owner?.isDestroyed() === false ? owner.getContentBounds() : undefined;
		const x = Math.max(0, Math.min(requested.x, host?.width ?? 0));
		const y = Math.max(0, Math.min(requested.y, host?.height ?? 0));
		const available = {
			x,
			y,
			width: Math.min(requested.width, host ? Math.max(0, host.width - x) : viewport.width),
			height: Math.min(requested.height, host ? Math.max(0, host.height - y) : viewport.height),
		};
		const scale = Math.min(1, available.width / viewport.width, available.height / viewport.height);
		view.setBounds({
			x: Math.round(available.x),
			y: Math.round(available.y),
			width: Math.max(1, Math.floor(viewport.width * scale)),
			height: Math.max(1, Math.floor(viewport.height * scale)),
		});
		// Electron 40 can crash natively if emulation precedes the first render view.
		if (renderReady)
			contents.enableDeviceEmulation({
				screenPosition: "desktop",
				screenSize: viewport,
				viewPosition: { x: 0, y: 0 },
				deviceScaleFactor: 0,
				viewSize: viewport,
				scale: Math.max(0.01, scale),
			});
		view.setVisible(Boolean(bounds && scale > 0));
	};
	contents.on("did-finish-load", () => {
		if (closed || contents.isDestroyed()) return;
		renderReady = true;
		// Apply the latest pending viewport/bounds before loadURL resolves or any observation.
		layout();
	});
	contents.on("render-process-gone", () => {
		renderReady = false;
	});
	const settle = async () => {
		check();
		if (contents.isLoadingMainFrame())
			await new Promise<void>((resolve, reject) => {
				const done = () => {
					contents.off("did-stop-loading", done);
					contents.off("destroyed", gone);
					resolve();
				};
				const gone = () => {
					contents.off("did-stop-loading", done);
					reject(new Error("Browser page closed"));
				};
				contents.once("did-stop-loading", done);
				contents.once("destroyed", gone);
			});
		check();
		await contents.executeJavaScriptInIsolatedWorld(999, [
			{
				// Hidden views may not paint before the UI publishes its content rectangle.
				code: "new Promise(resolve => setTimeout(resolve, 32))",
			},
		]);
	};
	return {
		async loadURL(url) {
			check();
			if (!allowedBrowserURL(url, origin))
				throw new Error("Navigation outside the active preview is blocked");
			await contents.loadURL(url);
		},
		async snapshot() {
			await settle();
			return (await contents.executeJavaScriptInIsolatedWorld(999, [
				{ code: browserSnapshotScript },
			])) as BrowserSnapshot;
		},
		async act(command, expected) {
			check();
			await contents.executeJavaScriptInIsolatedWorld(
				999,
				[{ code: browserActionScript(command, JSON.stringify(expected)) }],
				true
			);
			await settle();
		},
		async viewport(value) {
			viewport = value;
			layout();
		},
		present(value) {
			check();
			bounds = value;
			if (value && !owner) {
				owner = getWindow();
				if (owner.isDestroyed()) throw new Error("Browser host window closed");
				owner.contentView.addChildView(view);
			}
			layout();
		},
		close() {
			if (closed) return;
			closed = true;
			if (owner && !owner.isDestroyed()) owner.contentView.removeChildView(view);
			if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
			void isolated.clearStorageData().catch(() => undefined);
		},
	};
}
