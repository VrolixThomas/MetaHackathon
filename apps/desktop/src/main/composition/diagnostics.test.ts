import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
