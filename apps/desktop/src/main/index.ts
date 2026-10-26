import { join } from "node:path";
import { BrowserWindow, app } from "electron";
import { openDatabase } from "./db";
import { setupTRPCIPC } from "./trpc/ipc-link";

let mainWindow: BrowserWindow | null = null;
let database: ReturnType<typeof openDatabase> | undefined;

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

app.whenReady().then(() => {
	database = openDatabase();
	setupTRPCIPC(() => mainWindow);
	createWindow();

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => database?.close());
