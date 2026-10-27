import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
	describeLocalRepository,
	readLocalReviewSource,
	validateLocalRepository,
} from "./local-review";

const exec = promisify(execFile);
async function repository(
	work: (
		root: string,
		base: string,
		head: string,
		git: (...args: string[]) => Promise<string>
	) => Promise<void>
) {
	const temporary = await mkdtemp(join(tmpdir(), "review-local-test-"));
	const root = await realpath(temporary);
	const git = async (...args: string[]) =>
		(
			await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], {
				cwd: root,
				env: {
					PATH: process.env["PATH"],
					GIT_CONFIG_GLOBAL: "/dev/null",
					GIT_CONFIG_NOSYSTEM: "1",
					GIT_AUTHOR_NAME: "Local test",
					GIT_AUTHOR_EMAIL: "local@example.invalid",
					GIT_COMMITTER_NAME: "Local test",
					GIT_COMMITTER_EMAIL: "local@example.invalid",
				},
			})
		).stdout.trim();
	try {
		await git("init", "--initial-branch=main", "--template=");
		await git("remote", "add", "origin", "git@github.com:owner/repo.git");
		await mkdir(join(root, "src"));
		await writeFile(join(root, "src", "file.ts"), "base\n");
		await writeFile(join(root, "binary.bin"), Buffer.from([0, 255, 1]));
		await writeFile(join(root, "large.txt"), "x".repeat(300001));
		await git("add", ".");
		await git("commit", "-m", "Base");
		const base = await git("rev-parse", "HEAD");
		await writeFile(join(root, "src", "file.ts"), "head\n");
		await git("add", ".");
		await git("commit", "-m", "Head");
		const head = await git("rev-parse", "HEAD");
		await work(root, base, head, git);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("local repository description canonicalizes selection and validates GitHub origin", async () => {
	await repository(async (root, _base, _head, git) => {
		assert.deepEqual(await describeLocalRepository(join(root, "src")), {
			repository: "owner/repo",
			localPath: root,
		});
		const link = join(root, "alias");
		await symlink(join(root, "src"), link);
		assert.equal((await describeLocalRepository(link)).localPath, root);
		assert.equal(await validateLocalRepository(root, "OWNER/REPO"), root);
		await assert.rejects(validateLocalRepository(root, "other/repo"), /does not match/);
		await git("remote", "set-url", "origin", "https://github.com/owner/repo.git");
		assert.equal((await describeLocalRepository(root)).repository, "owner/repo");
		await git("remote", "set-url", "origin", "ssh://git@github.com/owner/repo.git");
		assert.equal((await describeLocalRepository(root)).repository, "owner/repo");
		await git(
			"remote",
			"set-url",
			"origin",
			"https://user:sensitive-token@github.com/owner/repo.git"
		);
		await assert.rejects(
			describeLocalRepository(root),
			(error: Error) =>
				error.message.includes("without embedded credentials") &&
				!error.message.includes("sensitive-token")
		);
	});
});

test("local review reads pinned objects while preserving dirty worktree, HEAD, index and refs", async () => {
	await repository(async (root, base, head, git) => {
		await writeFile(join(root, "src", "file.ts"), "uncommitted user content\n");
		const before = {
			head: await git("rev-parse", "HEAD"),
			index: await git("ls-files", "-s"),
			status: await git("status", "--porcelain"),
			refs: await git("show-ref"),
		};
		assert.equal(
			(await readLocalReviewSource(root, "owner/repo", "src/file.ts", base))?.content,
			"base\n"
		);
		assert.equal(
			(await readLocalReviewSource(root, "owner/repo", "src/file.ts", head))?.content,
			"head\n"
		);
		assert.equal(
			await readFile(join(root, "src", "file.ts"), "utf8"),
			"uncommitted user content\n"
		);
		assert.deepEqual(
			{
				head: await git("rev-parse", "HEAD"),
				index: await git("ls-files", "-s"),
				status: await git("status", "--porcelain"),
				refs: await git("show-ref"),
			},
			before
		);
	});
});

test("only an absent commit yields remote fallback; absent paths/binary/large objects stay local", async () => {
	await repository(async (root, base, _head) => {
		assert.equal(
			await readLocalReviewSource(root, "owner/repo", "src/file.ts", "f".repeat(40)),
			undefined
		);
		assert.equal(
			(await readLocalReviewSource(root, "owner/repo", "missing.ts", base))?.status,
			"missing"
		);
		assert.equal(
			(await readLocalReviewSource(root, "owner/repo", "binary.bin", base))?.status,
			"binary"
		);
		assert.equal(
			(await readLocalReviewSource(root, "owner/repo", "large.txt", base))?.status,
			"too-large"
		);
		await assert.rejects(
			readLocalReviewSource(root, "different/repo", "src/file.ts", base),
			/does not match/
		);
		await assert.rejects(readLocalReviewSource(root, "owner/repo", "../outside", base));
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			readLocalReviewSource(root, "owner/repo", "src/file.ts", base, controller.signal)
		);
	});
});
