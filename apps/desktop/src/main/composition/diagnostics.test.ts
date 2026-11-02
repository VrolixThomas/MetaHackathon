import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ModelTimingRecord } from "../agent/meta-client";
import { ConversationDiagnostics, createDiagnosticsRouter } from "./diagnostics";

test("local diagnostics retain timings but reject content and hash identities", async () => {
	const dir = mkdtempSync(join(tmpdir(), "muse-diagnostics-"));
	const log = new ConversationDiagnostics(dir);
	try {
		const caller = createDiagnosticsRouter(() => log).createCaller({});
		await caller.record({
			stage: "speech-start",
			turn: { sessionId: "private-session", turnId: "private-turn", generation: 1 },
			elapsedMs: 0,
		});
		log.record({
			stage: "first-audio",
			turn: { sessionId: "private-session", turnId: "private-turn", generation: 1 },
			elapsedMs: 2300,
			releaseToAudioMs: 1000,
		});
		for (const field of ["text", "message", "sdp", "apiKey", "url"])
			log.record({ stage: "turn-failed", [field]: "must-not-be-written" });
		await assert.rejects(caller.record({ stage: "turn-failed", message: "secret" } as never));
		const lines = readFileSync(log.path, "utf8");
		assert.equal(lines.trim().split("\n").length, 2);
		assert.ok(!/private-session|private-turn|must-not-be-written|secret/.test(lines));
		const events = lines
			.trim()
			.split("\n")
			.map((s) => JSON.parse(s));
		assert.equal(events[0].turnHash, events[1].turnHash);
		assert.equal(events[1].elapsedMs, 2300);
		assert.ok(events.every((e) => !Number.isNaN(Date.parse(e.at))));
		assert.equal(statSync(log.path).mode & 0o777, 0o600);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("diagnostic rotation is bounded and disk failures do not interrupt callers", () => {
	const dir = mkdtempSync(join(tmpdir(), "muse-diagnostics-"));
	const log = new ConversationDiagnostics(dir, 500);
	try {
		for (let i = 0; i < 25; i++) log.record({ stage: "first-audio", elapsedMs: i });
		assert.ok(statSync(log.path).size <= 500);
		assert.ok(statSync(`${log.path}.previous`).size <= 500);
		const blocker = join(dir, "not-a-directory");
		writeFileSync(blocker, "x");
		assert.doesNotThrow(() => new ConversationDiagnostics(blocker).record({ stage: "app-start" }));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("main-only model timings retain numeric stages and reject content or raw request identities", async () => {
	const dir = mkdtempSync(join(tmpdir(), "muse-model-diagnostics-"));
	const log = new ConversationDiagnostics(dir);
	const record: ModelTimingRecord = {
		requestHash: "a".repeat(64),
		attemptHash: "b".repeat(64),
		workload: "quick",
		status: "completed",
		inputBytes: 200,
		instructionBytes: 100,
		toolBytes: 400,
		inputItems: 2,
		toolCount: 3,
		maxOutputTokens: 2048,
		requestBytes: 900,
		credentialMs: 1,
		headersMs: 300,
		firstEventMs: 310,
		firstTextMs: 900,
		terminalMs: 1200,
		durationMs: 1201,
		streamedTextChars: 40,
		functionCalls: 0,
		httpStatus: 200,
		inputTokens: 100,
		cachedInputTokens: null,
		outputTokens: 20,
	};
	try {
		log.recordModelTiming(record);
		for (const key of ["prompt", "apiKey", "requestId", "instructions", "text"])
			log.recordModelTiming({ ...record, [key]: "private-content" } as ModelTimingRecord);
		log.recordModelTiming({ ...record, requestHash: "raw-private-request" });
		log.recordModelTiming({ ...record, durationMs: Number.NaN });
		const rows = readFileSync(log.path, "utf8").trim().split("\n");
		assert.equal(rows.length, 1);
		assert.equal(JSON.parse(rows[0] ?? "{}").firstTextMs, 900);
		assert.doesNotMatch(rows[0] ?? "", /private-content|raw-private/);
		assert.equal(statSync(log.path).mode & 0o777, 0o600);
		const caller = createDiagnosticsRouter(() => log).createCaller({});
		await assert.rejects(caller.record({ ...record, stage: "model-timing" } as never));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("foreground operation timings are fixed labels and numbers; renderer cannot submit them", async () => {
	const dir = mkdtempSync(join(tmpdir(), "muse-tool-diagnostics-"));
	const log = new ConversationDiagnostics(dir);
	const row = {
		stage: "foreground-timing",
		turnHash: "a".repeat(64),
		requestHash: "b".repeat(64),
		operation: "inspect_ticket",
		sequence: 1,
		status: "completed",
		durationMs: 42,
		firstTextMs: null,
	};
	try {
		log.record(row);
		for (const field of ["arguments", "text", "url", "apiKey", "requestId"])
			log.record({ ...row, [field]: "secret" });
		log.record({ ...row, operation: "secret-provider-tool" });
		log.record({ ...row, durationMs: Number.NaN });
		log.record({ ...row, durationMs: -1 });
		assert.equal(readFileSync(log.path, "utf8").trim().split("\n").length, 1);
		assert.doesNotMatch(readFileSync(log.path, "utf8"), /secret|arguments|apiKey/);
		await assert.rejects(
			createDiagnosticsRouter(() => log)
				.createCaller({})
				.record(row as never)
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
