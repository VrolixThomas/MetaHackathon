const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const yaml = require("js-yaml");
const { hashFile, refreshUpdateInfo, validateUpdateInfo } = require("./refresh-update-info.cjs");

test("final DMG byte changes refresh hashes/blockmap while preserving ZIP updater metadata", (t) => {
	// Synthetic files exercise metadata only; this does not simulate signing success.
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "metahackathon-update-test-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const dmg = path.join(directory, "app.dmg");
	const zip = path.join(directory, "app.zip");
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
				{ url: "app.zip", sha512: zipHash },
				{ url: "app.dmg", sha512: oldDmgHash },
			],
			path: "app.zip",
			sha512: zipHash,
		})
	);
	fs.appendFileSync(dmg, "synthetic ticket data");
	refreshUpdateInfo(directory, ["app.dmg"]);
	const manifest = yaml.load(fs.readFileSync(manifestPath, "utf8"));
	assert.notEqual(manifest.files[1].sha512, oldDmgHash);
	assert.equal(manifest.files[1].sha512, hashFile(dmg));
	assert.equal(manifest.files[1].size, fs.statSync(dmg).size);
	assert.ok(fs.statSync(`${dmg}.blockmap`).size > 0);
	assert.equal(manifest.files[0].sha512, zipHash);
	assert.equal(manifest.path, "app.zip");
	assert.equal(manifest.sha512, zipHash);
	manifest.files[0].sha512 = "wrong";
	fs.writeFileSync(manifestPath, yaml.dump(manifest));
	assert.throws(() => refreshUpdateInfo(directory, []), /Update artifact hash mismatch: app.zip/);
});

test("a stray ZIP cannot satisfy a manifest that omits its updater entry", (t) => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "metahackathon-missing-zip-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	fs.writeFileSync(path.join(directory, "app.dmg"), "dmg bytes");
	fs.writeFileSync(path.join(directory, "app.zip"), "zip bytes");
	const dmgHash = hashFile(path.join(directory, "app.dmg"));
	const zipHash = hashFile(path.join(directory, "app.zip"));
	const manifestPath = path.join(directory, "latest-mac.yml");
	const manifest = {
		version: "0.1.0",
		files: [{ url: "app.dmg", sha512: dmgHash }],
		path: "app.dmg",
		sha512: dmgHash,
	};
	fs.writeFileSync(manifestPath, yaml.dump(manifest));
	assert.throws(() => validateUpdateInfo(directory), /updater ZIP/);
	assert.throws(() => refreshUpdateInfo(directory, []), /updater ZIP/);
	manifest.files.push({ url: "app.zip", sha512: zipHash });
	fs.writeFileSync(manifestPath, yaml.dump(manifest));
	assert.throws(() => refreshUpdateInfo(directory, []), /Legacy update path/);
	manifest.path = "app.zip";
	manifest.sha512 = zipHash;
	fs.writeFileSync(manifestPath, yaml.dump(manifest));
	assert.equal(validateUpdateInfo(directory).files.length, 2);
	fs.writeFileSync(path.join(directory, "app.zip"), "changed zip");
	assert.throws(() => validateUpdateInfo(directory), /hash mismatch: app.zip/);
});
