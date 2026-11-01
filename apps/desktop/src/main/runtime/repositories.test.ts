import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { runProcess } from "./process";
import { RepositoryManager } from "./repositories";

async function git(cwd: string, ...args: string[]) {
	const result = await runProcess({ command: "git", args, cwd });
	assert.equal(result.exitCode, 0, result.stderr);
	return result.stdout.trim();
}

async function fixture() {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "runtime-repositories-test-")));
	const repository = join(directory, "user", "shop");
	await mkdir(repository, { recursive: true });
	await git(repository, "init", "-b", "main");
	await git(repository, "config", "user.name", "Runtime Test");
	await git(repository, "config", "user.email", "runtime@example.invalid");
	await writeFile(join(repository, "price.txt"), "before\n");
	await git(repository, "add", ".");
	await git(repository, "commit", "-m", "Base");
	const base = await git(repository, "rev-parse", "HEAD");
	await writeFile(join(repository, "price.txt"), "after\n");
	await git(repository, "commit", "-am", "Head");
	const head = await git(repository, "rev-parse", "HEAD");
	return {
		directory,
		repository,
		base,
		head,
		manager: new RepositoryManager(join(directory, "runtime")),
	};
}

test("discovers clones without following foreign symlinks", async () => {
	const f = await fixture();
	try {
		await symlink(f.repository, join(f.directory, "linked"));
		const found = await f.manager.findClones([
			join(f.directory, "user"),
			f.repository,
			join(f.directory, "linked"),
		]);
		assert.deepEqual(found, [f.repository]);
	} finally {
		await rm(f.directory, { recursive: true, force: true });
	}
});

test("creates unique detached SHA-pinned versions and removes only owned worktrees", async () => {
	const f = await fixture();
	try {
		const foreign = join(f.directory, "foreign-worktree");
		await git(f.repository, "worktree", "add", "--detach", foreign, f.base);
		const other = new RepositoryManager(join(f.directory, "other-runtime"));
		const results = await Promise.allSettled([
			f.manager.prepare({ repositoryPath: f.repository, baseRef: f.base, headRef: f.head }),
			other.prepare({ repositoryPath: f.repository, baseRef: f.base, headRef: f.head }),
		]);
		// Drain both preparations before fixture cleanup, including when either one fails.
		const [first, second] = results;
		assert.ok(first?.status === "fulfilled", String(first));
		assert.ok(second?.status === "fulfilled", String(second));
		const [a, b] = [first.value, second.value];
		assert.notEqual(a.runId, b.runId);
		const administrativeNames = await Promise.all(
			[a.base, a.head, b.base, b.head].map(async (tree) =>
				basename(await git(tree.path, "rev-parse", "--absolute-git-dir"))
			)
		);
		assert.equal(new Set(administrativeNames).size, 4);
		for (const run of [a, b]) {
			assert.equal(basename(run.base.path), `${run.runId}-base`);
			assert.equal(basename(run.head.path), `${run.runId}-head`);
		}
		assert.equal(await readFile(join(a.base.path, "price.txt"), "utf8"), "before\n");
		assert.equal(await readFile(join(a.head.path, "price.txt"), "utf8"), "after\n");
		assert.equal(await git(a.head.path, "rev-parse", "HEAD"), f.head);
		assert.equal(
			(await runProcess({ command: "git", args: ["symbolic-ref", "-q", "HEAD"], cwd: a.head.path }))
				.exitCode,
			1
		);
		await f.manager.cleanup(a.runId);
		assert.equal(await readFile(join(foreign, "price.txt"), "utf8"), "before\n");
		assert.equal(await readFile(join(b.head.path, "price.txt"), "utf8"), "after\n");
		await other.cleanup(b.runId);
		assert.ok((await git(f.repository, "worktree", "list", "--porcelain")).includes(foreign));
		await assert.rejects(f.manager.cleanup("../../foreign-worktree"), /Unknown|Invalid/);
	} finally {
		await rm(f.directory, { recursive: true, force: true });
	}
});

test("cleanup still recognizes version-1 records with legacy base/head paths", async () => {
	const f = await fixture();
	try {
		const run = await f.manager.prepare({
			repositoryPath: f.repository,
			baseRef: f.base,
			headRef: f.head,
		});
		const recordPath = join(dirname(run.base.path), "ownership.json");
		const record = JSON.parse(await readFile(recordPath, "utf8"));
		for (const side of ["base", "head"] as const) {
			const previous = run[side].path;
			const legacy = join(dirname(previous), side);
			await git(f.repository, "worktree", "move", previous, legacy);
			record.worktrees = record.worktrees.map((path: string) =>
				path === previous ? legacy : path
			);
			record.worktreeIdentities[legacy] = record.worktreeIdentities[previous];
			delete record.worktreeIdentities[previous];
		}
		await writeFile(recordPath, JSON.stringify(record));
		await new RepositoryManager(join(f.directory, "runtime")).cleanup(run.runId);
		assert.deepEqual(await readdir(join(f.directory, "runtime", "runs")), []);
		assert.equal(await readFile(join(f.repository, "price.txt"), "utf8"), "after\n");
	} finally {
		await rm(f.directory, { recursive: true, force: true });
	}
});

test("persists ownership across manager restart and preserves dirty worktrees", async () => {
	const f = await fixture();
	try {
		const run = await f.manager.prepare({
			repositoryPath: f.repository,
			baseRef: f.base,
			headRef: f.head,
		});
		await writeFile(join(run.head.path, "reviewer-note.txt"), "keep me\n");
		const restarted = new RepositoryManager(join(f.directory, "runtime"));
		await assert.rejects(restarted.cleanup(run.runId), /dirty/i);
		assert.equal(await readFile(join(run.head.path, "reviewer-note.txt"), "utf8"), "keep me\n");
		await rm(join(run.head.path, "reviewer-note.txt"));
		await restarted.cleanup(run.runId);
	} finally {
		await rm(f.directory, { recursive: true, force: true });
	}
});

test("fetches remote PR refs and base without changing user HEAD", async () => {
	const f = await fixture();
	try {
		await git(f.repository, "update-ref", "refs/pull/1284/head", f.head);
		const clone = join(f.directory, "existing-clone");
		await git(f.directory, "clone", f.repository, clone);
		const before = await git(clone, "rev-parse", "HEAD");
		const run = await f.manager.prepare({ repositoryPath: clone, prNumber: 1284, baseRef: f.base });
		assert.equal(run.base.sha, f.base);
		assert.equal(run.head.sha, f.head);
		assert.equal(await git(clone, "rev-parse", "HEAD"), before);
		await f.manager.cleanup(run.runId);
		assert.equal(await git(clone, "for-each-ref", "--format=%(refname)", "refs/metahackathon"), "");
	} finally {
		await rm(f.directory, { recursive: true, force: true });
	}
});

test("owns cloned repositories and cleans partial failures", async () => {
	const f = await fixture();
	try {
		const run = await f.manager.prepare({
			cloneUrl: f.repository,
			baseRef: f.base,
			headRef: f.head,
		});
		assert.notEqual(run.repositoryPath, f.repository);
		await f.manager.cleanup(run.runId);
		await assert.rejects(
			f.manager.prepare({
				repositoryPath: f.repository,
				baseRef: f.base,
				headRef: "no-such-revision",
			}),
			/revision/i
		);
		const worktrees = await git(f.repository, "worktree", "list", "--porcelain");
		assert.ok(!worktrees.includes(join(f.directory, "runtime", "runs")));
	} finally {
		await rm(f.directory, { recursive: true, force: true });
	}
});

test("failed clone and missing local repository leave no owned run directories", async () => {
	const f = await fixture();
	try {
		await assert.rejects(
			f.manager.prepare({
				cloneUrl: join(f.directory, "missing"),
				baseRef: f.base,
				headRef: f.head,
			}),
			/clone operation failed/
		);
		await assert.rejects(
			f.manager.prepare({
				repositoryPath: join(f.directory, "missing"),
				baseRef: f.base,
				headRef: f.head,
			}),
			/ENOENT/
		);
		assert.deepEqual(await readdir(join(f.directory, "runtime", "runs")), []);
	} finally {
		await rm(f.directory, { recursive: true, force: true });
	}
});

test("cleanup removes the registration of an owned worktree whose directory disappeared", async () => {
	const f = await fixture();
	try {
		const run = await f.manager.prepare({
			repositoryPath: f.repository,
			baseRef: f.base,
			headRef: f.head,
		});
		await rm(run.head.path, { recursive: true });
		await f.manager.cleanup(run.runId);
		assert.ok(
			!(await git(f.repository, "worktree", "list", "--porcelain")).includes(run.head.path)
		);
	} finally {
		await rm(f.directory, { recursive: true, force: true });
	}
});

test("an owned clone with a foreign worktree is preserved", async () => {
	const f = await fixture();
	try {
		const run = await f.manager.prepare({
			cloneUrl: f.repository,
			baseRef: f.base,
			headRef: f.head,
		});
		const foreign = join(f.directory, "foreign");
		await git(run.repositoryPath, "worktree", "add", "--detach", foreign, f.head);
		await assert.rejects(f.manager.cleanup(run.runId), /additional worktrees/);
		assert.equal(await readFile(join(foreign, "price.txt"), "utf8"), "after\n");
		await git(run.repositoryPath, "worktree", "remove", foreign);
		await f.manager.cleanup(run.runId);
	} finally {
		await rm(f.directory, { recursive: true, force: true });
	}
});

test("ignored files and replaced worktree symlinks are preserved", async () => {
	const f = await fixture();
	try {
		const run = await f.manager.prepare({
			repositoryPath: f.repository,
			baseRef: f.base,
			headRef: f.head,
		});
		await writeFile(join(f.repository, ".git", "info", "exclude"), "generated.log\n");
		await writeFile(join(run.head.path, "generated.log"), "owned by someone else\n");
		await assert.rejects(f.manager.cleanup(run.runId), /dirty/i);
		await rm(join(run.head.path, "generated.log"));
		await git(f.repository, "worktree", "remove", run.head.path);
		await symlink(f.repository, run.head.path);
		await assert.rejects(f.manager.cleanup(run.runId), /replaced worktree/i);
		assert.equal(await readFile(join(f.repository, "price.txt"), "utf8"), "after\n");
		await rm(run.head.path);
		await f.manager.cleanup(run.runId);
	} finally {
		await rm(f.directory, { recursive: true, force: true });
	}
});

test("cleanup preserves a moved owned worktree and a clean same-repository replacement", async () => {
	const f = await fixture();
	try {
		const run = await f.manager.prepare({
			repositoryPath: f.repository,
			baseRef: f.base,
			headRef: f.head,
		});
		const moved = join(f.directory, "moved-owned-head");
		await git(f.repository, "worktree", "move", run.head.path, moved);
		await git(f.repository, "worktree", "add", "--detach", run.head.path, f.base);
		const restarted = new RepositoryManager(join(f.directory, "runtime"));
		await assert.rejects(restarted.cleanup(run.runId), /identity|moved|replaced/i);
		assert.equal(await readFile(join(run.head.path, "price.txt"), "utf8"), "before\n");
		assert.equal(await readFile(join(moved, "price.txt"), "utf8"), "after\n");
		assert.equal(await readFile(join(run.base.path, "price.txt"), "utf8"), "before\n");
		await git(f.repository, "worktree", "remove", run.head.path);
		await git(f.repository, "worktree", "move", moved, run.head.path);
		await restarted.cleanup(run.runId);
	} finally {
		await rm(f.directory, { recursive: true, force: true });
	}
});

test("cleanup retains ownership metadata and retries after an extra run file is removed", async () => {
	const f = await fixture();
	try {
		const run = await f.manager.prepare({
			repositoryPath: f.repository,
			baseRef: f.base,
			headRef: f.head,
		});
		const runRoot = join(f.directory, "runtime", "runs", run.runId);
		await writeFile(join(runRoot, "run.log"), "preserve this log\n");
		const restarted = new RepositoryManager(join(f.directory, "runtime"));
		await assert.rejects(restarted.cleanup(run.runId));
		assert.ok(JSON.parse(await readFile(join(runRoot, "ownership.json"), "utf8")));
		await assert.rejects(restarted.cleanup(run.runId), /additional files/i);
		assert.equal(await readFile(join(runRoot, "run.log"), "utf8"), "preserve this log\n");
		assert.equal(await readFile(join(run.head.path, "price.txt"), "utf8"), "after\n");
		await rm(join(runRoot, "run.log"));
		await restarted.cleanup(run.runId);
		assert.deepEqual(await readdir(join(f.directory, "runtime", "runs")), []);
	} finally {
		await rm(f.directory, { recursive: true, force: true });
	}
});

test("cleanup preserves ownership when an owned tree moves without a replacement", async () => {
	const f = await fixture();
	try {
		const run = await f.manager.prepare({
			repositoryPath: f.repository,
			baseRef: f.base,
			headRef: f.head,
		});
		const moved = join(f.directory, "moved-owned-head");
		await git(f.repository, "worktree", "move", run.head.path, moved);
		await assert.rejects(f.manager.cleanup(run.runId), /moved/i);
		assert.equal(await readFile(join(moved, "price.txt"), "utf8"), "after\n");
		assert.ok(
			JSON.parse(
				await readFile(join(f.directory, "runtime", "runs", run.runId, "ownership.json"), "utf8")
			)
		);
		await git(f.repository, "worktree", "move", moved, run.head.path);
		await f.manager.cleanup(run.runId);
	} finally {
		await rm(f.directory, { recursive: true, force: true });
	}
});

test("cleanup preserves a replacement even when Git reuses the administrative directory path", async () => {
	const f = await fixture();
	try {
		const run = await f.manager.prepare({
			repositoryPath: f.repository,
			baseRef: f.base,
			headRef: f.head,
		});
		const originalGitDirectory = await git(run.head.path, "rev-parse", "--absolute-git-dir");
		await git(f.repository, "worktree", "remove", run.head.path);
		await git(f.repository, "worktree", "add", "--detach", run.head.path, f.base);
		assert.equal(await git(run.head.path, "rev-parse", "--absolute-git-dir"), originalGitDirectory);
		await assert.rejects(f.manager.cleanup(run.runId), /identity changed/i);
		assert.equal(await readFile(join(run.head.path, "price.txt"), "utf8"), "before\n");
		await git(f.repository, "worktree", "remove", run.head.path);
		await f.manager.cleanup(run.runId);
	} finally {
		await rm(f.directory, { recursive: true, force: true });
	}
});
