import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	chmod,
	link,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type TestContext, test } from "node:test";
import type { CodingProviderSettings } from "../../../shared/contracts";
import type { CodingTaskInput } from "../../agent/coding-worker";
import { pinCodingProvider } from "./pin";

const meta = { provider: "meta-api" as const, musePath: null };
const muse = { provider: "muse-code" as const, musePath: "/controlled/bin/muse" };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function fixture(t: TestContext) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "coding-provider-pin-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const worktreePath = join(root, "worktree");
	const parent = join(root, "private");
	await mkdir(worktreePath, { mode: 0o700 });
	await mkdir(parent, { mode: 0o700 });
	const input: CodingTaskInput = {
		jobId: "job-controlled",
		ticket: null,
		repository: "owner/project",
		worktreePath,
		checkpointPath: join(parent, "checkpoint.json"),
		brief: "CONTROLLED private prompt, must never appear in provider marker",
	};
	const marker = join(parent, `.coding-provider-${hash(input.jobId)}.json`);
	const session = `${input.checkpointPath}.muse-code.json`;
	const pin = (settings: CodingProviderSettings = muse, signal = new AbortController().signal) =>
		pinCodingProvider(input, async () => settings, signal);
	return { root, input, marker, parent, session, pin };
}
function checkpoint(input: CodingTaskInput) {
	return {
		version: 1,
		jobId: input.jobId,
		taskKey: hash({
			jobId: input.jobId,
			ticketId: input.ticket?.id ?? null,
			repository: input.repository,
			worktreePath: resolve(input.worktreePath),
			brief: input.brief,
		}),
		contextKey: hash({ decision: "", feedback: "" }),
		history: [{ role: "user", content: input.brief }],
		contextStartIndex: 0,
		rounds: 1,
		pendingTool: null,
		result: null,
		updatedAt: "2026-10-31T14:00:00Z",
	};
}
const privateJSON = (path: string, value: unknown) =>
	writeFile(path, JSON.stringify(value), { mode: 0o600 });

test("new jobs atomically pin provider/path privately; changed preferences cannot override", async (t) => {
	const f = await fixture(t);
	const pin = await f.pin();
	assert.deepEqual(pin.settings, muse);
	assert.equal(pin.worktree.path, await realpath(f.input.worktreePath));
	assert.equal(pin.checkpointPath, f.input.checkpointPath);
	assert.equal((await lstat(f.marker)).mode & 0o777, 0o600);
	assert.equal((await lstat(f.marker)).nlink, 1);
	const bytes = await readFile(f.marker, "utf8");
	assert.ok(!bytes.includes(f.input.brief));
	assert.doesNotMatch(bytes, /history|TOKEN|API_KEY|sessionId|account/);
	assert.deepEqual(
		await pinCodingProvider(
			f.input,
			async () => {
				throw new Error("Preference reader must not run");
			},
			new AbortController().signal
		),
		pin
	);
	assert.deepEqual(await f.pin({ ...muse, musePath: "/other/bin/muse" }), pin);
	assert.equal(await readFile(f.marker, "utf8"), bytes);
	assert.deepEqual(await readdir(f.parent), [f.marker.split("/").at(-1)]);
});

test("valid old unmarked Meta history remains Meta without reading the new preference", async (t) => {
	const f = await fixture(t);
	const legacy = checkpoint(f.input);
	await privateJSON(f.input.checkpointPath, legacy);
	const before = await readFile(f.input.checkpointPath, "utf8");
	const pin = await pinCodingProvider(
		f.input,
		async () => {
			throw new Error("New Muse preference is irrelevant");
		},
		new AbortController().signal
	);
	assert.deepEqual(pin.settings, meta);
	assert.equal(await readFile(f.input.checkpointPath, "utf8"), before);
	assert.deepEqual((await f.pin()).settings, meta);
});

test("identity pins reject new repo, brief, checkpoint filename, replaced worktree or parent", async (t) => {
	const f = await fixture(t);
	await f.pin();
	for (const change of [
		{ repository: "owner/other" },
		{ brief: "Different task" },
		{ checkpointPath: join(f.parent, "other-checkpoint.json") },
	])
		await assert.rejects(
			pinCodingProvider({ ...f.input, ...change }, async () => meta, new AbortController().signal),
			/identity/
		);
	await rename(f.input.worktreePath, join(f.root, "retired-worktree"));
	await mkdir(f.input.worktreePath);
	await assert.rejects(f.pin(), /identity/);
	await rename(f.parent, join(f.root, "retired-parent"));
	await mkdir(f.parent);
	await writeFile(
		f.marker,
		await readFile(join(f.root, "retired-parent", f.marker.split("/").at(-1) ?? "")),
		{ mode: 0o600 }
	);
	await assert.rejects(f.pin(), /identity/);
});

test("PR-fix jobs share a parent while keeping independent provider selections", async (t) => {
	const f = await fixture(t);
	const first = await f.pin();
	const second = {
		...f.input,
		jobId: "second-job",
		checkpointPath: join(f.parent, "second.checkpoint.json"),
	};
	const other = await pinCodingProvider(second, async () => meta, new AbortController().signal);
	assert.deepEqual(first.settings, muse);
	assert.deepEqual(other.settings, meta);
	assert.equal((await readdir(f.parent)).length, 2);
});

test("old checkpoint mismatches and unknown session identities never select a new provider", async (t) => {
	for (const value of [
		{ ...checkpoint({ ...(await fixture(t)).input }), jobId: "wrong-job" },
		{ ...checkpoint({ ...(await fixture(t)).input }), taskKey: "a".repeat(64) },
		{ version: 1, sessionId: "unknown-cli-session" },
	]) {
		const f = await fixture(t);
		await privateJSON(f.input.checkpointPath, value);
		await assert.rejects(f.pin(), /identity|ambiguous/);
		assert.equal((await readdir(f.parent)).length, 1, "No pin is written on ambiguity");
	}
	const f = await fixture(t);
	await privateJSON(f.session, { sessionId: "unmarked" });
	await assert.rejects(f.pin(), /ambiguous/);
	const locked = await fixture(t);
	await writeFile(`${locked.session}.lock`, "opaque PID/inode claim", { mode: 0o600 });
	await assert.rejects(locked.pin(), /ambiguous/);
});

test("a pinned Muse job rejects Meta history; pinned Meta rejects Muse session state", async (t) => {
	const a = await fixture(t);
	await a.pin();
	await privateJSON(a.input.checkpointPath, checkpoint(a.input));
	await assert.rejects(a.pin(), /ambiguous/);
	const b = await fixture(t);
	await b.pin(meta);
	await privateJSON(b.session, { sessionId: "unexpected" });
	await assert.rejects(b.pin(), /ambiguous/);
	const c = await fixture(t);
	await privateJSON(c.input.checkpointPath, checkpoint(c.input));
	await privateJSON(c.session, { sessionId: "mixed" });
	await assert.rejects(c.pin(), /ambiguous/);
});

test("sidecar and checkpoint reads reject symlinks, hardlinks, public modes, oversized or corrupt data", async (t) => {
	for (const mode of ["symlink", "hardlink", "public", "oversized", "corrupt"] as const) {
		const f = await fixture(t);
		await f.pin();
		if (mode === "symlink") {
			await rename(f.marker, join(f.parent, "target"));
			await symlink(join(f.parent, "target"), f.marker);
		}
		if (mode === "hardlink") await link(f.marker, join(f.parent, "linked"));
		if (mode === "public") await chmod(f.marker, 0o644);
		if (mode === "oversized") await writeFile(f.marker, "x".repeat(32769));
		if (mode === "corrupt") await writeFile(f.marker, "{");
		await assert.rejects(f.pin(), /unsafe/);
	}
	for (const mode of ["symlink", "hardlink", "oversized"] as const) {
		const f = await fixture(t);
		await privateJSON(f.input.checkpointPath, checkpoint(f.input));
		if (mode === "symlink") {
			await rename(f.input.checkpointPath, join(f.parent, "target"));
			await symlink(join(f.parent, "target"), f.input.checkpointPath);
		}
		if (mode === "hardlink") await link(f.input.checkpointPath, join(f.parent, "linked"));
		if (mode === "oversized") await writeFile(f.input.checkpointPath, "x".repeat(2_000_001));
		await assert.rejects(f.pin(), /unsafe/);
	}
});

test("selection storage must stay outside the worktree and have no symlink parents", async (t) => {
	const f = await fixture(t);
	await assert.rejects(
		pinCodingProvider(
			{ ...f.input, checkpointPath: join(f.input.worktreePath, "checkpoint.json") },
			async () => muse,
			new AbortController().signal
		),
		/unsafe/
	);
	const alias = join(f.root, "alias");
	await symlink(f.parent, alias);
	await assert.rejects(
		pinCodingProvider(
			{ ...f.input, checkpointPath: join(alias, "checkpoint.json") },
			async () => muse,
			new AbortController().signal
		),
		/unsafe/
	);
});

test("concurrent first selections choose one atomic winner and refuse later override", async (t) => {
	const f = await fixture(t);
	const choices = await Promise.all(
		Array.from({ length: 8 }, (_, index) =>
			pinCodingProvider(
				f.input,
				async () => (index % 2 ? meta : muse),
				new AbortController().signal
			)
		)
	);
	for (const choice of choices) assert.deepEqual(choice, choices[0]);
	const stored = await readFile(f.marker, "utf8");
	assert.deepEqual((await f.pin()).settings, choices[0]?.settings);
	assert.equal(await readFile(f.marker, "utf8"), stored);
	assert.equal((await readdir(f.parent)).length, 1, "No publisher temporary files remain");
});

test("abort prevents preference reads/publication or discards a pending preference safely", async (t) => {
	const f = await fixture(t);
	const abort = new AbortController();
	abort.abort();
	await assert.rejects(f.pin(muse, abort.signal), { name: "AbortError" });
	assert.deepEqual(await readdir(f.parent), []);
	const pending = new AbortController();
	let entered: () => void = () => {};
	const gate = new Promise<void>((done) => {
		entered = done;
	});
	const selection = pinCodingProvider(
		f.input,
		async () => {
			entered();
			return new Promise<never>(() => {});
		},
		pending.signal
	);
	await gate;
	pending.abort();
	await assert.rejects(selection, { name: "AbortError" });
	assert.deepEqual(await readdir(f.parent), []);
});

test("invalid CLI preferences never publish a fallback selection or leak settings errors", async (t) => {
	for (const path of ["relative/muse", "/controlled/\ninvalid"]) {
		const f = await fixture(t);
		await assert.rejects(f.pin({ provider: "muse-code", musePath: path }), /settings are invalid/);
		assert.deepEqual(await readdir(f.parent), []);
	}
	const f = await fixture(t);
	await assert.rejects(
		pinCodingProvider(
			f.input,
			async () => {
				throw new Error("SECRET configuration content");
			},
			new AbortController().signal
		),
		(error: Error) => {
			assert.ok(!error.message.includes("SECRET"));
			return true;
		}
	);
	assert.deepEqual(await readdir(f.parent), []);
});
