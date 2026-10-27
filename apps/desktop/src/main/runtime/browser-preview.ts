import { randomUUID } from "node:crypto";
import type { BrowserServiceOptions } from "./browser";
import type { RuntimeService } from "./service";

/** Adapts the accepted owned preview runner; caller closes browsers BEFORE disposing runtime. */
export function browserPreviewOpener(
	getRuntime: () => RuntimeService
): BrowserServiceOptions["openPreview"] {
	return async (command, signal) => {
		signal.throwIfAborted();
		const runtime = getRuntime();
		const requestId = `browser-preview:${randomUUID()}`;
		const abort = () => runtime.cancel(requestId);
		signal.addEventListener("abort", abort, { once: true });
		try {
			const preview = await runtime.startPreview(
				requestId,
				command.prId,
				"desktop",
				command.revision
			);
			if (signal.aborted) {
				await runtime.stopPreview(preview.id);
				signal.throwIfAborted();
			}
			return {
				prId: preview.prId,
				repository: runtime.getPrepared(command.prId).pr.repository,
				revision: preview.revision,
				commitSha: preview.commitSha,
				url: preview.url,
				close: () => runtime.stopPreview(preview.id),
			};
		} finally {
			signal.removeEventListener("abort", abort);
		}
	};
}
