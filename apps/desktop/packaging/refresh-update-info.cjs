const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const yaml = require("js-yaml");
const { appBuilderPath } = require("app-builder-bin");
const { command } = require("./verify-app.cjs");

function hashFile(file) {
	const hash = crypto.createHash("sha512");
	const fd = fs.openSync(file, "r");
	const buffer = Buffer.alloc(1024 * 1024);
	try {
		while (true) {
			const length = fs.readSync(fd, buffer, 0, buffer.length, null);
			if (length === 0) break;
			hash.update(buffer.subarray(0, length));
		}
	} finally {
		fs.closeSync(fd);
	}
	return hash.digest("base64");
}

function artifactName(url) {
	const name = decodeURIComponent(url);
	if (path.basename(name) !== name || name === "." || name === "..")
		throw new Error("Update metadata must reference local artifact filenames");
	if (
		!/^MuseFocus-[0-9][0-9A-Za-z.+-]*-(?:arm64|x64|universal)\.(?:dmg|zip)$/.test(name) ||
		/(?:UNSIGNED|ADHOC)-LOCAL/i.test(name)
	)
		throw new Error("Update metadata must reference MuseFocus release DMG/ZIP filenames");
	return name;
}

function requireUpdateEntries(manifest) {
	if (!manifest || !Array.isArray(manifest.files) || manifest.files.length === 0)
		throw new Error("Update manifest has no files");
	const names = manifest.files.map((entry) => artifactName(entry.url));
	if (new Set(names).size !== names.length) throw new Error("Duplicate update artifact entries");
	const zips = names.filter((name) => name.endsWith(".zip"));
	if (zips.length === 0) throw new Error("Update manifest must reference the updater ZIP");
	if (!manifest.path || !zips.includes(artifactName(manifest.path)))
		throw new Error("Legacy update path must reference a listed updater ZIP");
}

function validateUpdateInfo(
	outputDir,
	manifest = yaml.load(fs.readFileSync(path.join(outputDir, "latest-mac.yml"), "utf8"))
) {
	requireUpdateEntries(manifest);
	for (const entry of manifest.files) {
		const name = artifactName(entry.url);
		const file = path.join(outputDir, name);
		if (hashFile(file) !== entry.sha512) throw new Error(`Update artifact hash mismatch: ${name}`);
		if (entry.size !== undefined && fs.statSync(file).size !== entry.size)
			throw new Error(`Update artifact size mismatch: ${name}`);
	}
	if (hashFile(path.join(outputDir, artifactName(manifest.path))) !== manifest.sha512)
		throw new Error("Legacy update path/hash does not match its artifact");
	return manifest;
}

function refreshUpdateInfo(outputDir, changedFiles) {
	const manifestPath = path.join(outputDir, "latest-mac.yml");
	const manifest = yaml.load(fs.readFileSync(manifestPath, "utf8"));
	requireUpdateEntries(manifest);
	for (const name of changedFiles) {
		const file = path.join(outputDir, artifactName(name));
		const entry = manifest.files.find((candidate) => artifactName(candidate.url) === name);
		if (!entry) throw new Error(`Update manifest is missing ${name}`);
		// Stapling changes the DMG bytes after electron-builder writes update metadata.
		const blockmap = JSON.parse(
			command(appBuilderPath, ["blockmap", "--input", file, "--output", `${file}.blockmap`])
		);
		entry.blockMapSize = undefined;
		Object.assign(entry, blockmap, { sha512: hashFile(file), size: fs.statSync(file).size });
		if (manifest.path && artifactName(manifest.path) === name) manifest.sha512 = entry.sha512;
	}
	validateUpdateInfo(outputDir, manifest);
	fs.writeFileSync(manifestPath, yaml.dump(manifest, { lineWidth: -1 }));
	return manifest.files.map(({ url, sha512, size }) => ({ url, sha512, size }));
}

module.exports = { artifactName, hashFile, refreshUpdateInfo, validateUpdateInfo };
