import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BrowserWindow, app, dialog, safeStorage, shell, systemPreferences } from "electron";
import electronUpdater from "electron-updater";
import { MicrophoneStatusSchema } from "../shared/contracts";
import { EnvConfiguration } from "./config/env";
import { initializeAppConfiguration } from "./config/initialize";
import { openDatabase } from "./db";
import { createElectronBrowserPage } from "./runtime/browser-electron";
import { browserPreviewOpener } from "./runtime/browser-preview";
import { createElectronPreviewPage } from "./runtime/preview-electron";
import {
	disposeRuntime,
	getConfiguration,
	getDiagnostics,
	getRuntime,
	getVoice,
	initializeBrowser,
	initializeConfiguration,
	initializeConfigurationPorts,
	initializeDiagnostics,
	initializeLocalBrowser,
	initializeReviews,
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
		minWidth: 800,
		minHeight: 600,
		show: false,
		backgroundColor: "#0e0e0e",
		webPreferences: {
			preload: join(mainDirectory, "../preload/index.cjs"),
			// Voice can start via the native shortcut while focus is in the guest browser.
			autoplayPolicy: "no-user-gesture-required",
			// Keep controls and voice state repainting beside the native child view.
			backgroundThrottling: false,
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

// Native interception also works when focus is inside an embedded page or a text field.
// Plain Space remains available for typing. The shortcut is app-scoped, never a global key grab.
app.on("web-contents-created", (_event, contents) => {
	contents.on("render-process-gone", (_gone, details) => {
		getDiagnostics()?.record({
			stage: contents === mainWindow?.webContents ? "renderer-exit" : "browser-exit",
			reason: details.reason,
			exitCode: details.exitCode,
		});
	});
	contents.on("before-input-event", (event, input) => {
		if (!mainWindow?.isFocused() || input.type !== "keyDown" || input.isAutoRepeat) return;
		const command = process.platform === "darwin" ? input.meta : input.control;
		if (command && input.shift && input.code === "Space") {
			event.preventDefault();
			mainWindow.webContents.send("voice:shortcut", { phase: "toggle" });
		} else if (input.key === "Escape" && contents !== mainWindow.webContents) {
			// The app renderer handles Escape after dialogs have a chance to consume it.
			mainWindow.webContents.send("voice:shortcut", { phase: "cancel" });
		}
	});
});

app
	.whenReady()
	.then(async () => {
		initializeDiagnostics(app.getPath("userData"));
		database = openDatabase();
		const envPath =
			process.env["METAHACKATHON_ENV_FILE"] ??
			(app.isPackaged
				? join(app.getPath("userData"), ".env")
				: join(mainDirectory, "../../../..", ".env"));
		const bundledEnv = join(process.resourcesPath, ".env");
		const config = await initializeAppConfiguration({
			envPath,
			userDataPath: app.getPath("userData"),
			encryption: safeStorage,
			seedPath: app.isPackaged
				? existsSync(bundledEnv)
					? bundledEnv
					: join(dirname(app.getPath("exe")), "../../..", ".env")
				: undefined,
		}).catch(() => {
			console.warn("Configuration needs attention. Open the local .env file from the app.");
			return new EnvConfiguration(envPath);
		});
		initializeConfiguration(config);
		initializeRuntime({
			userDataPath: app.getPath("userData"),
			fixturesPath: app.isPackaged
				? join(process.resourcesPath, "demo")
				: join(mainDirectory, "../../../../fixtures/demo"),
			encryption: safeStorage,
			credentialStore: config,
			createPreviewPage: createElectronPreviewPage,
			submissionLedger: database.runtime,
		});
		initializeReviews(database.reviews, async () => {
			if (!mainWindow || mainWindow.isDestroyed()) throw new Error("App window is unavailable");
			const selection = await dialog.showOpenDialog(mainWindow, {
				title: "Connect a local GitHub repository",
				properties: ["openDirectory"],
			});
			if (selection.canceled || !selection.filePaths[0]) return null;
			return getRuntime().describeRepository(selection.filePaths[0], AbortSignal.timeout(15_000));
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
		initializeLocalBrowser((origin) =>
			createElectronBrowserPage(origin, () => {
				if (!mainWindow || mainWindow.isDestroyed())
					throw new Error("Review window is unavailable");
				return mainWindow;
			})
		);
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
		initializeConfigurationPorts({
			configuration: getConfiguration,
			microphone: () =>
				process.platform === "darwin"
					? MicrophoneStatusSchema.parse(systemPreferences.getMediaAccessStatus("microphone"))
					: "unknown",
			requestMicrophone: async () => {
				if (process.platform !== "darwin") return "unknown";
				await systemPreferences.askForMediaAccess("microphone");
				return MicrophoneStatusSchema.parse(systemPreferences.getMediaAccessStatus("microphone"));
			},
			openEnv: async (path) => {
				if (process.platform === "darwin") {
					await promisify(execFile)("/usr/bin/open", ["-a", "TextEdit", path]);
					return;
				}
				const error = await shell.openPath(path);
				if (error) throw new Error("Could not open the configuration file");
			},
			reloadVoice: () => getVoice().prepare(),
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
	getDiagnostics()?.record({ stage: "shutdown-start" });
	void disposeRuntime()
		.catch((error: unknown) => {
			console.warn(
				"Runtime cleanup failed:",
				error instanceof Error ? error.message : "Unknown error"
			);
		})
		.finally(() => {
			getDiagnostics()?.record({ stage: "shutdown-complete" });
			shutdownFinished = true;
			app.quit();
		});
});

app.on("will-quit", () => database?.close());
process.on("uncaughtExceptionMonitor", () => getDiagnostics()?.record({ stage: "main-exception" }));
