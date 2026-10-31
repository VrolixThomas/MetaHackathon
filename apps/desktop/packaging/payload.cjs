// Filesystem-only checks. Never execute the app, SDK, sidecar or a provider.
const fs = require("node:fs");
const path = require("node:path");

const cpuNames = new Map([
	[0x0100000c, "arm64"],
	[0x01000007, "x64"],
	[7, "ia32"],
	[12, "arm"],
]);
function targetArchitectures(arch) {
	const name =
		typeof arch === "number" ? ["ia32", "x64", "armv7l", "arm64", "universal"][arch] : arch;
	if (name === "universal") return ["arm64", "x64"];
	if (!["arm64", "x64"].includes(name))
		throw new Error("Packaging supports explicit macOS arm64/x64 targets only");
	return [name];
}

function machoArchitectures(file) {
	const fd = fs.openSync(file, "r");
	const buffer = Buffer.alloc(4096);
	let size;
	try {
		size = fs.readSync(fd, buffer, 0, buffer.length, 0);
	} finally {
		fs.closeSync(fd);
	}
	const magic = buffer.subarray(0, 4).toString("hex");
	const thin = ["feedface", "feedfacf", "cefaedfe", "cffaedfe"].includes(magic);
	const fat = ["cafebabe", "bebafeca", "cafebabf", "bfbafeca"].includes(magic);
	if (!thin && !fat) return [];
	const little = ["cefaedfe", "cffaedfe", "bebafeca", "bfbafeca"].includes(magic);
	const read = (offset) => (little ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset));
	if (size < 8) throw new Error("Truncated Mach-O header");
	if (thin) return [cpuNames.get(read(4)) || "unknown"];
	const count = read(4);
	const stride = ["cafebabf", "bfbafeca"].includes(magic) ? 32 : 20;
	if (count < 1 || count > 32 || 8 + count * stride > size)
		throw new Error("Invalid Mach-O architecture table");
	return Array.from(
		{ length: count },
		(_, index) => cpuNames.get(read(8 + index * stride)) || "unknown"
	);
}

function* regularFiles(root, directory = root) {
	for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
		const file = path.join(directory, item.name);
		if (item.isSymbolicLink()) {
			const real = fs.realpathSync(file);
			if (real !== root && !real.startsWith(`${root}${path.sep}`))
				throw new Error("Packaged payload has an escaping symlink");
		} else if (item.isDirectory()) yield* regularFiles(root, file);
		else if (item.isFile()) yield file;
		else throw new Error("Packaged payload contains a non-regular entry");
	}
}

function verifyVoiceBundle(directory, architectures) {
	if (!fs.existsSync(directory))
		throw new Error(
			"Frozen voice bundle missing: run services/voice/scripts/freeze.py on the target Mac before packaging"
		);
	if (fs.lstatSync(directory).isSymbolicLink())
		throw new Error("Voice bundle root must be a real directory");
	const root = fs.realpathSync(directory);
	const executable = path.join(root, "metahackathon-voice");
	const stat = fs.lstatSync(executable);
	if (!stat.isFile() || stat.isSymbolicLink() || !(stat.mode & 0o111))
		throw new Error("Frozen voice executable is missing or not executable");
	if (!fs.statSync(path.join(root, "_internal")).isDirectory())
		throw new Error("Frozen voice _internal directory is missing");
	let binaryCount = 0;
	for (const file of regularFiles(root)) {
		const actual = machoArchitectures(file);
		if (!actual.length) continue;
		binaryCount++;
		if (!architectures.every((arch) => actual.includes(arch)))
			throw new Error(`Voice binary architecture mismatch: ${path.relative(root, file)}`);
	}
	if (!machoArchitectures(executable).length || binaryCount < 2)
		throw new Error("Voice payload must contain a native executable and frozen native libraries");
	return { binaryCount, architectures };
}

function verifyPackagedPayload(appPath, architectures) {
	const asar = require("@electron/asar");
	const resources = path.join(appPath, "Contents", "Resources");
	if (fs.existsSync(path.join(resources, "demo")))
		throw new Error("Production app must not bundle demo repositories");
	const archive = path.join(resources, "app.asar");
	const entries = new Set(asar.listPackage(archive).map((entry) => entry.replace(/^\//, "")));
	if (
		Array.from(entries).some((entry) => /(^|\/)\.env($|\.)|(^|\/)fixtures\/demo($|\/)/.test(entry))
	)
		throw new Error("Production archive contains local configuration or demo fixtures");
	const requireFile = (file) => {
		if (!entries.has(file) || asar.statFile(archive, file).size === undefined)
			throw new Error(`Production archive missing ${file}`);
	};
	for (const file of [
		"out/main/index.js",
		"out/main/coding-worker.js",
		"out/preload/index.cjs",
		"out/renderer/index.html",
		"node_modules/@muse-code/sdk/package.json",
	])
		requireFile(file);
	const sdk = JSON.parse(
		asar.extractFile(archive, "node_modules/@muse-code/sdk/package.json").toString()
	);
	const packaged = JSON.parse(asar.extractFile(archive, "package.json").toString());
	if (packaged.dependencies?.["@muse-code/sdk"] !== sdk.version)
		throw new Error("Packaged Muse SDK differs from the pinned production dependency");
	if (!sdk.main || sdk.main.includes("..") || path.isAbsolute(sdk.main))
		throw new Error("Invalid packaged SDK entry point");
	requireFile(`node_modules/@muse-code/sdk/${sdk.main.replace(/^\.\//, "")}`);
	// An SDK entry file alone is insufficient; check the relative JS import graph too.
	for (const file of entries) {
		if (!file.startsWith("node_modules/@muse-code/sdk/dist/") || !file.endsWith(".js")) continue;
		const source = asar.extractFile(archive, file).toString();
		for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*["'](\.[^"']+)["']/g)) {
			requireFile(path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1])));
		}
	}
	const sqlite = "node_modules/better-sqlite3/build/Release/better_sqlite3.node";
	requireFile(sqlite);
	if (
		!asar.statFile(archive, sqlite).unpacked ||
		!fs.statSync(path.join(`${archive}.unpacked`, sqlite)).isFile()
	)
		throw new Error("SQLite native addon must be unpacked");
	if (!Array.from(entries).some((entry) => /^out\/main\/db\/migrations\/.+\.sql$/.test(entry))) {
		// Current SQLite adapters embed additive DDL in the compiled main process.
		const embedded = [...entries]
			.filter((entry) => entry.startsWith("out/main/") && entry.endsWith(".js"))
			.map((entry) => asar.extractFile(archive, entry).toString())
			.join("\n");
		for (const table of [
			"review_connection",
			"review_prepared",
			"review_progress",
			"runtime_submissions",
			"runtime_budgets",
			"hub_state",
			"day_state",
			"knowledge_sources",
			"slack_workspace_head",
		]) {
			if (!new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${table}\\b`, "i").test(embedded))
				throw new Error(`Production SQLite initialization is missing: ${table}`);
		}
	}
	const voice = verifyVoiceBundle(path.join(resources, "voice"), architectures);
	return { sdkVersion: sdk.version, voice };
}

module.exports = {
	machoArchitectures,
	regularFiles,
	targetArchitectures,
	verifyVoiceBundle,
	verifyPackagedPayload,
};
