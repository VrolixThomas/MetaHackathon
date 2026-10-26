import { join } from "node:path";
import { BrowserWindow, app, safeStorage } from "electron";
import electronUpdater from "electron-updater";
import { openDatabase } from "./db";
import { createElectronPreviewPage } from "./runtime/preview-electron";
import { disposeRuntime, initializeRuntime } from "./services";
import { setupTRPCIPC } from "./trpc/ipc-link";
import { startUpdateCheck } from "./updates";

let mainWindow: BrowserWindow | null = null;
let database: ReturnType<typeof openDatabase> | undefined;
let shuttingDown = false;
let shutdownFinished = false;

function createWindow(): void {
	mainWindow = new BrowserWindow({
		title: "MetaHackathon",
		width: 1200,
		height: 800,
		show: false,
		backgroundColor: "#ffffff",
		webPreferences: {
			preload: join(__dirname, "../preload/index.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});

	mainWindow.once("ready-to-show", () => mainWindow?.show());
	mainWindow.on("closed", () => {
		mainWindow = null;
	});
	mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());

	const rendererURL = process.env["ELECTRON_RENDERER_URL"];
	if (!app.isPackaged && rendererURL) {
		void mainWindow.loadURL(rendererURL);
	} else {
		void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
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
				: join(__dirname, "../../../../fixtures/demo"),
			encryption: safeStorage,
			createPreviewPage: createElectronPreviewPage,
			submissionLedger: database.runtime,
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
