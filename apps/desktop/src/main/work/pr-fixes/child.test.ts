import assert from "node:assert/strict";
import type { ChildProcess, ForkOptions, fork } from "node:child_process";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { CodingTaskInput } from "../../agent/coding-worker";
import { runPRFixChild } from "./child";

const input: CodingTaskInput = {
	jobId: "controlled-job",
	ticket: null,
	repository: "test/repo",
	worktreePath: "/owned/worktree",
	brief: "Controlled exact source",
	checkpointPath: "/owned/checkpoint.json",
};
function setup() {
	const child = new EventEmitter() as EventEmitter & {
		stdout: EventEmitter;
		stderr: EventEmitter;
		pid: number;
		connected: boolean;
		send: (value: unknown, callback: (error: Error | null) => void) => void;
		kill: (signal: string) => boolean;
	};
	const state = {
		live: true,
		spawns: 0,
		messages: [] as unknown[],
		signals: [] as string[],
		logs: [] as string[],
		options: undefined as ForkOptions | undefined,
	};
	child.pid = 987654;
	child.connected = true;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.send = (value, callback) => {
		state.messages.push(value);
		callback(null);
	};
	child.kill = (signal) => {
		state.signals.push(signal);
		return true;
	};
	const options = {
		workerEntry: "/main/coding-worker.js",
		envPath: "/main/.env",
		log: (text: string) => {
			state.logs.push(text);
		},
		assertLive: () => {
			if (!state.live) throw new Error("Epoch changed");
		},
		spawn: ((_entry: string, _args: readonly string[], options: ForkOptions) => {
			state.spawns++;
			state.options = options;
			return child as unknown as ChildProcess;
		}) as typeof fork,
	};
	return { child, state, options };
}

test("child uses the existing private run protocol and a credential-safe environment; result waits for exit", async () => {
	const ctx = setup();
	const controller = new AbortController();
	const previous = process.env["PR_FIX_TEST_TOKEN"];
	process.env["PR_FIX_TEST_TOKEN"] = "controlled-secret";
	try {
		let settled = false;
		const running = runPRFixChild(ctx.options, input, controller.signal).then((result) => {
			settled = true;
			return result;
		});
		assert.deepEqual(ctx.state.messages, [{ kind: "run", input, envPath: ctx.options.envPath }]);
		assert.equal(ctx.state.options?.env?.["PR_FIX_TEST_TOKEN"], undefined);
		assert.equal(ctx.state.options?.env?.["ELECTRON_RUN_AS_NODE"], "1");
		assert.deepEqual(ctx.state.options?.execArgv, []);
		assert.equal(ctx.state.options?.serialization, "json");
		ctx.child.emit("message", { kind: "log", text: "Observed worker log" });
		ctx.child.emit("message", {
			kind: "result",
			result: { status: "completed", summary: "Actual child receipt" },
		});
		await Promise.resolve();
		assert.equal(settled, false);
		ctx.child.emit("exit", 0, null);
		assert.equal((await running).summary, "Actual child receipt");
		assert.deepEqual(ctx.state.logs, ["Observed worker log"]);
	} finally {
		if (previous === undefined) Reflect.deleteProperty(process.env, "PR_FIX_TEST_TOKEN");
		else process.env["PR_FIX_TEST_TOKEN"] = previous;
	}
});

test("cancellation terminates the owned child and rejects late completion", async () => {
	const ctx = setup();
	const controller = new AbortController();
	const running = runPRFixChild(ctx.options, input, controller.signal);
	controller.abort();
	assert.ok(ctx.state.signals.includes("SIGTERM"));
	assert.deepEqual(ctx.state.messages[1], { kind: "cancel" });
	ctx.child.emit("message", { kind: "result", result: { status: "completed", summary: "Late" } });
	ctx.child.emit("exit", null, "SIGTERM");
	await assert.rejects(running, /interrupted/);
});

test("an already cancelled or fenced operation never spawns a child", () => {
	const ctx = setup();
	const controller = new AbortController();
	controller.abort();
	assert.throws(() => runPRFixChild(ctx.options, input, controller.signal));
	ctx.state.live = false;
	assert.throws(() => runPRFixChild(ctx.options, input, new AbortController().signal));
	assert.equal(ctx.state.spawns, 0);
});

test("fenced child messages cannot advance another epoch", async () => {
	const ctx = setup();
	const running = runPRFixChild(ctx.options, input, new AbortController().signal);
	ctx.state.live = false;
	ctx.child.emit("message", {
		kind: "result",
		result: { status: "completed", summary: "Old owner result" },
	});
	assert.ok(ctx.state.signals.includes("SIGTERM"));
	ctx.child.emit("exit", 0, null);
	await assert.rejects(running, /interrupted/);
});

test("invalid or failed protocol receipts produce fixed safe failures", async () => {
	for (const event of [
		{ kind: "result", result: { status: "completed" } },
		{ kind: "failed", message: "SECRET provider exception" },
	]) {
		const ctx = setup();
		const running = runPRFixChild(ctx.options, input, new AbortController().signal);
		ctx.child.emit("message", event);
		ctx.child.emit("exit", 1, null);
		await assert.rejects(
			running,
			(error: Error) => !error.message.includes("SECRET") && /coding worker/.test(error.message)
		);
	}
});

test("a result followed by a failed process exit is not completion", async () => {
	const ctx = setup();
	const running = runPRFixChild(ctx.options, input, new AbortController().signal);
	ctx.child.emit("message", { kind: "result", result: { status: "completed", summary: "Claim" } });
	ctx.child.emit("exit", 1, null);
	await assert.rejects(running, /exit cleanly/);
});

test("spawn and send failures do not expose raw errors or fabricate worker results", async () => {
	const ctx = setup();
	ctx.options.spawn = (() => {
		throw new Error("SECRET path");
	}) as typeof fork;
	await assert.rejects(
		runPRFixChild(ctx.options, input, new AbortController().signal),
		/could not launch/
	);
	const sending = setup();
	sending.child.send = (_value, callback) => callback(new Error("SECRET IPC path"));
	const running = runPRFixChild(sending.options, input, new AbortController().signal);
	sending.child.emit("exit", 1, null);
	await assert.rejects(running, /could not receive/);
});
