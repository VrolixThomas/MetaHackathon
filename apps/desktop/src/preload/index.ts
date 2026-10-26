import { contextBridge, ipcRenderer } from "electron";
import type { ElectronAPI } from "../shared/types";

const api: ElectronAPI = {
	trpc: { request: (request) => ipcRenderer.invoke("trpc:request", request) },
};

contextBridge.exposeInMainWorld("electron", api);
