import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { LEGACY_CODING_MODEL, NEW_CODING_MODEL } from "./coding-model";
import {
	type CodingTaskInput,
	type CodingWorkerCheckpoint,
	type CodingWorkerPorts,
	runCodingTask,
} from "./coding-worker";
import { CodingToolError, redactCodingText } from "./coding-worker-safety";
import { createCodingWorkerCheckpointStore, createCodingWorkerTools } from "./coding-worker-tools";
import {
	type AgentModelClient,
	MetaApiError,
	type MetaItem,
	type MetaRequest,
} from "./meta-client";

const signal = () => new AbortController().signal;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
function call(id: string, name: string, args: unknown): MetaItem {
	return {
		type: "function_call",
		call_id: id,
		name,
		arguments: JSON.stringify(args),
		status: "completed",
	};
}
function provider(
	choose: (request: MetaRequest, index: number) => MetaItem[] | Promise<MetaItem[]>
): AgentModelClient {
	let index = 0;
	return {
		async *stream(request) {
			assert.equal(request.workload, "quick");
			yield {
				type: "completed",
				response: {
					id: `response-${index}`,
					model: "muse-spark-1.3",
					output: await choose(request, index++),
				},
			};
		},
	};
}
function lastReceipt(request: MetaRequest): Record<string, unknown> {
	const item = [...request.input].reverse().find((item) => item["type"] === "function_call_output");
	assert.equal(typeof item?.["output"], "string");
	return JSON.parse(item?.["output"] as string);
}
const question = (id: string) =>
	call(id, "request_decision", {
		category: "product",
		question: "Should missing values return null?",
		reason: "The ticket does not specify the empty-state behavior.",
		summary: "Inspected the current implementation; waiting for the requested behavior.",
	});

async function fixture(t: TestContext, extraCommands: { command: string; args: string[] }[] = []) {
	const directory = await mkdtemp(join(tmpdir(), "muse-coding-worker-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const worktreePath = join(directory, "worktree");
	await mkdir(worktreePath);
	await writeFile(
		join(worktreePath, "AGENTS.md"),
		"Keep source in src/. Run the existing test script.\n"
	);
	await writeFile(
		join(worktreePath, "README.md"),
		"# Actual temporary test repository\nUse the existing validation command.\n"
	);
	await mkdir(join(worktreePath, "src"));
	await writeFile(join(worktreePath, "src/value.ts"), "export const value = 1;\n");
	await writeFile(
		join(worktreePath, "package.json"),
		JSON.stringify({ scripts: { test: "bun verify.cjs" } })
	);
	await writeFile(
		join(worktreePath, "verify.cjs"),
		"const fs = require('node:fs'); const assert = require('node:assert/strict'); assert.match(fs.readFileSync('src/value.ts', 'utf8'), /value = 2/); assert.equal(Object.keys(process.env).some(k => /TOKEN|SECRET|API_KEY|NODE_OPTIONS/.test(k)), false); console.log('actual temporary check passed');\n"
	);
	const command = { command: process.execPath, args: ["verify.cjs"] };
	const checkpointPath = join(directory, "private", "checkpoint.json");
	const input: CodingTaskInput = {
		jobId: "controlled-job",
		ticket: null,
		repository: "test/controlled",
		worktreePath,
		brief: "Change value to 2 and validate the actual temporary source.",
		checkpointPath,
	};
	const logs: Parameters<CodingWorkerPorts["log"]>[0][] = [];
	const newPorts = (redactText?: (text: string) => string): CodingWorkerPorts => ({
		...createCodingWorkerTools({
			worktreePath,
			allowedCommands: [command, ...extraCommands],
			redactText,
		}),
		...createCodingWorkerCheckpointStore(checkpointPath),
		log: (event) => {
			logs.push(event);
		},
		redactText,
	});
	return { directory, worktreePath, input, command, logs, newPorts };
}

test("controlled Muse loop reads conventions, changes real files, executes a real check and persists complete history", async (t) => {
	const f = await fixture(t);
	let rounds = 0;
	const model = provider((request, index) => {
		rounds++;
		const tools = request.tools?.map((tool) => tool.name);
		assert.deepEqual(tools, [
			"list_files",
			"read_file",
			"write_file",
			"edit_file",
			"run_command",
			"request_decision",
			"finish_work",
		]);
		switch (index) {
			case 0:
				return [call("list", "list_files", {})];
			case 1:
				return [call("agents", "read_file", { path: "AGENTS.md" })];
			case 2:
				return [call("readme", "read_file", { path: "README.md" })];
			case 3:
				return [call("package", "read_file", { path: "package.json" })];
			case 4:
				return [call("source", "read_file", { path: "src/value.ts" })];
			case 5: {
				const source = lastReceipt(request);
				assert.equal(source["text"], "export const value = 1;\n");
				return [
					call("edit", "edit_file", {
						path: "src/value.ts",
						oldText: "value = 1",
						newText: "value = 2",
						expectedSha256: source["sha256"],
					}),
				];
			}
			case 6:
				return [
					call("write", "write_file", {
						path: "src/nested/actual.txt",
						content: "created by an actual scoped tool\n",
						expectedSha256: null,
					}),
				];
			case 7:
				return [call("check", "run_command", f.command)];
			case 8: {
				const check = lastReceipt(request);
				assert.equal(check["exitCode"], 0);
				assert.match(String(check["stdout"]), /actual temporary check passed/);
				return [
					call("finish", "finish_work", {
						summary:
							"Changed value to 2 and created the requested file. The temporary validation process passed.",
					}),
				];
			}
			default:
				throw new Error("Unexpected additional model round");
		}
	});
	const result = await runCodingTask(model, f.input, f.newPorts(), signal());
	assert.equal(result.status, "completed");
	assert.match(
		result.summary,
		/Recorded worker receipts: wrote src\/value.ts, src\/nested\/actual.txt/
	);
	assert.match(result.summary, /exit 0/);
	assert.equal(
		await readFile(join(f.worktreePath, "src/value.ts"), "utf8"),
		"export const value = 2;\n"
	);
	assert.equal(
		await readFile(join(f.worktreePath, "src/nested/actual.txt"), "utf8"),
		"created by an actual scoped tool\n"
	);
	const saved: CodingWorkerCheckpoint = JSON.parse(await readFile(f.input.checkpointPath, "utf8"));
	assert.equal(saved.pendingTool, null);
	assert.equal(saved.result?.status, "completed");
	assert.equal(saved.history.filter((item) => item["type"] === "function_call_output").length, 9);
	assert.equal((await lstat(f.input.checkpointPath)).mode & 0o777, 0o600);
	assert.deepEqual(await runCodingTask(model, f.input, f.newPorts(), signal()), result);
	assert.equal(rounds, 9, "completed result restores without replaying model/tools");
});

test("queued decision restores history across new ports and resumes only with new coordinator context", async (t) => {
	const f = await fixture(t);
	const paused = await runCodingTask(
		provider((_, index) =>
			index === 0 ? [call("source", "read_file", { path: "src/value.ts" })] : [question("decision")]
		),
		f.input,
		f.newPorts(),
		signal()
	);
	assert.equal(paused.status, "needs-input");
	assert.match(paused.question ?? "", /return null/);
	const noCalls = provider(() => {
		throw new Error("Paused job must not restart");
	});
	assert.deepEqual(await runCodingTask(noCalls, f.input, f.newPorts(), signal()), paused);
	const result = await runCodingTask(
		provider((request, index) => {
			assert.match(JSON.stringify(request.input), /Return null for missing values/);
			assert.match(JSON.stringify(request.input), /request_decision/);
			if (index === 0) return [call("read-after-answer", "read_file", { path: "src/value.ts" })];
			if (index === 1)
				return [
					call("edit-after-answer", "edit_file", {
						path: "src/value.ts",
						oldText: "value = 1",
						newText: "value = 2",
						expectedSha256: lastReceipt(request)["sha256"],
					}),
				];
			if (index === 2) return [call("check-after-answer", "run_command", f.command)];
			return [
				call("done-after-answer", "finish_work", {
					summary: "Implemented the confirmed decision and validated the change.",
				}),
			];
		}),
		{
			...f.input,
			decisionContext: "Return null for missing values; implement the current ticket.",
		},
		f.newPorts(),
		signal()
	);
	assert.equal(result.status, "completed");
});

test("crash after a real edit but before receipt persistence never replays the unconfirmed operation", async (t) => {
	const f = await fixture(t);
	const ports = f.newPorts();
	const save = ports.saveCheckpoint;
	ports.saveCheckpoint = async (path, state) => {
		if (
			!state.pendingTool &&
			state.history.some(
				(item) => item["call_id"] === "edit-crash" && item["type"] === "function_call_output"
			)
		)
			throw new Error("Controlled persistence failure");
		await save(path, state);
	};
	await assert.rejects(
		runCodingTask(
			provider((request, index) =>
				index === 0
					? [call("read", "read_file", { path: "src/value.ts" })]
					: [
							call("edit-crash", "edit_file", {
								path: "src/value.ts",
								oldText: "value = 1",
								newText: "value = 2",
								expectedSha256: lastReceipt(request)["sha256"],
							}),
						]
			),
			f.input,
			ports,
			signal()
		),
		/Controlled persistence failure/
	);
	assert.match(await readFile(join(f.worktreePath, "src/value.ts"), "utf8"), /value = 2/);
	assert.equal(
		JSON.parse(await readFile(f.input.checkpointPath, "utf8")).pendingTool.name,
		"edit_file"
	);
	const result = await runCodingTask(
		provider(() => {
			throw new Error("Must reconcile before contacting model");
		}),
		f.input,
		f.newPorts(),
		signal()
	);
	assert.equal(result.status, "needs-input");
	assert.match(result.summary, /unconfirmed/);
	const saved = await readFile(f.input.checkpointPath, "utf8");
	assert.match(saved, /unconfirmed/);
	assert.doesNotMatch(saved, /submitted-for-independent-validation/);
	const resumed = await runCodingTask(
		provider((request, index) => {
			assert.match(JSON.stringify(request.input), /do not replay/i);
			if (index === 0) return [call("reconcile-read", "read_file", { path: "src/value.ts" })];
			if (index === 1) {
				assert.match(String(lastReceipt(request)["text"]), /value = 2/);
				return [call("reconcile-check", "run_command", f.command)];
			}
			return [
				call("reconcile-finish", "finish_work", {
					summary:
						"Inspected the prior edit and ran the real check; the original edit was not replayed.",
				}),
			];
		}),
		{
			...f.input,
			decisionContext: "Inspect the worktree and reconcile the interrupted edit before proceeding.",
		},
		f.newPorts(),
		signal()
	);
	assert.equal(resumed.status, "completed");
});

test("provider cancellation is prompt even when an adapter ignores abort, with no fabricated completion", async (t) => {
	const f = await fixture(t);
	const controller = new AbortController();
	let started: () => void = () => {};
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	const client: AgentModelClient = {
		async *stream() {
			started();
			await new Promise(() => {});
		},
	};
	const pending = runCodingTask(client, f.input, f.newPorts(), controller.signal);
	await ready;
	controller.abort();
	await assert.rejects(pending, { name: "AbortError" });
	const checkpoint = JSON.parse(await readFile(f.input.checkpointPath, "utf8"));
	assert.equal(checkpoint.result, null);
	assert.equal(checkpoint.pendingTool, null);
	assert.equal(checkpoint.history.length, 1);
});

test("cancellation after a file effect retains pending intent and requires honest reconciliation", async (t) => {
	const f = await fixture(t);
	const controller = new AbortController();
	const ports = f.newPorts();
	const actualWrite = ports.writeFile;
	ports.writeFile = async (input, workSignal) => {
		const result = await actualWrite(input, workSignal);
		controller.abort();
		return result;
	};
	await assert.rejects(
		runCodingTask(
			provider(() => [
				call("cancelled-write", "write_file", {
					path: "src/new.txt",
					content: "actual effect\n",
					expectedSha256: null,
				}),
			]),
			f.input,
			ports,
			controller.signal
		),
		{ name: "AbortError" }
	);
	assert.equal(await readFile(join(f.worktreePath, "src/new.txt"), "utf8"), "actual effect\n");
	const restored = await runCodingTask(
		provider(() => {
			throw new Error("No replay");
		}),
		f.input,
		f.newPorts(),
		signal()
	);
	assert.equal(restored.status, "needs-input");
	assert.match(restored.reason ?? "", /No operation was replayed/);
});

test("one output-limit retry happens before effects; provider failures do not become demo results", async (t) => {
	const f = await fixture(t);
	let attempts = 0;
	const requests: number[] = [];
	const client: AgentModelClient = {
		async *stream(request) {
			requests.push(request.maxOutputTokens ?? 0);
			if (attempts++ === 0) {
				yield { type: "text", delta: "partial unfinished proposal" };
				throw new MetaApiError("Controlled output limit", null, null, "output-limit");
			}
			yield {
				type: "completed",
				response: { id: "retry", model: "muse-spark-1.3", output: [question("after-retry")] },
			};
		},
	};
	const result = await runCodingTask(client, f.input, f.newPorts(), signal());
	assert.equal(result.status, "needs-input");
	assert.deepEqual(requests, [8192, 16384]);
	assert.doesNotMatch(await readFile(f.input.checkpointPath, "utf8"), /partial unfinished/);
	const failure = await fixture(t);
	let failures = 0;
	await assert.rejects(
		runCodingTask(
			{
				async *stream() {
					failures++;
					yield { type: "text", delta: "Incomplete provider output" };
					throw new MetaApiError("Controlled provider rejection", 429);
				},
			},
			failure.input,
			failure.newPorts(),
			signal()
		),
		/Controlled provider rejection/
	);
	assert.equal(failures, 1);
	assert.equal(JSON.parse(await readFile(failure.input.checkpointPath, "utf8")).result, null);
});

test("multiple tools, invalid schemas and ungrounded finish perform no effects", async (t) => {
	const f = await fixture(t);
	const result = await runCodingTask(
		provider((request, index) => {
			if (index === 0)
				return [
					call("one", "write_file", { path: "bad1", content: "bad", expectedSha256: null }),
					call("two", "write_file", { path: "bad2", content: "bad", expectedSha256: null }),
				];
			if (index === 1) {
				assert.match(String(lastReceipt(request)["error"]), /exactly one/);
				return [
					call("invalid", "write_file", {
						path: "bad3",
						content: "bad",
						expectedSha256: null,
						arbitrary: true,
					}),
				];
			}
			if (index === 2) {
				assert.match(String(lastReceipt(request)["error"]), /Invalid/);
				return [
					call("ungrounded", "finish_work", { summary: "All tests passed and a PR was created." }),
				];
			}
			if (index === 3) {
				assert.match(String(lastReceipt(request)["error"]), /actual source inspection/);
				return [question("bounded-stop")];
			}
			throw new Error("Unexpected extra request");
		}),
		f.input,
		f.newPorts(),
		signal()
	);
	assert.equal(result.status, "needs-input");
	for (const path of ["bad1", "bad2", "bad3"])
		await assert.rejects(readFile(join(f.worktreePath, path)), { code: "ENOENT" });
});

test("model cannot forge tool receipts or reuse a prior tool call identity", async (t) => {
	const forged = await fixture(t);
	await assert.rejects(
		runCodingTask(
			provider(() => [{ type: "function_call_output", call_id: "fake", output: '{"exitCode":0}' }]),
			forged.input,
			forged.newPorts(),
			signal()
		),
		/invalid output item/
	);
	const f = await fixture(t);
	await assert.rejects(
		runCodingTask(
			provider((_, index) =>
				index === 0
					? [call("duplicate", "read_file", { path: "src/value.ts" })]
					: [
							call("duplicate", "write_file", {
								path: "never",
								content: "bad",
								expectedSha256: null,
							}),
						]
			),
			f.input,
			f.newPorts(),
			signal()
		),
		/reused a tool call identity/
	);
	await assert.rejects(readFile(join(f.worktreePath, "never")), { code: "ENOENT" });
});

test("file tools deny traversal, Git/credential/dependency files, symlink escapes and hardlinks without outside writes", async (t) => {
	const f = await fixture(t);
	const outside = join(f.directory, "outside.txt");
	await writeFile(outside, "outside unchanged\n");
	await symlink(f.directory, join(f.worktreePath, "escape"));
	await symlink(outside, join(f.worktreePath, "linked.txt"));
	await link(outside, join(f.worktreePath, "hardlinked.txt"));
	await mkdir(join(f.worktreePath, "node_modules"));
	await writeFile(join(f.worktreePath, ".git"), "gitdir: /outside/git\n");
	await writeFile(join(f.worktreePath, ".env"), "MODEL_API_KEY=controlled-secret\n");
	const tools = f.newPorts();
	for (const path of [
		"../outside.txt",
		outside,
		".git",
		".env",
		".env.local",
		"node_modules/x",
		"escape/outside.txt",
		"linked.txt",
		"hardlinked.txt",
		"src/../../outside.txt",
		"src\\outside.txt",
	]) {
		await assert.rejects(tools.readFile({ path, startLine: 1 }, signal()), CodingToolError);
		await assert.rejects(
			tools.writeFile({ path, content: "bad\n", expectedSha256: null }, signal()),
			CodingToolError
		);
	}
	const entries = (await tools.listFiles({ path: ".", maxEntries: 200 }, signal())).entries.map(
		(entry) => entry.path
	);
	assert.ok(
		!entries.includes(".env") &&
			!entries.includes(".git") &&
			!entries.includes("node_modules") &&
			!entries.includes("escape")
	);
	assert.equal(await readFile(outside, "utf8"), "outside unchanged\n");
});

test("edits require observed current hash and unique text; stale/new-file overwrites are rejected", async (t) => {
	const f = await fixture(t);
	const tools = f.newPorts();
	const original = "export const value = 1;\n";
	await assert.rejects(
		tools.editFile(
			{ path: "src/value.ts", oldText: "1", newText: "2", expectedSha256: sha(original) },
			signal()
		),
		/Read the current file/
	);
	const read = await tools.readFile({ path: "src/value.ts", startLine: 1 }, signal());
	await writeFile(join(f.worktreePath, "src/value.ts"), `${original}// external change\n`);
	await assert.rejects(
		tools.writeFile(
			{ path: "src/value.ts", content: "overwrite", expectedSha256: read.sha256 },
			signal()
		),
		/has changed/
	);
	await assert.rejects(
		tools.writeFile({ path: "src/value.ts", content: "overwrite", expectedSha256: null }, signal()),
		/has changed/
	);
	await writeFile(join(f.worktreePath, "src/value.ts"), "same same\n");
	const current = await tools.readFile({ path: "src/value.ts", startLine: 1 }, signal());
	await assert.rejects(
		tools.editFile(
			{ path: "src/value.ts", oldText: "same", newText: "changed", expectedSha256: current.sha256 },
			signal()
		),
		/exactly one/
	);
	assert.equal(await readFile(join(f.worktreePath, "src/value.ts"), "utf8"), "same same\n");
});

test("credential filtering covers provider context, persisted history, command output and source replacement", async (t) => {
	const f = await fixture(t);
	const secret = "controlled-secret-known-to-main-9824";
	const redact = (text: string) => redactCodingText(text, [secret]);
	await writeFile(
		join(f.worktreePath, "src/config.ts"),
		`export const credential = '${secret}';\n`
	);
	await writeFile(join(f.worktreePath, "verify.cjs"), `console.log('${secret}');\n`);
	const ports = f.newPorts(redact);
	const result = await runCodingTask(
		provider((request, index) => {
			assert.ok(!JSON.stringify(request).includes(secret));
			if (index === 0) return [call("read-config", "read_file", { path: "src/config.ts" })];
			if (index === 1) {
				assert.equal(lastReceipt(request)["redacted"], true);
				return [
					call("replace-secret-source", "write_file", {
						path: "src/config.ts",
						content: "clean replacement\n",
						expectedSha256: lastReceipt(request)["sha256"],
					}),
				];
			}
			if (index === 2) {
				assert.equal(lastReceipt(request)["error"], "credential");
				return [call("secret-output", "run_command", f.command)];
			}
			if (index === 3) {
				assert.match(String(lastReceipt(request)["stdout"]), /REDACTED/);
				return [question("safe-stop")];
			}
			throw new Error("Unexpected round");
		}),
		{ ...f.input, brief: `Inspect the current source. Private coordinator context: ${secret}` },
		ports,
		signal()
	);
	assert.equal(result.status, "needs-input");
	assert.ok(!JSON.stringify(f.logs).includes(secret));
	assert.ok(!(await readFile(f.input.checkpointPath, "utf8")).includes(secret));
	assert.ok((await readFile(join(f.worktreePath, "src/config.ts"), "utf8")).includes(secret));
});

test("direct argv commands omit provider environment and never interpolate shell metacharacters", async (t) => {
	const args = ["args.cjs", "$(touch unexpected.txt); `touch also-unexpected.txt`"];
	const f = await fixture(t, [{ command: process.execPath, args }]);
	await writeFile(
		join(f.worktreePath, "args.cjs"),
		"console.log(JSON.stringify({args:process.argv.slice(2),env:Object.keys(process.env)}));\n"
	);
	const result = await f
		.newPorts()
		.runCommand({ command: process.execPath, args, timeoutMs: 10000 }, signal());
	assert.equal(result.exitCode, 0);
	const actual = JSON.parse(result.stdout);
	assert.deepEqual(actual.args, [args[1]]);
	assert.ok(
		!actual.env.some((key: string) => /TOKEN|SECRET|API_KEY|NODE_OPTIONS|BUN_OPTIONS/.test(key))
	);
	await assert.rejects(readFile(join(f.worktreePath, "unexpected.txt")), { code: "ENOENT" });
	await assert.rejects(readFile(join(f.worktreePath, "also-unexpected.txt")), { code: "ENOENT" });
});

test("default command policy permits the existing real test script and rejects altered scripts, Git writes and shells", async (t) => {
	const f = await fixture(t);
	const ports = f.newPorts();
	await ports.readFile({ path: "package.json", startLine: 1 }, signal());
	await writeFile(join(f.worktreePath, "src/value.ts"), "export const value = 2;\n");
	const result = await ports.runCommand(
		{ command: "bun", args: ["run", "test"], timeoutMs: 10000 },
		signal()
	);
	assert.equal(result.exitCode, 0, result.stderr);
	assert.match(result.stdout, /actual temporary check passed/);
	await writeFile(
		join(f.worktreePath, "package.json"),
		JSON.stringify({ scripts: { test: "bun other.cjs" } })
	);
	for (const [command, args] of [
		["bun", ["run", "test"]],
		["git", ["push"]],
		["sh", ["-c", "true"]],
		["bun", ["install"]],
		["bun", ["run", "dev"]],
	] as const) {
		await assert.rejects(
			ports.runCommand({ command, args: [...args], timeoutMs: 10000 }, signal()),
			/existing validation script/
		);
	}
});

test("real command cancellation kills the process and timeout/nonzero receipts remain failures", async (t) => {
	const slow = { command: process.execPath, args: ["slow.cjs"] };
	const fail = { command: process.execPath, args: ["fail.cjs"] };
	const f = await fixture(t, [slow, fail]);
	await writeFile(
		join(f.worktreePath, "slow.cjs"),
		"require('node:fs').writeFileSync('pid.txt', String(process.pid)); setInterval(() => {}, 1000);\n"
	);
	await writeFile(
		join(f.worktreePath, "fail.cjs"),
		"console.error('actual controlled failure'); process.exit(7);\n"
	);
	const ports = f.newPorts();
	const controller = new AbortController();
	const running = ports.runCommand({ ...slow, timeoutMs: 10000 }, controller.signal);
	let pid = 0;
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			pid = Number(await readFile(join(f.worktreePath, "pid.txt"), "utf8"));
			break;
		} catch {
			await delay(10);
		}
	}
	assert.ok(pid > 0);
	controller.abort();
	await assert.rejects(running, { name: "AbortError" });
	assert.throws(() => process.kill(pid, 0));
	const timedOut = await ports.runCommand({ ...slow, timeoutMs: 100 }, signal());
	assert.equal(timedOut.interrupted, true);
	assert.equal(timedOut.exitCode, null);
	const failed = await ports.runCommand({ ...fail, timeoutMs: 10000 }, signal());
	assert.equal(failed.exitCode, 7);
	assert.match(failed.stderr, /actual controlled failure/);
	assert.equal(failed.interrupted, false);
});

test("checkpoint identity rejects a different task and the round budget yields a saved needs-input result", async (t) => {
	const f = await fixture(t);
	let rounds = 0;
	const result = await runCodingTask(
		provider(() => {
			rounds++;
			return [
				{
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "Still thinking" }],
				},
			];
		}),
		f.input,
		f.newPorts(),
		signal()
	);
	assert.equal(rounds, 48);
	assert.equal(result.status, "needs-input");
	assert.match(result.summary, /round budget/);
	await assert.rejects(
		runCodingTask(
			provider(() => []),
			{ ...f.input, worktreePath: join(f.directory, "other-worktree") },
			f.newPorts(),
			signal()
		),
		/different task or worktree/
	);
	const store = createCodingWorkerCheckpointStore(f.input.checkpointPath);
	await assert.rejects(
		store.loadCheckpoint(join(f.directory, "other-checkpoint")),
		/path mismatch/
	);
});

test("new feedback and writes after validation require fresh read/check receipts before completion", async (t) => {
	const f = await fixture(t);
	await writeFile(join(f.worktreePath, "src/value.ts"), "export const value = 2;\n");
	const first = await runCodingTask(
		provider((_, index) => {
			if (index === 0) return [call("initial-read", "read_file", { path: "src/value.ts" })];
			if (index === 1) return [call("initial-check", "run_command", f.command)];
			if (index === 2)
				return [
					call("late-write", "write_file", {
						path: "src/added.txt",
						content: "actual late change\n",
						expectedSha256: null,
					}),
				];
			if (index === 3)
				return [
					call("stale-finish", "finish_work", {
						summary: "Ready using the check before the last edit.",
					}),
				];
			if (index === 4) return [call("fresh-check", "run_command", f.command)];
			return [
				call("initial-finish", "finish_work", {
					summary: "Rechecked the real source after the last edit.",
				}),
			];
		}),
		f.input,
		f.newPorts(),
		signal()
	);
	assert.equal(first.status, "completed");
	const resumed = await runCodingTask(
		provider((request, index) => {
			if (index === 0)
				return [call("too-early", "finish_work", { summary: "Ready using old receipts." })];
			if (index === 1) {
				assert.match(String(lastReceipt(request)["error"]), /Recheck after coordinator feedback/);
				return [call("feedback-read", "read_file", { path: "src/value.ts" })];
			}
			if (index === 2) return [call("feedback-check", "run_command", f.command)];
			return [
				call("feedback-finish", "finish_work", {
					summary: "Inspected and reran validation for the coordinator feedback.",
				}),
			];
		}),
		{ ...f.input, validationFeedback: "Independent review requested another source check." },
		f.newPorts(),
		signal()
	);
	assert.equal(resumed.status, "completed");
	const saved = JSON.parse(await readFile(f.input.checkpointPath, "utf8"));
	assert.ok(saved.contextStartIndex > 0);
});

test("overflowing command output is bounded without exposing a clipped credential", async (t) => {
	const emit = { command: process.execPath, args: ["emit.cjs"] };
	const f = await fixture(t, [emit]);
	const secret = "controlled-long-output-secret-9854";
	await writeFile(
		join(f.worktreePath, "emit.cjs"),
		`process.stdout.write('x'.repeat(63990) + '${secret}' + 'x'.repeat(10000));\n`
	);
	const result = await f
		.newPorts((text) => redactCodingText(text, [secret]))
		.runCommand({ ...emit, timeoutMs: 10000 }, signal());
	assert.equal(result.exitCode, 0);
	assert.equal(result.truncated, true);
	assert.match(result.stdout, /bounded capture limit/);
	assert.ok(!result.stdout.includes(secret.slice(0, 10)));
	assert.ok(result.stdout.length < 32000);
});

for (const codingModel of [LEGACY_CODING_MODEL, NEW_CODING_MODEL]) {
	test(`exact ${codingModel.model} pin survives checkpoint reopen, decisions and validation feedback`, async (t) => {
		const f = await fixture(t);
		const input = { ...f.input, codingModel };
		const seen: MetaRequest[] = [];
		const model: AgentModelClient = {
			async *stream(request) {
				seen.push(request);
				assert.deepEqual(request.codingModel, codingModel);
				assert.equal(request.workload, codingModel.model === "muse-spark-1.3" ? "quick" : "deep");
				const durable = JSON.parse(await readFile(input.checkpointPath, "utf8"));
				assert.deepEqual(
					durable.codingModel,
					codingModel,
					"pin is durable before every model request"
				);
				yield {
					type: "completed",
					response: {
						id: `response-${seen.length}`,
						model: codingModel.model,
						output: [question(`question-${seen.length}`)],
					},
				};
			},
		};
		const first = await runCodingTask(model, input, f.newPorts(), signal());
		assert.equal(first.status, "needs-input");
		assert.deepEqual(await runCodingTask(model, f.input, f.newPorts(), signal()), first);
		assert.equal(seen.length, 1, "reopen does not repeat settled work");
		await runCodingTask(
			model,
			{ ...input, decisionContext: "Keep the existing behavior" },
			f.newPorts(),
			signal()
		);
		await runCodingTask(
			model,
			{
				...input,
				decisionContext: "Keep the existing behavior",
				validationFeedback: "Actual check failed",
			},
			f.newPorts(),
			signal()
		);
		assert.equal(seen.length, 3);
		const before = await readFile(input.checkpointPath, "utf8");
		await assert.rejects(
			runCodingTask(
				model,
				{
					...input,
					codingModel:
						codingModel.model === "muse-spark-1.3" ? NEW_CODING_MODEL : LEGACY_CODING_MODEL,
				},
				f.newPorts(),
				signal()
			),
			/checkpoint model changed/
		);
		assert.equal(await readFile(input.checkpointPath, "utf8"), before);
		assert.equal(seen.length, 3);
	});
}

test("legacy checkpoint missing model keeps Spark and rejects new-model resume before effects", async (t) => {
	const f = await fixture(t);
	await runCodingTask(
		provider(() => [question("old")]),
		f.input,
		f.newPorts(),
		signal()
	);
	const stored = JSON.parse(await readFile(f.input.checkpointPath, "utf8"));
	Reflect.deleteProperty(stored, "codingModel");
	await writeFile(f.input.checkpointPath, JSON.stringify(stored));
	const before = await readFile(f.input.checkpointPath, "utf8");
	await assert.rejects(
		runCodingTask(
			provider(() => {
				throw Error("must not request");
			}),
			{ ...f.input, codingModel: NEW_CODING_MODEL },
			f.newPorts(),
			signal()
		),
		/checkpoint model changed/
	);
	assert.equal(await readFile(f.input.checkpointPath, "utf8"), before);
	await runCodingTask(
		provider((request) => {
			assert.deepEqual(request.codingModel, LEGACY_CODING_MODEL);
			return [question("resumed")];
		}),
		{ ...f.input, decisionContext: "Continue existing behavior" },
		f.newPorts(),
		signal()
	);
});

test("wrong-model response and output retry never change a coding pin", async (t) => {
	const f = await fixture(t);
	let calls = 0;
	const client: AgentModelClient = {
		async *stream(request) {
			calls++;
			assert.deepEqual(request.codingModel, NEW_CODING_MODEL);
			if (calls === 1) throw new MetaApiError("Controlled truncation", null, null, "output-limit");
			yield {
				type: "completed",
				response: { id: "wrong", model: "muse-spark-1.3", output: [question("must-not-apply")] },
			};
		},
	};
	await assert.rejects(
		runCodingTask(client, { ...f.input, codingModel: NEW_CODING_MODEL }, f.newPorts(), signal()),
		/different pinned model/
	);
	assert.equal(calls, 2);
	const stored = JSON.parse(await readFile(f.input.checkpointPath, "utf8"));
	assert.deepEqual(stored.codingModel, NEW_CODING_MODEL);
	assert.equal(stored.result, null);
	assert.equal(stored.pendingTool, null);
});
