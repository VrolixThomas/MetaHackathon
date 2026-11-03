import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCodingWorkerTools } from "./coding-worker-tools";

test("executes one actual focused Bun test; rejects flags, escapes, links and installs", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "focused-worker-")));
	try {
		await mkdir(join(root, "src"));
		await writeFile(
			join(root, "src/regression.test.ts"),
			'import {test, expect} from "bun:test"; test("actual focused regression", () => expect(2 + 2).toBe(4));'
		);
		await symlink(join(root, "src/regression.test.ts"), join(root, "link.test.ts"));
		const tools = createCodingWorkerTools({ worktreePath: root });
		const run = (command: string, args: string[]) =>
			tools.runCommand({ command, args, timeoutMs: 10000 }, new AbortController().signal);
		const result = await run("bun", ["test", "src/regression.test.ts"]);
		assert.equal(result.exitCode, 0);
		for (const args of [
			["test", "../escape.test.ts"],
			["test", "/tmp/escape.test.ts"],
			["test", "--watch"],
			["test", "src/regression.test.ts", "--watch"],
			["test", "link.test.ts"],
			["test", "missing.test.ts"],
			["test", "src/regression.test.ts;echo"],
			["install", "--frozen-lockfile"],
			["add", "zod"],
			["run", "dev"],
		])
			await assert.rejects(run("bun", args));
		await assert.rejects(run("git", ["push"]));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
