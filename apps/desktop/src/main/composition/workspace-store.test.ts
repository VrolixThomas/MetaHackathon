import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { SavedWorkspaceCanvases } from "./workspace";
import { createWorkspaceStore } from "./workspace-store";

const saved: SavedWorkspaceCanvases = {
	version: 1,
	canvases: [
		{
			closed: false,
			canvas: {
				id: "notes",
				kind: "document",
				title: "Review notes",
				revision: 1,
				markdown: "# Notes\n\nAn inferred explanation.",
				references: [],
				provenance: "agent-draft",
			},
		},
	],
};

it("restores validated draft content from private app storage across store lifetimes", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "muse-canvas-store-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const store = createWorkspaceStore(directory);
	assert.equal(await store.load(), null);
	await store.save(saved);
	assert.deepEqual(await createWorkspaceStore(directory).load(), saved);
	assert.equal((await stat(join(directory, "workspace"))).mode & 0o777, 0o700);
	assert.equal((await stat(join(directory, "workspace", "canvases.json"))).mode & 0o777, 0o600);
	assert.deepEqual(await readdir(join(directory, "workspace")), ["canvases.json"]);
});

it("cancelled or invalid writes retain the last durable draft", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "muse-canvas-store-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const store = createWorkspaceStore(directory);
	await store.save(saved);
	const abort = new AbortController();
	abort.abort();
	await assert.rejects(store.save({ version: 1, canvases: [] }, abort.signal));
	const invalid = structuredClone(saved);
	const draft = invalid.canvases[0];
	assert.ok(draft);
	draft.canvas.revision = 0;
	await assert.rejects(store.save(invalid));
	assert.deepEqual(await store.load(), saved);
	assert.deepEqual(await readdir(join(directory, "workspace")), ["canvases.json"]);
});

it("corrupt persisted data is reported without being silently erased", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "muse-canvas-store-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const store = createWorkspaceStore(directory);
	await store.save(saved);
	const path = join(directory, "workspace", "canvases.json");
	await writeFile(path, '{"version":99,"canvases":[]}');
	await assert.rejects(store.load(), /could not be loaded/);
	assert.equal(await readFile(path, "utf8"), '{"version":99,"canvases":[]}');
});
