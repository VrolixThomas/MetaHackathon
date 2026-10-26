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
import { join } from "node:path";
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
		const [a, b] = await Promise.all([
			f.manager.prepare({ repositoryPath: f.repository, baseRef: f.base, headRef: f.head }),
			f.manager.prepare({ repositoryPath: f.repository, baseRef: f.base, headRef: f.head }),
		]);
		assert.notEqual(a.runId, b.runId);
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
		await f.manager.cleanup(b.runId);
		assert.ok((await git(f.repository, "worktree", "list", "--porcelain")).includes(foreign));
		await assert.rejects(f.manager.cleanup("../../foreign-worktree"), /Unknown|Invalid/);
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
