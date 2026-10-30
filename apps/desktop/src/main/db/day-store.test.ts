import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { type DayState, emptyDayState } from "../day/model";
import { DayService } from "../day/service";
import { DAY_STORE_MIGRATION_SQL, DayStore, MAX_DAY_STATE_BYTES } from "./day-store";

// Root-only real SQLite acceptance. This lane authors and type-checks these tests but does not run native code.
const timestamp = "2026-10-31T00:00:00.000Z";
function open(path = ":memory:") {
	const sqlite = new Database(path);
	sqlite.exec(DAY_STORE_MIGRATION_SQL);
	return { sqlite, store: new DayStore(sqlite) };
}
const next = (state = emptyDayState(timestamp)): DayState => ({
	...state,
	sequence: state.sequence + 1,
});

test("day migration is additive; CAS rejects a stale writer without overwriting accepted bytes", async () => {
	const { sqlite, store } = open();
	try {
		sqlite.exec(
			"CREATE TABLE hub_sentinel(data TEXT); INSERT INTO hub_sentinel VALUES('retained');"
		);
		assert.equal(await store.loadState(), null);
		const first = next();
		await store.saveState(first, 0);
		const staleStore = new DayStore(sqlite);
		const stale = await staleStore.loadState();
		assert.ok(stale);
		const second = next(first);
		second.supervisor.failures = 2;
		await store.saveState(second, 1);
		await assert.rejects(staleStore.saveState(next(stale), 1), /preserved/);
		assert.deepEqual(await store.loadState(), second);
		assert.equal(
			(sqlite.prepare("SELECT data FROM hub_sentinel").get() as { data: string }).data,
			"retained"
		);
	} finally {
		sqlite.close();
	}
});

test("accepted ownership, exact reply outbox, questions and next-check checkpoints survive SQLite reopen", async () => {
	const directory = await mkdtemp(join(tmpdir(), "day-store-test-"));
	const path = join(directory, "day.db");
	try {
		const first = open(path);
		const service = new DayService({
			store: first.store,
			actor: { workspaceId: "workspace", userId: "user" },
			availability: () => ({ awake: false, online: false }),
			now: () => Date.parse(timestamp),
			id: () => "commitment",
		});
		await service.capture({
			requestId: "capture",
			title: "Controlled request",
			summary: "Inferred summary",
			kind: "request",
			message: {
				citation: {
					source: {
						provider: "slack",
						workspaceId: "workspace",
						conversationId: "channel",
						messageId: "message",
						threadId: null,
						revisionId: "revision",
						permalink: null,
					},
					audience: {
						workspaceId: "workspace",
						conversationId: "channel",
						visibility: "direct_message",
						readerIds: ["user", "peer"],
						membershipRevision: "membership",
						observedAt: timestamp,
					},
				},
				authorId: "peer",
				text: "Please answer this request",
				createdAt: timestamp,
				updatedAt: timestamp,
				deletedAt: null,
				truncated: false,
			},
		});
		let item = (await service.snapshot()).items[0];
		assert.ok(item);
		await service.queueContext({
			requestId: "context",
			itemId: item.id,
			expectedRevision: item.revision,
			questions: ["Which date?"],
		});
		for (const kind of ["cover", "accept"] as const) {
			item = (await service.snapshot()).items[0];
			assert.ok(item);
			await service.operate({
				requestId: kind,
				operation: { kind, itemId: item.id, expectedRevision: item.revision },
			});
		}
		item = (await service.snapshot()).items[0];
		assert.ok(item?.questions[0]);
		await service.operate({
			requestId: "answer",
			operation: {
				kind: "answer_question",
				itemId: item.id,
				expectedRevision: item.revision,
				questionId: item.questions[0].id,
				answer: "Tomorrow",
			},
		});
		item = (await service.snapshot()).items[0];
		assert.ok(item);
		await service.operate({
			requestId: "draft",
			operation: {
				kind: "draft_reply",
				itemId: item.id,
				expectedRevision: item.revision,
				body: "The exact confirmed answer",
			},
		});
		item = (await service.snapshot()).items[0];
		assert.ok(item?.replyDraft);
		await service.operate({
			requestId: "send",
			operation: {
				kind: "send_reply",
				itemId: item.id,
				expectedRevision: item.revision,
				draftRevision: item.replyDraft.revision,
				body: item.replyDraft.body,
			},
		});
		item = (await service.snapshot()).items[0];
		assert.ok(item);
		await service.scheduleCheck({
			requestId: "tomorrow",
			itemId: item.id,
			expectedRevision: item.revision,
			nextCheckAt: "2026-11-01T00:00:00.000Z",
		});
		await service.dispose();
		const expected = await first.store.loadState();
		first.sqlite.close();
		const second = open(path);
		try {
			const persisted = await second.store.loadState();
			assert.deepEqual(persisted, expected);
			assert.equal(persisted?.records[0]?.item.acceptance, "accepted");
			assert.equal(persisted?.records[0]?.outbox[0]?.status, "pending");
			assert.equal(persisted?.records[0]?.item.phase, "awaiting_reply");
			assert.equal(persisted?.records[0]?.item.questions[0]?.answer, "Tomorrow");
			assert.equal(persisted?.records[0]?.item.nextCheckAt, "2026-11-01T00:00:00.000Z");
			assert.ok(persisted?.requests.some((request) => request.id === "send"));
		} finally {
			second.sqlite.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("corrupt rows and conflicting state/SQL sequences reject without exposing or deleting stored data", async () => {
	const { sqlite, store } = open();
	try {
		await store.saveState(next(), 0);
		const corrupt = "{private-source-unreadable-json";
		sqlite.prepare("UPDATE day_state SET data_json=?").run(corrupt);
		await assert.rejects(
			store.loadState(),
			(error: Error) => /preserved/.test(error.message) && !error.message.includes("private-source")
		);
		assert.equal(
			(sqlite.prepare("SELECT data_json FROM day_state").get() as { data_json: string }).data_json,
			corrupt
		);
		sqlite
			.prepare("UPDATE day_state SET data_json=?")
			.run(JSON.stringify({ ...next(), sequence: 99 }));
		await assert.rejects(store.loadState(), /preserved/);
	} finally {
		sqlite.close();
	}
});

test("a failed SQLite transaction rolls back and leaves later retry possible", async () => {
	const { sqlite, store } = open();
	try {
		const first = next();
		await store.saveState(first, 0);
		sqlite.exec(
			"CREATE TRIGGER fail_day BEFORE UPDATE ON day_state BEGIN SELECT RAISE(ABORT,'private failure'); END"
		);
		await assert.rejects(store.saveState(next(first), 1), /preserved/);
		assert.deepEqual(await store.loadState(), first);
		sqlite.exec("DROP TRIGGER fail_day");
		await store.saveState(next(first), 1);
		assert.equal((await store.loadState())?.sequence, 2);
	} finally {
		sqlite.close();
	}
});

test("oversized input and stored bytes reject safely without removing durable state", async () => {
	const { sqlite, store } = open();
	try {
		const first = next();
		await store.saveState(first, 0);
		await assert.rejects(
			store.saveState(
				{ ...next(first), privateExtra: "x".repeat(MAX_DAY_STATE_BYTES) } as DayState,
				1
			),
			/preserved/
		);
		assert.deepEqual(await store.loadState(), first);
		sqlite.prepare("UPDATE day_state SET data_json=zeroblob(?)").run(MAX_DAY_STATE_BYTES + 1);
		await assert.rejects(store.loadState(), /preserved/);
		assert.equal(
			(sqlite.prepare("SELECT count(*) AS count FROM day_state").get() as { count: number }).count,
			1
		);
	} finally {
		sqlite.close();
	}
});
