import { join } from "node:path";
import { PRODUCT_NAME } from "../../shared/brand";

export { PRODUCT_NAME };
// Keep the established encryption/storage identity while the distribution brand changes.
export const STORAGE_IDENTITY = "MetaHackathon";

/** Explicit caller/test paths win; the new default continues using the existing data directory. */
export function persistentDataPath(current: string, appData: string): string {
	return current === join(appData, PRODUCT_NAME) ? join(appData, STORAGE_IDENTITY) : current;
}
