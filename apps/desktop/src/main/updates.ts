export interface UpdateClient {
	on(event: "error", listener: (error: Error) => void): unknown;
	checkForUpdatesAndNotify(): Promise<unknown>;
}

/** One startup check; update failures must not prevent the review workspace from opening. */
export async function startUpdateCheck(
	isPackaged: boolean,
	updater: UpdateClient,
	reportError: (error: unknown) => void
): Promise<void> {
	if (!isPackaged) return;
	updater.on("error", reportError);
	try {
		await updater.checkForUpdatesAndNotify();
	} catch (error) {
		reportError(error);
	}
}
