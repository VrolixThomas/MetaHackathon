// Controlled transport/process observation only. Importing this module launches nothing.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const cp = require("node:child_process");
const { basename, resolve } = require("node:path");
const { syncBuiltinESMExports } = require("node:module");
const { promisify } = require("node:util");
function append(path, row) {
	fs.appendFileSync(path, `${JSON.stringify({ ...row, at: Date.now() })}\n`, { mode: 0o600 });
}
function rows(path) {
	return fs.existsSync(path)
		? fs.readFileSync(path, "utf8").split("\n").filter(Boolean).map(JSON.parse)
		: [];
}
function isCLI(command, args = []) {
	return (
		/(?:^|[-_])muse(?:[-_]code)?$/i.test(basename(String(command))) ||
		args.some((arg) => ["msp", "app-server"].includes(arg))
	);
}
function installCLIControl(audit, allowed) {
	const original = {};
	for (const name of ["spawn", "spawnSync", "execFile", "execFileSync"]) {
		original[name] = cp[name];
		cp[name] = function (command, args, ...rest) {
			const argv = Array.isArray(args) ? args : [];
			if (isCLI(command, argv)) {
				const permitted = allowed.includes(resolve(String(command)));
				append(audit, {
					type: "cli-attempt",
					executable: String(command),
					permitted,
					flags: argv
						.filter((arg) => arg.startsWith("-") || ["msp", "login", "app-server"].includes(arg))
						.slice(0, 10),
				});
				assert.ok(
					permitted,
					"Controlled acceptance forbids starting a real installed Muse executable"
				);
			}
			return original[name].call(this, command, args, ...rest);
		};
		if (name === "execFile" && original[name][promisify.custom]) {
			const wrapped = cp[name];
			wrapped[promisify.custom] = (...args) => {
				let child;
				const promise = new Promise((done, reject) => {
					child = wrapped(...args, (error, stdout, stderr) => {
						if (error) {
							error.stdout = stdout;
							error.stderr = stderr;
							reject(error);
						} else done({ stdout, stderr });
					});
				});
				promise.child = child;
				return promise;
			};
		}
	}
	syncBuiltinESMExports();
	return () => {
		for (const [name, method] of Object.entries(original)) cp[name] = method;
		syncBuiltinESMExports();
	};
}
function installChild(audit, allowed, executiveHarness) {
	installCLIControl(audit, allowed);
	let jobId = null;
	process.on("message", (message) => {
		if (message?.kind === "run") {
			const input = message.input;
			jobId = input.jobId;
			append(audit, {
				type: "child-run",
				jobId,
				repository: input.repository,
				worktreePath: input.worktreePath,
				checkpointPath: input.checkpointPath,
			});
		}
	});
	const transport = require(executiveHarness).createChildModelFetch();
	globalThis.fetch = async (input, options) => {
		append(audit, { type: "child-meta-http", jobId });
		return transport(input, options);
	};
}
function childPin(audit, jobId) {
	const run = rows(audit).find((row) => row.type === "child-run" && row.jobId === jobId);
	assert.ok(run, "Actual coding-entry did not receive this job");
	const { dirname, join } = require("node:path");
	const pins = fs
		.readdirSync(dirname(run.checkpointPath))
		.filter((name) => name.startsWith(".coding-provider-") && name.endsWith(".json"))
		.map((name) => {
			const path = join(dirname(run.checkpointPath), name);
			const info = fs.lstatSync(path);
			assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= 32768);
			assert.equal(info.mode & 0o777, 0o600);
			return { path, value: JSON.parse(fs.readFileSync(path, "utf8")) };
		})
		.filter((pin) => pin.value.jobId === jobId);
	assert.equal(pins.length, 1);
	assert.equal(pins[0].value.checkpointPath, run.checkpointPath);
	assert.equal(pins[0].value.worktree.path, fs.realpathSync(run.worktreePath));
	return { run, ...pins[0] };
}
module.exports = { append, rows, isCLI, installCLIControl, installChild, childPin };
