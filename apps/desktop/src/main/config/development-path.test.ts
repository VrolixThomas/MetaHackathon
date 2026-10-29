import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { developmentEnvPath } from "./development-path";

it("a worktree shares its main repository configuration instead of opening a blank local file", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "muse-shared-config-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const main = join(root, "main");
	const work = join(root, "work");
	await mkdir(main);
	const git = (args: string[]) =>
		execFileSync(
			"git",
			[
				"-C",
				main,
				"-c",
				"core.hooksPath=/dev/null",
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.invalid",
				...args,
			],
			{ stdio: "pipe" }
		);
	git(["init", "-b", "main"]);
	await writeFile(join(main, "tracked.txt"), "test\n");
	git(["add", "--", "tracked.txt"]);
	git(["commit", "-m", "test"]);
	git(["worktree", "add", "-b", "work", "--", work]);
	await writeFile(join(main, ".env"), "MODEL_API_KEY=test-only\n");
	await writeFile(join(work, ".env"), "MODEL_API_KEY=\n");
	assert.equal(await developmentEnvPath(work), await realpath(join(main, ".env")));
	assert.equal(await developmentEnvPath(main), await realpath(join(main, ".env")));
});
it("a non-Git development bundle keeps its checkout configuration path", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "muse-standalone-config-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	assert.equal(await developmentEnvPath(root), join(root, ".env"));
});
