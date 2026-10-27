// Run: env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron apps/desktop/src/renderer/voice/browser-smoke.cjs
const { app, BrowserWindow, session } = require("electron");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const temporary = mkdtempSync(join(tmpdir(), "voice-renderer-smoke-"));
app.setPath("userData", join(temporary, "profile"));
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
let window;
let finished = false;
function finish(code, report) {
	if (finished) return;
	finished = true;
	clearTimeout(watchdog);
	console.log(JSON.stringify(report));
	window?.destroy();
	rmSync(temporary, { recursive: true, force: true });
	app.exit(code);
}
const watchdog = setTimeout(
	() => finish(1, { ok: false, error: "Browser smoke timed out" }),
	30_000
);
app
	.whenReady()
	.then(async () => {
		const build = spawnSync(
			"bun",
			[
				"build",
				join(__dirname, "browser-smoke.ts"),
				"--target",
				"browser",
				"--format",
				"iife",
				"--outfile",
				join(temporary, "smoke.js"),
			],
			{ encoding: "utf8" }
		);
		if (build.status !== 0)
			throw new Error(build.stderr || build.error?.message || "Smoke bundle failed");
		writeFileSync(
			join(temporary, "index.html"),
			'<!doctype html><title>Voice renderer smoke</title><script src="smoke.js"></script>'
		);
		session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) =>
			callback(permission === "media")
		);
		window = new BrowserWindow({
			show: false,
			webPreferences: {
				sandbox: true,
				contextIsolation: true,
				nodeIntegration: false,
				backgroundThrottling: false,
			},
		});
		await window.loadFile(join(temporary, "index.html"));
		const result = await window.webContents.executeJavaScript("window.voiceSmoke", true);
		finish(result?.ok ? 0 : 1, result);
	})
	.catch((error) => finish(1, { ok: false, error: String(error) }));
