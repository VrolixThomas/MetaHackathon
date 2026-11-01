const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function command(program, args, timeout = 120_000) {
	const result = spawnSync(program, args, { encoding: "utf8", timeout });
	if (result.error || result.status !== 0) {
		// Do not include args: notarization commands contain credentials.
		let details = result.stderr || result.stdout || "no output";
		for (const name of ["APPLE_APP_SPECIFIC_PASSWORD", "CSC_KEY_PASSWORD", "CSC_LINK"]) {
			if (process.env[name]) details = details.split(process.env[name]).join("[REDACTED]");
		}
		throw new Error(
			`${path.basename(program)} failed (${result.status ?? result.error?.code}): ${details}`
		);
	}
	return `${result.stdout || ""}${result.stderr || ""}`;
}

function* files(directory) {
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const candidate = path.join(directory, entry.name);
		if (entry.isDirectory()) yield* files(candidate);
		else if (entry.isFile()) yield candidate;
		// Bundle symlinks are verified through their real files, never followed outside the app.
	}
}

const machMagic = new Set([
	"feedface",
	"feedfacf",
	"cefaedfe",
	"cffaedfe",
	"cafebabe",
	"bebafeca",
	"cafebabf",
	"bfbafeca",
]);

function verifyApp(appPath, expectedTeam, run = command) {
	if (!expectedTeam) throw new Error("APPLE_TEAM_ID is required for signature verification");
	if (path.basename(appPath) !== "MuseFocus.app")
		throw new Error("Release bundle must be MuseFocus.app");
	const readPlist = (key) =>
		run("/usr/bin/plutil", [
			"-extract",
			key,
			"raw",
			"-o",
			"-",
			path.join(appPath, "Contents", "Info.plist"),
		]).trim();
	for (const [key, expected] of Object.entries({
		CFBundleIdentifier: "app.musefocus.desktop",
		CFBundleName: "MuseFocus",
		CFBundleDisplayName: "MuseFocus",
		CFBundleExecutable: "MuseFocus",
	})) {
		if (readPlist(key) !== expected) throw new Error(`Release ${key} must be ${expected}`);
	}
	const microphoneDescription = readPlist("NSMicrophoneUsageDescription");
	if (!/hands-free/.test(microphoneDescription) || /Hold Space/.test(microphoneDescription)) {
		throw new Error("App microphone description must explain the Start/End hands-free session");
	}
	run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
	const appSignature = run("/usr/bin/codesign", ["--display", "--verbose=4", appPath]);
	if (!appSignature.split(/\r?\n/).includes("Identifier=app.musefocus.desktop"))
		throw new Error("Signed app identifier must be app.musefocus.desktop");
	if (
		!appSignature.includes("Authority=Developer ID Application:") ||
		!appSignature.includes(`TeamIdentifier=${expectedTeam}`)
	) {
		throw new Error("App must be signed with this team's Developer ID Application certificate");
	}
	if (!/flags=.*\bruntime\b/.test(appSignature)) throw new Error("App is missing Hardened Runtime");
	const entitlements = run("/usr/bin/codesign", ["--display", "--entitlements", "-", appPath]);
	const audioInputXML = /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\s*\/>/.test(
		entitlements
	);
	const audioInputStructured =
		/\[Key\] com\.apple\.security\.device\.audio-input\s*\[Value\]\s*\[Bool\] true(?:\s|$)/.test(
			entitlements
		);
	if (!audioInputXML && !audioInputStructured) {
		throw new Error("App is missing its microphone audio-input entitlement");
	}
	const binaries = [];
	for (const candidate of files(appPath)) {
		const fd = fs.openSync(candidate, "r");
		const header = Buffer.alloc(4);
		try {
			fs.readSync(fd, header, 0, 4, 0);
		} finally {
			fs.closeSync(fd);
		}
		if (!machMagic.has(header.toString("hex"))) continue;
		const kind = run("/usr/bin/file", ["--brief", candidate]);
		if (!/Mach-O/.test(kind)) continue;
		run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", candidate]);
		const signature = run("/usr/bin/codesign", ["--display", "--verbose=4", candidate]);
		if (
			!signature.includes(`TeamIdentifier=${expectedTeam}`) ||
			!signature.includes("Authority=Developer ID Application:")
		) {
			throw new Error(
				`Unsigned, ad-hoc, or foreign-team Mach-O: ${path.relative(appPath, candidate)}`
			);
		}
		if (/executable/.test(kind) && !/flags=.*\bruntime\b/.test(signature)) {
			throw new Error(
				`Executable is missing Hardened Runtime: ${path.relative(appPath, candidate)}`
			);
		}
		binaries.push(path.relative(appPath, candidate));
	}
	if (binaries.length === 0) throw new Error("No Mach-O binaries found in app");
	return {
		appPath,
		appId: "app.musefocus.desktop",
		productName: "MuseFocus",
		team: expectedTeam,
		binaryCount: binaries.length,
		binaries,
	};
}

module.exports = { command, verifyApp };
if (require.main === module)
	console.log(JSON.stringify(verifyApp(process.argv[2], process.env.APPLE_TEAM_ID), null, 2));
