import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type SavedWorkspaceCanvases, SavedWorkspaceCanvasesSchema } from "./workspace";

/** Drafts live in private app storage, never in the checked-out repository. */
export function createWorkspaceStore(userDataPath: string) {
	const directory = join(userDataPath, "workspace");
	const path = join(directory, "canvases.json");
	return {
		async load(): Promise<SavedWorkspaceCanvases | null> {
			try {
				if ((await stat(path)).size > 16 * 1024 * 1024)
					throw new Error("Saved canvas data exceeds its storage limit");
				return SavedWorkspaceCanvasesSchema.parse(JSON.parse(await readFile(path, "utf8")));
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
				throw new Error("Saved canvases could not be loaded");
			}
		},
		async save(value: SavedWorkspaceCanvases, signal?: AbortSignal): Promise<void> {
			signal?.throwIfAborted();
			const payload = JSON.stringify(SavedWorkspaceCanvasesSchema.parse(value));
			if (Buffer.byteLength(payload) > 16 * 1024 * 1024)
				throw new Error("Saved canvas data exceeds its storage limit");
			await mkdir(directory, { recursive: true, mode: 0o700 });
			const temporary = join(directory, `canvases-${randomUUID()}.tmp`);
			try {
				await writeFile(temporary, payload, { mode: 0o600 });
				signal?.throwIfAborted();
				await rename(temporary, path);
			} finally {
				await unlink(temporary).catch(() => {});
			}
		},
	};
}
