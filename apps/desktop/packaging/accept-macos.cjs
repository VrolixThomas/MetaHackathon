// Root/integration only. Builds/packages but never launches the app or captures audio.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { requireSigningCredentials } = require("./credentials.cjs");
const { verifyPackagedPayload } = require("./payload.cjs");

function main() {
	const mode = process.argv[2];
	if (!["unsigned", "signed"].includes(mode) || process.env.MUSE_ROOT_RELEASE_ACCEPTANCE !== "1") {
		throw new Error(
			"Root only: MUSE_ROOT_RELEASE_ACCEPTANCE=1 node packaging/accept-macos.cjs unsigned|signed. Signed mode contacts Apple notarization; neither mode publishes or launches."
		);
	}
	if (process.platform !== "darwin" || process.arch !== "arm64")
		throw new Error("Run on the target Apple Silicon Mac");
	if (mode === "signed") requireSigningCredentials();
	const desktop = path.resolve(__dirname, "..");
	const output = path.join(desktop, "dist", `acceptance-${mode}-${Date.now()}`);
	const env = { ...process.env, METAHACKATHON_UNSIGNED_LOCAL: mode === "unsigned" ? "1" : "0" };
	// Electron checks presence, so an empty value is insufficient.
	// biome-ignore lint/performance/noDelete: Electron uses the presence of this environment variable.
	delete env.ELECTRON_RUN_AS_NODE;
	const commands = [];
	const run = (program, args) => {
		const startedAt = new Date().toISOString();
		const result = spawnSync(program, args, {
			cwd: desktop,
			env,
			stdio: "inherit",
			timeout: 55 * 60_000,
		});
		commands.push({
			program: path.basename(program),
			args,
			startedAt,
			finishedAt: new Date().toISOString(),
			exitCode: result.status,
		});
		if (result.error || result.status !== 0)
			throw new Error(
				`Release acceptance failed: ${path.basename(program)} (${result.status ?? "spawn error"})`
			);
	};
	run("bun", ["run", "build"]);
	run("bun", [
		"x",
		"--no-install",
		"electron-builder",
		"--config",
		mode === "signed" ? "electron-builder.yml" : "electron-builder.unsigned.yml",
		"--mac",
		"dmg",
		"zip",
		"--arm64",
		"--publish",
		"never",
		`-c.directories.output=${output}`,
	]);
	const app = path.join(output, "mac-arm64", "MuseFocus.app");
	const payload = verifyPackagedPayload(app, ["arm64"]);
	if (mode === "signed")
		run(process.execPath, [path.join(__dirname, "finalize-release.cjs"), output, app]);
	const report = {
		verifiedAt: new Date().toISOString(),
		kind: mode === "signed" ? "developer-id-notarized" : "unsigned-local",
		payload,
		commands,
		appLaunch: "not-run",
		physicalMicrophone: "not-run",
		updaterInstallation: "not-run",
	};
	fs.writeFileSync(
		path.join(output, "packaging-acceptance.json"),
		`${JSON.stringify(report, null, 2)}\n`,
		{ mode: 0o600 }
	);
	console.log(`Package acceptance ${mode}: ${output}. No app launch or microphone verification.`);
}
if (require.main === module) {
	try {
		main();
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
