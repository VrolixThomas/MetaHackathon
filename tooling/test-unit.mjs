import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const files = [];
async function discover(directory) {
	for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) await discover(path);
		else if (entry.isFile() && /\.test\.(?:ts|tsx|js|jsx|cjs|mjs)$/.test(entry.name))
			files.push(path);
	}
}
for (const directory of ["apps/desktop/src", "apps/desktop/packaging", "services/team"])
	await discover(directory);
files.sort();
if (!files.length) throw new Error("No unit test files discovered");
const summary = { files: files.length, passed: 0, skipped: 0, failed: 0, failedFiles: [] };
// Bun's shared node:test context lets bundler/HTTP/subprocess state leak across files.
// Keep every assertion, using a fresh test process per file instead of suppressing failures.
for (const file of files) {
	const run = spawnSync("bun", ["test", join(root, file)], {
		cwd: root,
		encoding: "utf8",
		env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
		maxBuffer: 8_000_000,
		timeout: 180_000,
	});
	const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
	const count = (label) =>
		Number(output.match(new RegExp(`^\\s*(\\d+) ${label}\\s*$`, "m"))?.[1] ?? 0);
	summary.passed += count("pass");
	summary.skipped += count("skip");
	summary.failed += count("fail");
	if (run.error || run.status !== 0 || count("fail")) {
		summary.failedFiles.push(relative(root, join(root, file)));
		console.error(`FAIL ${file}\n${output}`);
		if (run.error) console.error(run.error.message);
	} else console.log(`PASS ${file} (${count("pass")} passed, ${count("skip")} skipped)`);
}
console.log(`UNIT_TEST_RESULT: ${JSON.stringify(summary)}`);
if (summary.failedFiles.length || summary.failed) process.exitCode = 1;
