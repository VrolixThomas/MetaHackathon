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
	return name;
}

function refreshUpdateInfo(outputDir, changedFiles) {
	const manifestPath = path.join(outputDir, "latest-mac.yml");
	const manifest = yaml.load(fs.readFileSync(manifestPath, "utf8"));
	if (!Array.isArray(manifest.files)) throw new Error("Update manifest has no files");
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
	for (const entry of manifest.files) {
		const name = artifactName(entry.url);
		if (hashFile(path.join(outputDir, name)) !== entry.sha512)
			throw new Error(`Update artifact hash mismatch: ${name}`);
	}
	if (
		!manifest.path ||
		hashFile(path.join(outputDir, artifactName(manifest.path))) !== manifest.sha512
	)
		throw new Error("Legacy update path/hash does not match its artifact");
	fs.writeFileSync(manifestPath, yaml.dump(manifest, { lineWidth: -1 }));
	return manifest.files.map(({ url, sha512, size }) => ({ url, sha512, size }));
}

module.exports = { hashFile, refreshUpdateInfo };
