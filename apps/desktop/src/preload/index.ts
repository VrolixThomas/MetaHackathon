import { contextBridge, ipcRenderer } from "electron";
import type { ElectronAPI } from "../shared/types";

const api: ElectronAPI = {
	trpc: { request: (request) => ipcRenderer.invoke("trpc:request", request) },
	voiceShortcut: {
		subscribe(listener) {
			const receive = (_event: Electron.IpcRendererEvent, value: unknown) => {
				if (!value || typeof value !== "object" || !("phase" in value)) return;
				const phase = value.phase;
				if (phase === "press" || phase === "release" || phase === "toggle" || phase === "cancel")
					listener({ phase });
			};
			ipcRenderer.on("voice:shortcut", receive);
			return () => ipcRenderer.removeListener("voice:shortcut", receive);
		},
	},
};

contextBridge.exposeInMainWorld("electron", api);
