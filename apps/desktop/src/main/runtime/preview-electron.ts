import { BrowserWindow, session } from "electron";
import type { PreviewPage } from "./preview";

/** Isolated preview renderer. It has no preload, credentials, Node, or persistent cookies. */
export function createElectronPreviewPage(): PreviewPage {
	const previewSession = session.fromPartition(`preview-${crypto.randomUUID()}`);
	previewSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
	const window = new BrowserWindow({
		show: false,
		useContentSize: true,
		webPreferences: {
			session: previewSession,
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
		},
	});
	window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	let allowedURL: string | undefined;
	window.webContents.on("will-navigate", (event, url) => {
		if (url !== allowedURL) event.preventDefault();
	});
	return {
		async loadURL(url) {
			const target = new URL(url);
			if (
				target.protocol !== "http:" ||
				target.hostname !== "127.0.0.1" ||
				target.pathname !== "/checkout"
			)
				throw new Error("Invalid preview URL");
			allowedURL = url;
			await window.loadURL(url);
		},
		async setViewport(width, height) {
			window.setContentSize(width, height);
		},
		async measure() {
			return window.webContents.executeJavaScript(`(async () => {
				await new Promise(requestAnimationFrame);
				await new Promise(requestAnimationFrame);
				return Array.from(document.querySelectorAll('[data-preview-marker]')).map(element => {
					const r = element.getBoundingClientRect();
					return { id: element.getAttribute('data-preview-marker'), x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height };
				});
			})()`);
		},
		close() {
			if (!window.isDestroyed()) window.destroy();
		},
	};
}
