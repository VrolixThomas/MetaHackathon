import { join } from "node:path";

export const PRODUCT_NAME = "MuseFocus";
// Keep the established encryption/storage identity while the distribution brand changes.
export const STORAGE_IDENTITY = "MetaHackathon";

/** Explicit caller/test paths win; the new default continues using the existing data directory. */
export function persistentDataPath(current: string, appData: string): string {
	return current === join(appData, PRODUCT_NAME) ? join(appData, STORAGE_IDENTITY) : current;
}
