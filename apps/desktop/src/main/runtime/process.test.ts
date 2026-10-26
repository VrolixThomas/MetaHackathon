import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runProcess } from "./process";

async function assertProcessGone(pid: number) {
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
			throw error;
		}
		await delay(10);
	}
	assert.fail(`Owned descendant ${pid} remained after cleanup`);
}

test("captures argument-array output and nonzero exit without shell expansion", async () => {
	const result = await runProcess({
		command: process.execPath,
		args: [
			"-e",
			"process.stdout.write(process.argv[1]); process.stderr.write('error'); process.exit(3)",
			"$(echo unsafe)",
		],
		cwd: process.cwd(),
	});
	assert.equal(result.exitCode, 3);
	assert.equal(result.stdout, "$(echo unsafe)");
	assert.equal(result.stderr, "error");
	assert.equal(result.timedOut, false);
	assert.equal(result.aborted, false);
});

test("bounds total captured output while draining the child", async () => {
	const result = await runProcess({
		command: process.execPath,
		args: [
			"-e",
			"process.stdout.write('x'.repeat(500000)); process.stderr.write('y'.repeat(500000))",
		],
		cwd: process.cwd(),
		maxOutputBytes: 1024,
	});
	assert.equal(result.exitCode, 0);
	assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 1024);
});

test("output cap does not split a UTF-8 suffix into extra replacement bytes", async () => {
	const result = await runProcess({
		command: process.execPath,
		args: ["-e", "process.stdout.write('€'.repeat(1000))"],
		cwd: process.cwd(),
		maxOutputBytes: 1024,
	});
	assert.ok(Buffer.byteLength(result.stdout) <= 1024);
	assert.ok(!result.stdout.includes("�"));
});

test("a successful command cannot leave a background descendant running", async () => {
	const result = await runProcess({
		command: process.execPath,
		args: [
			"-e",
			"const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); c.unref(); console.log(c.pid)",
		],
		cwd: process.cwd(),
	});
	assert.equal(result.exitCode, 0);
	const descendant = Number(result.stdout.trim());
	assert.ok(descendant > 0);
	await assertProcessGone(descendant);
});

test("timeout stops a detached process group including a descendant", async () => {
	const result = await runProcess({
		command: process.execPath,
		args: [
			"-e",
			"const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}); console.log(c.pid); setInterval(()=>{},1000)",
		],
		cwd: process.cwd(),
		timeoutMs: 200,
	});
	assert.equal(result.timedOut, true);
	assert.equal(result.aborted, false);
	assert.ok(result.durationMs < 3000);
	const descendant = Number(result.stdout.trim());
	assert.ok(descendant > 0);
	await assertProcessGone(descendant);
});

test("timeout escalates for a process group that ignores SIGTERM", async () => {
	const result = await runProcess({
		command: process.execPath,
		args: [
			"-e",
			"process.on('SIGTERM',()=>{}); const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)\"],{stdio:'inherit'}); console.log(c.pid); setInterval(()=>{},1000)",
		],
		cwd: process.cwd(),
		timeoutMs: 200,
	});
	assert.equal(result.timedOut, true);
	assert.ok(result.durationMs < 3000);
	await assertProcessGone(Number(result.stdout.trim()));
});

test("cancellation stops a running process and a pre-aborted signal never spawns", async () => {
	const controller = new AbortController();
	const pending = runProcess({
		command: process.execPath,
		args: ["-e", "setInterval(()=>{},1000)"],
		cwd: process.cwd(),
		signal: controller.signal,
	});
	controller.abort();
	assert.equal((await pending).aborted, true);
	const result = await runProcess({
		command: "/does/not/exist",
		args: [],
		cwd: process.cwd(),
		signal: controller.signal,
	});
	assert.equal(result.aborted, true);
});

test("spawn errors reject and do not leave timeout handles", async () => {
	await assert.rejects(
		runProcess({ command: "/does/not/exist", args: [], cwd: process.cwd(), timeoutMs: 100 }),
		/ENOENT/
	);
});
