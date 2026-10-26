import type { ElectronAPI } from "../shared/types";

declare global {
	interface Window {
		electron: ElectronAPI;
	}
}
