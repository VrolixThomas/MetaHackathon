const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const asar = require("@electron/asar");
const yaml = require("js-yaml");
const { validateConfiguration } = require("app-builder-lib/out/util/config/config");
const { machoArchitectures, verifyVoiceBundle, verifyPackagedPayload } = require("./payload.cjs");

function temporary(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "muse-package-unit-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	return root;
}
function write(file, content) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}
function macho(cpu = 0x0100000c) {
	const bytes = Buffer.alloc(32);
	bytes.writeUInt32LE(0xfeedfacf, 0);
	bytes.writeUInt32LE(cpu, 4);
	return bytes;
}
function voice(root) {
	write(path.join(root, "metahackathon-voice"), macho());
	fs.chmodSync(path.join(root, "metahackathon-voice"), 0o755);
	write(path.join(root, "_internal", "native.so"), macho());
}

test("release configuration matches the installed builder schema and keeps production/hello probes distinct", async () => {
	const config = yaml.load(
		fs.readFileSync(path.join(__dirname, "../electron-builder.yml"), "utf8")
	);
	await validateConfiguration(config);
	assert.equal(config.appId, "app.musefocus.desktop");
	assert.equal(config.productName, "MuseFocus");
	assert.equal(config.artifactName, "MuseFocus-${version}-${arch}.${ext}");
	assert.deepEqual(config.publish, {
		provider: "github",
		owner: "VrolixThomas",
		repo: "MetaHackathon",
		releaseType: "draft",
	});
	assert.equal(config.forceCodeSigning, true);
	assert.equal(config.mac.hardenedRuntime, true);
	assert.equal(config.mac.notarize, true);
	assert.equal(config.mac.icon, "resources/branding/icon.icns");
	assert.equal(config.win.icon, "resources/branding/icon.ico");
	assert.equal(config.linux.icon, "resources/branding/icon.png");
	assert.equal(config.dmg.sign, true);
	assert.equal(config.npmRebuild, true);
	assert.equal(config.asar, true);
	assert.ok(config.asarUnpack.includes("node_modules/better-sqlite3/**/*"));
	assert.equal(config.mac.entitlements, "resources/entitlements.mac.plist");
	assert.equal(config.mac.entitlementsInherit, "resources/entitlements.mac.plist");
	assert.match(config.mac.extendInfo.NSMicrophoneUsageDescription, /hands-free/);
	assert.deepEqual(config.extraResources, [
		{ from: "resources/branding/icon.png", to: "branding/icon.png" },
		{ from: "../../services/voice/dist/metahackathon-voice", to: "voice" },
	]);
	assert.ok(config.files.includes("node_modules/@muse-code/sdk/**/*"));
	assert.ok(!config.files.includes("out/**/*"));
	for (const part of ["main", "preload", "renderer"])
		assert.ok(config.files.includes(`out/${part}/**/*`));
	assert.equal(config.afterPack, "packaging/after-pack.cjs");
	assert.equal(config.beforePack, "packaging/before-pack.cjs");
	assert.equal(config.afterSign, "packaging/after-sign.cjs");
	const unsigned = yaml.load(
		fs.readFileSync(path.join(__dirname, "../electron-builder.unsigned.yml"), "utf8")
	);
	await validateConfiguration(unsigned);
	assert.equal(unsigned.forceCodeSigning, false);
	assert.equal(unsigned.publish, null);
	assert.equal(unsigned.extends, "./electron-builder.yml");
	assert.equal(unsigned.artifactName, "MuseFocus-${version}-${arch}-UNSIGNED-LOCAL.${ext}");
	const probe = yaml.load(
		fs.readFileSync(path.join(__dirname, "../electron-builder.probe.yml"), "utf8")
	);
	await validateConfiguration(probe);
	assert.equal(probe.extends, "./electron-builder.unsigned.yml");
	assert.equal(probe.appId, "app.musefocus.desktop.packaging-probe");
	assert.equal(probe.productName, "MuseFocus Packaging Probe");
	assert.equal(probe.extraResources, null);
	assert.equal(probe.afterPack, null);
});

test("CI finalizes MuseFocus.app before uploading signed release artifacts", () => {
	const workflow = yaml.load(
		fs.readFileSync(path.join(__dirname, "../../..", ".github/workflows/macos-release.yml"), "utf8")
	);
	const steps = workflow.jobs["signed-arm64"].steps;
	const finalIndex = steps.findIndex((step) =>
		step.run?.includes("packaging/finalize-release.cjs")
	);
	assert.ok(finalIndex >= 0);
	assert.equal(
		steps[finalIndex].run,
		"node packaging/finalize-release.cjs dist dist/mac-arm64/MuseFocus.app"
	);
	const uploadIndex = steps.findIndex(
		(step) => step.name === "Preserve reviewed release candidate"
	);
	assert.ok(uploadIndex > finalIndex);
	assert.equal(steps[uploadIndex].if, undefined);
	assert.match(steps[uploadIndex].with.name, /^musefocus-signed-macos-arm64-/);
	assert.equal(steps[uploadIndex].with["if-no-files-found"], "error");
	const paths = steps[uploadIndex].with.path.trim().split("\n");
	assert.ok(paths.includes("apps/desktop/dist/*.dmg"));
	assert.ok(paths.includes("apps/desktop/dist/*.zip"));
	assert.ok(paths.includes("apps/desktop/dist/latest-mac.yml"));
	assert.ok(paths.includes("apps/desktop/dist/signing-evidence.json"));
	assert.ok(!paths.some((entry) => entry.includes("**") || /unsigned|probe/i.test(entry)));
	const signedSteps = steps.filter((entry) => entry.env?.CSC_LINK);
	assert.equal(signedSteps.length, 3);
	for (const step of signedSteps) {
		assert.deepEqual(step.env, {
			CSC_LINK: "${{ secrets.MAC_CSC_LINK || secrets.MAC_CERTIFICATE }}",
			CSC_KEY_PASSWORD: "${{ secrets.MAC_CSC_KEY_PASSWORD || secrets.MAC_CERTIFICATE_PASSWORD }}",
			APPLE_ID: "${{ secrets.APPLE_ID }}",
			APPLE_APP_SPECIFIC_PASSWORD:
				"${{ secrets.APPLE_APP_SPECIFIC_PASSWORD || secrets.APPLE_ID_PASSWORD }}",
			APPLE_TEAM_ID: "${{ secrets.APPLE_TEAM_ID }}",
		});
	}
});

test("frozen payload blocks missing/wrong architecture and escaping links without executing binaries", (t) => {
	const root = temporary(t);
	const bundle = path.join(root, "voice");
	assert.throws(() => verifyVoiceBundle(bundle, ["arm64"]), /Frozen voice bundle missing/);
	voice(bundle);
	assert.deepEqual(verifyVoiceBundle(bundle, ["arm64"]), {
		binaryCount: 2,
		architectures: ["arm64"],
	});
	write(path.join(bundle, "_internal", "native.so"), macho(0x01000007));
	assert.throws(() => verifyVoiceBundle(bundle, ["arm64"]), /architecture mismatch/);
	write(path.join(bundle, "_internal", "native.so"), macho());
	write(path.join(root, "outside"), "not part of the bundle");
	fs.symlinkSync("../outside", path.join(bundle, "escape"));
	assert.throws(() => verifyVoiceBundle(bundle, ["arm64"]), /escaping symlink/);
});

test("fat Mach-O headers require every requested architecture", (t) => {
	const file = path.join(temporary(t), "fat");
	const header = Buffer.alloc(48);
	header.writeUInt32BE(0xcafebabe, 0);
	header.writeUInt32BE(2, 4);
	header.writeUInt32BE(0x0100000c, 8);
	header.writeUInt32BE(0x01000007, 28);
	write(file, header);
	assert.deepEqual(machoArchitectures(file), ["arm64", "x64"]);
	header.writeUInt32BE(100, 4);
	write(file, header);
	assert.throws(() => machoArchitectures(file), /architecture table/);
});

test("archive verification finds missing SDK dependencies/native unpacking and refuses demo payload", async (t) => {
	// Synthetic archive and inert Mach-O headers: this proves policy only, never signing/launch.
	const root = temporary(t);
	const source = path.join(root, "source");
	const app = path.join(root, "MuseFocus.app");
	const resources = path.join(app, "Contents", "Resources");
	fs.mkdirSync(resources, { recursive: true });
	voice(path.join(resources, "voice"));
	for (const file of [
		"out/main/index.js",
		"out/main/coding-worker.js",
		"out/preload/index.cjs",
		"out/renderer/index.html",
		"out/main/db/migrations/0000.sql",
		"node_modules/better-sqlite3/build/Release/better_sqlite3.node",
	])
		write(path.join(source, file), "inert test bytes");
	write(
		path.join(source, "package.json"),
		JSON.stringify({ dependencies: { "@muse-code/sdk": "1.4.14" } })
	);
	write(
		path.join(source, "node_modules/@muse-code/sdk/package.json"),
		JSON.stringify({ version: "1.4.14", main: "dist/src/index.js" })
	);
	write(
		path.join(source, "node_modules/@muse-code/sdk/dist/src/index.js"),
		'export { value } from "./dependency.js";'
	);
	const archive = path.join(resources, "app.asar");
	const pack = async (unpack = true) => {
		asar.uncache(archive);
		await asar.createPackageWithOptions(source, archive, unpack ? { unpack: "**/*.node" } : {});
	};
	await pack();
	assert.throws(() => verifyPackagedPayload(app, ["arm64"]), /missing.*dependency.js/);
	write(
		path.join(source, "node_modules/@muse-code/sdk/dist/src/dependency.js"),
		"export const value = 1;"
	);
	await pack(false);
	assert.throws(() => verifyPackagedPayload(app, ["arm64"]), /must be unpacked/);
	await pack();
	assert.equal(verifyPackagedPayload(app, ["arm64"]).sdkVersion, "1.4.14");
	write(path.join(source, "out", "controlled-smoke-report.json"), "{}");
	await pack();
	assert.throws(() => verifyPackagedPayload(app, ["arm64"]), /acceptance artifacts/);
	fs.unlinkSync(path.join(source, "out", "controlled-smoke-report.json"));
	write(path.join(source, ".env"), "INERT_CONTROLLED_TEST=true");
	await pack();
	assert.throws(() => verifyPackagedPayload(app, ["arm64"]), /local configuration/);
	fs.unlinkSync(path.join(source, ".env"));
	await pack();
	fs.mkdirSync(path.join(resources, "demo"));
	assert.throws(() => verifyPackagedPayload(app, ["arm64"]), /demo repositories/);
});
