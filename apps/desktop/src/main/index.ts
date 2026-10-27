import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, app, safeStorage } from "electron";
import electronUpdater from "electron-updater";
import { openDatabase } from "./db";
import { createElectronBrowserPage } from "./runtime/browser-electron";
import { browserPreviewOpener } from "./runtime/browser-preview";
import { createElectronPreviewPage } from "./runtime/preview-electron";
import {
	disposeRuntime,
	getRuntime,
	initializeBrowser,
	initializeRuntime,
	initializeVoice,
} from "./services";
import { setupTRPCIPC } from "./trpc/ipc-link";
import { startUpdateCheck } from "./updates";

let mainWindow: BrowserWindow | null = null;
const mainDirectory = dirname(fileURLToPath(import.meta.url));
let database: ReturnType<typeof openDatabase> | undefined;
let shuttingDown = false;
let shutdownFinished = false;

function createWindow(): void {
	mainWindow = new BrowserWindow({
		title: "MetaHackathon",
		width: 1440,
		height: 900,
		minWidth: 1000,
		minHeight: 650,
		show: false,
		backgroundColor: "#ffffff",
		webPreferences: {
			preload: join(mainDirectory, "../preload/index.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});

	mainWindow.once("ready-to-show", () => mainWindow?.show());
	mainWindow.on("closed", () => {
		mainWindow = null;
		// The single review window owns microphone, browser and active review jobs.
		app.quit();
	});
	mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());

	const rendererURL = process.env["ELECTRON_RENDERER_URL"];
	if (!app.isPackaged && rendererURL) {
		void mainWindow.loadURL(rendererURL);
	} else {
		void mainWindow.loadFile(join(mainDirectory, "../renderer/index.html"));
	}
}

app
	.whenReady()
	.then(() => {
		database = openDatabase();
		initializeRuntime({
			userDataPath: app.getPath("userData"),
			fixturesPath: app.isPackaged
				? join(process.resourcesPath, "demo")
				: join(mainDirectory, "../../../../fixtures/demo"),
			encryption: safeStorage,
			createPreviewPage: createElectronPreviewPage,
			submissionLedger: database.runtime,
		});
		initializeBrowser({
			openPreview: browserPreviewOpener(getRuntime),
			createPage: (origin) =>
				createElectronBrowserPage(origin, () => {
					if (!mainWindow || mainWindow.isDestroyed())
						throw new Error("Review window is unavailable");
					return mainWindow;
				}),
		});
		const voiceRoot = join(mainDirectory, "../../../../services/voice");
		const voiceCommand = app.isPackaged
			? join(process.resourcesPath, "voice/metahackathon-voice")
			: (process.env["METAHACKATHON_VOICE_PYTHON"] ?? join(voiceRoot, ".venv/bin/python"));
		const voiceScript = join(voiceRoot, "sidecar.py");
		initializeVoice({
			command: voiceCommand,
			args: app.isPackaged ? [] : [voiceScript],
			executableAvailable: () =>
				existsSync(voiceCommand) && (app.isPackaged || existsSync(voiceScript)),
			defaultVoiceId: process.env["ELEVENLABS_VOICE_ID"],
		});
		setupTRPCIPC(() => mainWindow);
		createWindow();
		void startUpdateCheck(app.isPackaged, electronUpdater.autoUpdater, (error) => {
			console.warn(
				"Update check failed:",
				error instanceof Error ? error.message : "Unknown error"
			);
		});

		app.on("activate", () => {
			if (!shuttingDown && BrowserWindow.getAllWindows().length === 0) createWindow();
		});
	})
	.catch((error: unknown) => {
		console.error(
			"Desktop startup failed:",
			error instanceof Error ? error.message : "Unknown error"
		);
		app.quit();
	});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
	if (shutdownFinished) return;
	event.preventDefault();
	if (shuttingDown) return;
	shuttingDown = true;
	void disposeRuntime()
		.catch((error: unknown) => {
			console.warn(
				"Runtime cleanup failed:",
				error instanceof Error ? error.message : "Unknown error"
			);
		})
		.finally(() => {
			shutdownFinished = true;
			app.quit();
		});
});

app.on("will-quit", () => database?.close());
import { existsSync } from "node:fs";
