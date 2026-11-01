// Generates an isolated hello-world app under ignored build output. This does not
// replace desktop source, alter dependency manifests, or require app credentials.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const desktop = path.resolve(__dirname, "..");
const adhoc = process.argv.includes("--adhoc");
const label = adhoc ? "ADHOC-LOCAL" : "UNSIGNED-LOCAL";
const source = path.join(desktop, "dist", "hello-probe-source");
fs.mkdirSync(path.join(source, "out"), { recursive: true });
fs.writeFileSync(
	path.join(source, "package.json"),
	JSON.stringify({
		name: "musefocus-packaging-probe",
		version: "0.1.0",
		main: "out/main.cjs",
		description: "Local hello-world packaging probe",
		author: "MuseFocus",
	})
);
fs.writeFileSync(
	path.join(source, "out", "main.cjs"),
	`
const { app, BrowserWindow } = require("electron");
app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 720, height: 420, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  window.loadFile(require("node:path").join(__dirname, "index.html"));
});
app.on("window-all-closed", () => app.quit());
`
);
fs.writeFileSync(
	path.join(source, "out", "index.html"),
	`<!doctype html><html lang="en"><meta charset="utf-8"><title>MuseFocus packaging probe</title><style>body{background:#11131a;color:#f0f2f7;font:20px system-ui;padding:48px}h1{font-size:32px}strong{color:#ffcc66}</style><h1>Hello, MuseFocus.</h1><p>The Electron DMG packaging path works.</p><p><strong>${label} PROBE</strong></p><p>No Developer ID signature or notarization. Not a distributable release.</p></html>`
);
const cli = path.join(
	path.dirname(require.resolve("electron-builder/package.json")),
	"out",
	"cli",
	"cli.js"
);
const result = spawnSync(
	process.execPath,
	[
		cli,
		"--config",
		"electron-builder.probe.yml",
		"--mac",
		"dmg",
		"zip",
		"--arm64",
		"--publish",
		"never",
		"-c.directories.app=dist/hello-probe-source",
		`-c.directories.output=dist/hello-probe${adhoc ? "-adhoc" : ""}`,
		"-c.productName=MuseFocus Packaging Probe",
		`-c.artifactName=MuseFocus-HelloWorld-\${version}-\${arch}-${label}.\${ext}`,
		"-c.electronVersion=40.8.5",
		...(adhoc ? ["-c.mac.identity=-"] : []),
	],
	{ cwd: desktop, stdio: "inherit", env: { ...process.env, METAHACKATHON_UNSIGNED_LOCAL: "1" } }
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
