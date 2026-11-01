// Inert headers and injected command responses only. No signing, keychain or native tools.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { verifyApp } = require("./verify-app.cjs");
const { requireSigningCredentials } = require("./credentials.cjs");

function bundle(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "musefocus-signature-policy-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const app = path.join(root, "MuseFocus.app");
	const binaries = [
		"Contents/MacOS/MuseFocus",
		"Contents/Frameworks/Private.framework/Versions/A/Private",
		"Contents/Resources/voice/metahackathon-voice",
		"Contents/Resources/voice/_internal/native.so",
		"Contents/Resources/voice/_internal/native.dylib",
		"Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
	];
	for (const relative of binaries) {
		const file = path.join(app, relative);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, Buffer.from("cffaedfe00000000", "hex"));
	}
	const plist = {
		CFBundleIdentifier: "app.musefocus.desktop",
		CFBundleName: "MuseFocus",
		CFBundleDisplayName: "MuseFocus",
		CFBundleExecutable: "MuseFocus",
		NSMicrophoneUsageDescription: "Start a hands-free voice conversation with Muse.",
	};
	const calls = [];
	const signatures = new Map();
	const signature =
		"Identifier=app.musefocus.desktop\nAuthority=Developer ID Application: Controlled Test\nTeamIdentifier=TESTTEAM01\nCodeDirectory flags=0x10000(runtime)\n";
	let entitlement = "<key>com.apple.security.device.audio-input</key><true/>";
	const run = (program, args) => {
		calls.push({ program, args });
		if (program === "/usr/bin/plutil") return `${plist[args[1]]}\n`;
		if (program === "/usr/bin/file") return "Mach-O 64-bit executable arm64";
		assert.equal(program, "/usr/bin/codesign");
		if (args.includes("--entitlements")) return entitlement;
		if (args.includes("--display")) return signatures.get(args.at(-1)) ?? signature;
		assert.ok(args.includes("--verify") && args.includes("--strict"));
		return "";
	};
	return {
		app,
		binaries,
		plist,
		calls,
		signatures,
		signature,
		run,
		setEntitlement: (value) => {
			entitlement = value;
		},
	};
}

test("MuseFocus release identity keeps every nested Mach-O signature check", (t) => {
	const probe = bundle(t);
	const result = verifyApp(probe.app, "TESTTEAM01", probe.run);
	assert.equal(result.appId, "app.musefocus.desktop");
	assert.equal(result.productName, "MuseFocus");
	assert.deepEqual(result.binaries.sort(), probe.binaries.sort());
	assert.ok(probe.calls.some(({ args }) => args.includes("--deep") && args.at(-1) === probe.app));
	for (const binary of probe.binaries) {
		assert.ok(
			probe.calls.some(
				({ args }) => args.includes("--verify") && args.at(-1) === path.join(probe.app, binary)
			)
		);
	}
});

test("old bundle paths, plist identity and signed identifiers cannot pass as MuseFocus", (t) => {
	const probe = bundle(t);
	assert.throws(() => verifyApp(probe.app, "", probe.run), /APPLE_TEAM_ID/);
	assert.throws(
		() =>
			verifyApp(path.join(path.dirname(probe.app), "MetaHackathon.app"), "TESTTEAM01", probe.run),
		/Release bundle must be MuseFocus.app/
	);
	assert.equal(probe.calls.length, 0);
	for (const key of [
		"CFBundleIdentifier",
		"CFBundleName",
		"CFBundleDisplayName",
		"CFBundleExecutable",
	]) {
		const expected = probe.plist[key];
		probe.plist[key] = key === "CFBundleIdentifier" ? "com.metahackathon.app" : "MetaHackathon";
		assert.throws(() => verifyApp(probe.app, "TESTTEAM01", probe.run), new RegExp(key));
		probe.plist[key] = expected;
	}
	probe.signatures.set(
		probe.app,
		probe.signature.replace(
			"Identifier=app.musefocus.desktop",
			"Identifier=app.musefocus.desktop.other"
		)
	);
	assert.throws(() => verifyApp(probe.app, "TESTTEAM01", probe.run), /Signed app identifier/);
});

test("MuseFocus metadata never substitutes for Developer ID, hardened runtime or microphone policy", (t) => {
	const probe = bundle(t);
	for (const [signature, expected] of [
		[
			probe.signature.replace("Authority=Developer ID Application:", "Authority=adhoc:"),
			/Developer ID/,
		],
		[
			probe.signature.replace("TeamIdentifier=TESTTEAM01", "TeamIdentifier=OTHERTEAM1"),
			/Developer ID/,
		],
		[probe.signature.replace("(runtime)", "(none)"), /Hardened Runtime/],
	]) {
		probe.signatures.set(probe.app, signature);
		assert.throws(() => verifyApp(probe.app, "TESTTEAM01", probe.run), expected);
	}
	probe.signatures.clear();
	probe.setEntitlement("<key>com.apple.security.device.audio-input</key><false/>");
	assert.throws(() => verifyApp(probe.app, "TESTTEAM01", probe.run), /audio-input entitlement/);
	probe.plist.NSMicrophoneUsageDescription = "Hold Space to talk";
	assert.throws(() => verifyApp(probe.app, "TESTTEAM01", probe.run), /Start\/End hands-free/);
});

test("nested frameworks, voice and SQLite retain signature and executable hardening checks", (t) => {
	const probe = bundle(t);
	for (const relative of probe.binaries) {
		for (const [signature, expected] of [
			[
				probe.signature.replace("Authority=Developer ID Application:", "Authority=adhoc:"),
				/ad-hoc/,
			],
			[
				probe.signature.replace("TeamIdentifier=TESTTEAM01", "TeamIdentifier=OTHERTEAM1"),
				/foreign-team/,
			],
			[probe.signature.replace("(runtime)", "(none)"), /missing Hardened Runtime/],
		]) {
			probe.signatures.set(path.join(probe.app, relative), signature);
			assert.throws(() => verifyApp(probe.app, "TESTTEAM01", probe.run), expected);
		}
		probe.signatures.clear();
	}
});

test("five-input signing contract fails closed without exposing controlled credential values", () => {
	const env = Object.fromEntries(
		[
			"CSC_LINK",
			"CSC_KEY_PASSWORD",
			"APPLE_ID",
			"APPLE_APP_SPECIFIC_PASSWORD",
			"APPLE_TEAM_ID",
		].map((name) => [name, `controlled-${name}`])
	);
	assert.doesNotThrow(() => requireSigningCredentials(env));
	for (const name of Object.keys(env)) {
		assert.throws(
			() => requireSigningCredentials({ ...env, [name]: "" }),
			(error) => {
				assert.ok(error.message.includes(name));
				assert.ok(!error.message.includes("controlled-"));
				return true;
			}
		);
	}
	assert.throws(
		() => requireSigningCredentials({ ...env, CSC_IDENTITY_AUTO_DISCOVERY: "false" }),
		/CSC_IDENTITY_AUTO_DISCOVERY must not be false/
	);
});
