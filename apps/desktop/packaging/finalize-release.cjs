const fs = require("node:fs");
const path = require("node:path");
const { requireSigningCredentials } = require("./credentials.cjs");
const { command, verifyApp } = require("./verify-app.cjs");
const { refreshUpdateInfo } = require("./refresh-update-info.cjs");

requireSigningCredentials();
const outputDir = path.resolve(process.argv[2] || "dist");
const appPath = path.resolve(process.argv[3] || "dist/mac-arm64/MetaHackathon.app");
const app = verifyApp(appPath, process.env.APPLE_TEAM_ID);
command("/usr/bin/xcrun", ["stapler", "validate", appPath]);
command("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", appPath]);
const dmgs = fs.readdirSync(outputDir).filter((name) => name.endsWith(".dmg"));
const zips = fs.readdirSync(outputDir).filter((name) => name.endsWith(".zip"));
if (
	dmgs.length === 0 ||
	zips.length === 0 ||
	!fs.existsSync(path.join(outputDir, "latest-mac.yml"))
) {
	throw new Error("Release needs a DMG, ZIP, and latest-mac.yml for GitHub updates");
}
const notarization = [];
for (const name of dmgs) {
	const dmg = path.join(outputDir, name);
	command("/usr/bin/hdiutil", ["verify", dmg]);
	command("/usr/bin/codesign", ["--verify", "--strict", dmg]);
	const signature = command("/usr/bin/codesign", ["--display", "--verbose=4", dmg]);
	if (!signature.includes(`TeamIdentifier=${process.env.APPLE_TEAM_ID}`))
		throw new Error(`DMG signature has wrong team: ${name}`);
	// electron-builder notarizes/staples the .app. Submit/staple the final signed DMG too.
	const result = JSON.parse(
		command(
			"/usr/bin/xcrun",
			[
				"notarytool",
				"submit",
				dmg,
				"--wait",
				"--timeout",
				"20m",
				"--output-format",
				"json",
				"--apple-id",
				process.env.APPLE_ID,
				"--password",
				process.env.APPLE_APP_SPECIFIC_PASSWORD,
				"--team-id",
				process.env.APPLE_TEAM_ID,
			],
			21 * 60_000
		)
	);
	fs.writeFileSync(
		path.join(outputDir, `notarization-${name}.json`),
		`${JSON.stringify({ artifact: name, id: result.id, status: result.status, message: result.message }, null, 2)}\n`
	);
	if (result.status !== "Accepted")
		throw new Error(`DMG notarization was not accepted: ${result.status}; submission ${result.id}`);
	command("/usr/bin/xcrun", ["stapler", "staple", dmg]);
	command("/usr/bin/xcrun", ["stapler", "validate", dmg]);
	command("/usr/bin/hdiutil", ["verify", dmg]);
	command("/usr/sbin/spctl", [
		"--assess",
		"--type",
		"open",
		"--context",
		"context:primary-signature",
		"--verbose=4",
		dmg,
	]);
	notarization.push({ artifact: name, id: result.id, status: result.status });
}
const report = {
	verifiedAt: new Date().toISOString(),
	app,
	notarization,
	updateArtifacts: zips.concat("latest-mac.yml"),
	updateFileHashes: refreshUpdateInfo(outputDir, dmgs),
};
fs.writeFileSync(
	path.join(outputDir, "signing-evidence.json"),
	`${JSON.stringify(report, null, 2)}\n`
);
console.log(
	`Verified signed and notarized release: ${dmgs.length} DMG(s), ${app.binaryCount} app binaries`
);
