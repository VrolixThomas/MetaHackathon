const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const yaml = require("js-yaml");
const { hashFile, refreshUpdateInfo, validateUpdateInfo } = require("./refresh-update-info.cjs");

test("final DMG byte changes refresh hashes/blockmap while preserving ZIP updater metadata", (t) => {
	// Synthetic files exercise metadata only; this does not simulate signing success.
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "musefocus-update-test-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const dmg = path.join(directory, "MuseFocus-0.1.0-arm64.dmg");
	const zip = path.join(directory, "MuseFocus-0.1.0-arm64.zip");
	fs.writeFileSync(dmg, Buffer.alloc(65536, 17));
	fs.writeFileSync(zip, Buffer.alloc(65536, 23));
	const zipHash = hashFile(zip);
	const oldDmgHash = hashFile(dmg);
	const manifestPath = path.join(directory, "latest-mac.yml");
	fs.writeFileSync(
		manifestPath,
		yaml.dump({
			version: "0.1.0",
			files: [
				{ url: "MuseFocus-0.1.0-arm64.zip", sha512: zipHash },
				{ url: "MuseFocus-0.1.0-arm64.dmg", sha512: oldDmgHash },
			],
			path: "MuseFocus-0.1.0-arm64.zip",
			sha512: zipHash,
		})
	);
	fs.appendFileSync(dmg, "synthetic ticket data");
	refreshUpdateInfo(directory, ["MuseFocus-0.1.0-arm64.dmg"]);
	const manifest = yaml.load(fs.readFileSync(manifestPath, "utf8"));
	assert.notEqual(manifest.files[1].sha512, oldDmgHash);
	assert.equal(manifest.files[1].sha512, hashFile(dmg));
	assert.equal(manifest.files[1].size, fs.statSync(dmg).size);
	assert.ok(fs.statSync(`${dmg}.blockmap`).size > 0);
	assert.equal(manifest.files[0].sha512, zipHash);
	assert.equal(manifest.path, "MuseFocus-0.1.0-arm64.zip");
	assert.equal(manifest.sha512, zipHash);
	manifest.files[0].sha512 = "wrong";
	fs.writeFileSync(manifestPath, yaml.dump(manifest));
	assert.throws(
		() => refreshUpdateInfo(directory, []),
		/Update artifact hash mismatch: MuseFocus-0.1.0-arm64.zip/
	);
});

test("a stray ZIP cannot satisfy a manifest that omits its updater entry", (t) => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "musefocus-missing-zip-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	fs.writeFileSync(path.join(directory, "MuseFocus-0.1.0-arm64.dmg"), "dmg bytes");
	fs.writeFileSync(path.join(directory, "MuseFocus-0.1.0-arm64.zip"), "zip bytes");
	const dmgHash = hashFile(path.join(directory, "MuseFocus-0.1.0-arm64.dmg"));
	const zipHash = hashFile(path.join(directory, "MuseFocus-0.1.0-arm64.zip"));
	const manifestPath = path.join(directory, "latest-mac.yml");
	const manifest = {
		version: "0.1.0",
		files: [{ url: "MuseFocus-0.1.0-arm64.dmg", sha512: dmgHash }],
		path: "MuseFocus-0.1.0-arm64.dmg",
		sha512: dmgHash,
	};
	fs.writeFileSync(manifestPath, yaml.dump(manifest));
	assert.throws(() => validateUpdateInfo(directory), /updater ZIP/);
	assert.throws(() => refreshUpdateInfo(directory, []), /updater ZIP/);
	manifest.files.push({ url: "MuseFocus-0.1.0-arm64.zip", sha512: zipHash });
	fs.writeFileSync(manifestPath, yaml.dump(manifest));
	assert.throws(() => refreshUpdateInfo(directory, []), /Legacy update path/);
	manifest.path = "MuseFocus-0.1.0-arm64.zip";
	manifest.sha512 = zipHash;
	fs.writeFileSync(manifestPath, yaml.dump(manifest));
	assert.equal(validateUpdateInfo(directory).files.length, 2);
	fs.writeFileSync(path.join(directory, "MuseFocus-0.1.0-arm64.zip"), "changed zip");
	assert.throws(() => validateUpdateInfo(directory), /hash mismatch: MuseFocus-0.1.0-arm64.zip/);
});

test("release metadata refuses stale product names, local probes and nonlocal artifacts", () => {
	for (const name of [
		"MetaHackathon-0.1.0-arm64.zip",
		"MuseFocus-0.1.0-arm64-UNSIGNED-LOCAL.zip",
		"MuseFocus-HelloWorld-0.1.0-arm64-ADHOC-LOCAL.dmg",
		"MuseFocus-0.1.0-UNSIGNED-LOCAL-arm64.zip",
		"../MuseFocus-0.1.0-arm64.zip",
		"https://musefocus.app/MuseFocus-0.1.0-arm64.zip",
	]) {
		const manifest = { files: [{ url: name }], path: name };
		assert.throws(
			() => validateUpdateInfo("unused-controlled-test-directory", manifest),
			/Update metadata must reference/,
			name
		);
	}
});
