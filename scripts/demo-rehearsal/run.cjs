#!/usr/bin/env node
const { spawn, spawnSync } = require("node:child_process");
const { existsSync, mkdirSync } = require("node:fs");
const { resolve, join } = require("node:path");
const root = resolve(__dirname, "../..");
const desktop = join(root, "apps/desktop");
function run(command, args) {
	const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
	if (result.status !== 0) process.exit(result.status ?? 1);
}
if (!existsSync(join(root, "node_modules"))) run("bun", ["install", "--frozen-lockfile"]);
if (!process.argv.includes("--no-build"))
	run("bun", ["run", "--filter", "@metahackathon/desktop", "build"]);
mkdirSync(join(desktop, "out/demo-rehearsal"), { recursive: true });
run("bun", [
	"build",
	join(__dirname, "prepare.ts"),
	"--target=node",
	"--format=cjs",
	"--external=better-sqlite3",
	"--external=electron",
	"--outfile",
	join(desktop, "out/demo-rehearsal/prepare.cjs"),
]);
const env = { ...process.env };
for (const key of Object.keys(env))
	if (
		/(?:TOKEN|SECRET|API_KEY|CLIENT_ID|VOICE_ID)/i.test(key) ||
		/^(SLACK_|LINEAR_|GITHUB_|GH_|META_|MODEL_|ELEVENLABS_|MUSE_|VITE_|METAHACKATHON_|ELECTRON_RUN_AS_NODE|NODE_OPTIONS)/.test(
			key
		)
	)
		delete env[key];
const electron = require(require.resolve("electron", { paths: [desktop] }));
const child = spawn(electron, [join(__dirname, "desktop.cjs"), ...process.argv.slice(2)], {
	cwd: desktop,
	env,
	stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 0));
