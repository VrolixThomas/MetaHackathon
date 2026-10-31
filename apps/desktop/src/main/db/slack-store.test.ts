import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as nodeTest } from "node:test";
import Database from "better-sqlite3";
import type { ChatMessage } from "../../shared/contracts/chat";
import type { SlackCheckpoint } from "../slack/intake";
import {
	SLACK_STORE_MIGRATION_SQL,
	type SlackIdentity,
	type SlackSourceRecord,
	SlackStoreError,
	SlackWorkspaceStore,
	emptySlackPreferences,
	slackMessageDigest,
} from "./slack-store";

// Authored/type-checked in the bounded lane. Root alone executes this real SQLite/native binding suite.
const test = process.versions["electron"] ? nodeTest : nodeTest.skip;
const identity: SlackIdentity = {
	workspaceId: "T111",
	userId: "U111",
	connectionId: "connection-one",
	appId: "A111",
};
const ts = (n = 0) => `179340480${n}.000001`;
function message(revision = 0): ChatMessage {
	return {
		citation: {
			source: {
				provider: "slack",
				workspaceId: "T111",
				conversationId: "D111",
				messageId: ts(),
				threadId: null,
				revisionId: ts(revision),
				permalink: null,
			},
			audience: {
				workspaceId: "T111",
				conversationId: "D111",
				visibility: "direct_message",
				readerIds: ["U111", "U222"],
				membershipRevision: "actual-membership",
				observedAt: "2026-10-31T00:00:00.000Z",
			},
		},
		authorId: "U222",
		text: `Private exact source revision ${revision}`,
		createdAt: "2026-10-31T00:00:00.000Z",
		updatedAt: `2026-10-31T00:00:0${revision}.000Z`,
		deletedAt: null,
		truncated: false,
	};
}
function record(revision = 0, sequence = 1): SlackSourceRecord {
	const value = message(revision);
	return {
		sequence,
		source: value.citation.source,
		message: value,
		digest: slackMessageDigest(value),
		deleted: false,
		decision: { kind: "none" },
		ownPromise: false,
		dayApplied: false,
		knowledgeApplied: false,
	};
}
function checkpoint(connectionId = identity.connectionId): SlackCheckpoint {
	return {
		version: 1,
		connectionId,
		workspaceId: "T111",
		userId: "U111",
		eventIds: ["Ev1"],
		revisions: [
			{ key: `D111:${ts()}`, revisionId: ts(), deleted: false, authorId: "U222", threadId: null },
		],
		polls: [],
	};
}
function open(path = ":memory:") {
	const sqlite = new Database(path);
	sqlite.exec(SLACK_STORE_MIGRATION_SQL);
	return { sqlite, store: new SlackWorkspaceStore(sqlite) };
}

test("Slack additive migration/constructor preserve existing DB lifetime; epoch CAS fences old connection writes", async () => {
	const { sqlite, store } = open();
	try {
		sqlite.exec(
			"CREATE TABLE existing_sentinel(value TEXT); INSERT INTO existing_sentinel VALUES('retained')"
		);
		const first = await store.activate(identity, 0);
		await assert.rejects(
			store.activate({ ...identity, connectionId: "late-connection" }, 0),
			SlackStoreError
		);
		const second = await store.activate(
			{ ...identity, connectionId: "connection-two" },
			first.epoch
		);
		await assert.rejects(store.saveCheckpoint(first, checkpoint(), 0), SlackStoreError);
		await assert.rejects(store.saveSource(first, record(), 0), SlackStoreError);
		await assert.rejects(store.release(first), SlackStoreError);
		assert.equal((await store.head()).identity?.connectionId, second.connectionId);
		assert.equal(
			(sqlite.prepare("SELECT value FROM existing_sentinel").get() as { value: string }).value,
			"retained"
		);
		assert.equal(sqlite.open, true);
	} finally {
		sqlite.close();
	}
});

test("checkpoint per-connection sequence CAS preserves current bytes and terminal tombstones", async () => {
	const { sqlite, store } = open();
	try {
		let lease = await store.activate(identity, 0);
		const first = checkpoint();
		await store.saveCheckpoint(lease, first, 0);
		const second = checkpoint();
		const revision = second.revisions[0];
		assert.ok(revision);
		revision.revisionId = ts(2);
		await store.saveCheckpoint(lease, second, 1);
		await assert.rejects(store.saveCheckpoint(lease, first, 1), SlackStoreError);
		assert.deepEqual((await store.checkpoint(lease))?.data, second);
		revision.deleted = true;
		revision.revisionId = ts(3);
		await store.saveCheckpoint(lease, second, 2);
		await assert.rejects(store.saveCheckpoint(lease, first, 3), SlackStoreError);
		const other = await store.activate(
			{ ...identity, connectionId: "connection-two" },
			lease.epoch
		);
		assert.equal(await store.checkpoint(other), null);
		lease = await store.activate(identity, other.epoch);
		assert.equal((await store.checkpoint(lease))?.sequence, 3);
		assert.equal((await store.checkpoint(lease))?.data.revisions[0]?.deleted, true);
		// Invalid counters cannot turn the equality CAS into a non-advancing floating point write.
		sqlite
			.prepare("UPDATE slack_workspace_connections SET sequence=1e100 WHERE connection_id=?")
			.run(identity.connectionId);
		await assert.rejects(store.checkpoint(lease), SlackStoreError);
		await assert.rejects(store.saveCheckpoint(lease, second, 1e100), SlackStoreError);
	} finally {
		sqlite.close();
	}
});

test("private classification-none/source digest cache is monotonic and cannot resurrect a deleted source", async () => {
	const { sqlite, store } = open();
	try {
		const lease = await store.activate(identity, 0);
		const first = record();
		await store.saveSource(lease, first, 0);
		assert.deepEqual((await store.source(lease, first.source))?.decision, { kind: "none" });
		const second = record(2, 2);
		second.decision = null;
		await store.saveSource(lease, second, 1);
		await assert.rejects(store.saveSource(lease, { ...first, sequence: 3 }, 2), SlackStoreError);
		const changedSameRevision = record(2, 3);
		assert.ok(changedSameRevision.message);
		changedSameRevision.message.text = "Conflicting text";
		changedSameRevision.digest = slackMessageDigest(changedSameRevision.message);
		await assert.rejects(store.saveSource(lease, changedSameRevision, 2), SlackStoreError);
		const tombstone: SlackSourceRecord = {
			...second,
			sequence: 3,
			source: { ...second.source, revisionId: ts(3) },
			message: null,
			digest: "a".repeat(64),
			decision: { kind: "none" },
			deleted: true,
		};
		await store.saveSource(lease, tombstone, 2);
		await assert.rejects(store.saveSource(lease, record(4, 4), 3), SlackStoreError);
		assert.equal((await store.source(lease, first.source))?.message, null);
		assert.ok(
			!(
				sqlite.prepare("SELECT data_json FROM slack_workspace_sources").get() as {
					data_json: string;
				}
			).data_json.includes(first.message?.text ?? "unexpected")
		);
	} finally {
		sqlite.close();
	}
});

test("watch preferences and rate limits are durable per actor, with bounded source rows and fixed corruption errors", async () => {
	const { sqlite, store } = open();
	try {
		const lease = await store.activate(identity, 0);
		const prefs = {
			...emptySlackPreferences(),
			sequence: 1,
			conversationIds: ["D111"],
			nextHistoryAt: 123000,
			rateLimitedUntil: 123000,
		};
		await store.savePreferences(lease, prefs, 0);
		await assert.rejects(store.savePreferences(lease, prefs, 0), SlackStoreError);
		const second = await store.activate(
			{ ...identity, userId: "U333", connectionId: "another-user" },
			lease.epoch
		);
		assert.deepEqual(await store.preferences(second), emptySlackPreferences());
		const restored = await store.activate(identity, second.epoch);
		assert.deepEqual(await store.preferences(restored), prefs);
		await assert.rejects(
			store.activate(
				{ ...identity, accessToken: "credential-must-never-persist" } as SlackIdentity,
				restored.epoch
			),
			SlackStoreError
		);
		await store.saveSource(restored, record(), 0);
		sqlite
			.prepare("UPDATE slack_workspace_sources SET data_json=?")
			.run('{"privateProviderError":"never-echo-this"}');
		await assert.rejects(
			store.source(restored, message().citation.source),
			(error) => error instanceof SlackStoreError && !error.message.includes("never-echo-this")
		);
	} finally {
		sqlite.close();
	}
});

test("watch, source decision and actual message identity recover after SQLite reopen", async () => {
	const directory = await mkdtemp(join(tmpdir(), "slack-workspace-store-"));
	const path = join(directory, "workspace.db");
	try {
		const first = open(path);
		const lease = await first.store.activate(identity, 0);
		await first.store.savePreferences(
			lease,
			{ ...emptySlackPreferences(), sequence: 1, conversationIds: ["D111"] },
			0
		);
		await first.store.saveSource(lease, record(), 0);
		await first.store.saveCheckpoint(lease, checkpoint(), 0);
		first.sqlite.close();
		const second = open(path);
		try {
			const head = await second.store.head();
			const resumed = await second.store.activate(identity, head.epoch);
			assert.equal((await second.store.preferences(resumed)).conversationIds[0], "D111");
			assert.equal(
				(await second.store.source(resumed, message().citation.source))?.message?.citation.source
					.messageId,
				ts()
			);
			assert.deepEqual((await second.store.source(resumed, message().citation.source))?.decision, {
				kind: "none",
			});
			assert.equal((await second.store.checkpoint(resumed))?.data.eventIds[0], "Ev1");
		} finally {
			second.sqlite.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("legacy nonempty preferences migrate to selected; legacy empty rows opt into all_joined", async () => {
	const { sqlite, store } = open();
	try {
		const lease = await store.activate(identity, 0);
		const actorKey = JSON.stringify([identity.workspaceId, identity.userId]);
		const legacy = { sequence: 7, conversationIds: ["D111"], threads: [], nextStream: 0 };
		sqlite
			.prepare(
				"INSERT INTO slack_workspace_preferences(actor_key,sequence,data_json) VALUES(?,?,?)"
			)
			.run(actorKey, 7, JSON.stringify(legacy));
		const selected = await store.preferences(lease);
		assert.equal(selected.followMode, "selected");
		assert.deepEqual(selected.selectedConversationIds, ["D111"]);
		assert.deepEqual(selected.excludedConversationIds, []);
		await store.savePreferences(
			lease,
			{ ...selected, sequence: 8, excludedConversationIds: ["D222"] },
			7
		);
		assert.deepEqual((await store.preferences(lease)).excludedConversationIds, ["D222"]);
		sqlite
			.prepare("UPDATE slack_workspace_preferences SET sequence=9,data_json=? WHERE actor_key=?")
			.run(JSON.stringify({ ...legacy, sequence: 9, conversationIds: [] }), actorKey);
		assert.equal((await store.preferences(lease)).followMode, "all_joined");
	} finally {
		sqlite.close();
	}
});

test("follow mode, exclusions, pending first-poll boundaries and membership backoff survive SQLite reopen per actor", async () => {
	const directory = await mkdtemp(join(tmpdir(), "slack-follow-store-"));
	const path = join(directory, "workspace.db");
	try {
		const first = open(path);
		const lease = await first.store.activate(identity, 0);
		const prefs = {
			...emptySlackPreferences(),
			sequence: 1,
			conversationIds: ["D111"],
			selectedConversationIds: ["D222"],
			excludedConversationIds: ["D333"],
			watchOrigins: [{ conversationId: "D111", oldest: ts() }],
			membershipStartedAt: 1793404800000,
			nextMembershipAt: 1793404920000,
			membershipRetryAt: 1793404920000,
			membershipSync: { phase: "error" as const, discoveredCount: 1, completedAt: null },
		};
		await first.store.savePreferences(lease, prefs, 0);
		first.sqlite.close();
		const second = open(path);
		try {
			const restored = await second.store.activate(identity, (await second.store.head()).epoch);
			assert.deepEqual(await second.store.preferences(restored), prefs);
			const other = await second.store.activate(
				{ ...identity, userId: "U333", connectionId: "other-user" },
				restored.epoch
			);
			assert.deepEqual(await second.store.preferences(other), emptySlackPreferences());
			await assert.rejects(
				second.store.savePreferences(restored, { ...prefs, sequence: 2 }, 1),
				SlackStoreError
			);
		} finally {
			second.sqlite.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("1000 conversations and 4096 checkpoint streams persist; overflowing writes preserve existing bytes", async () => {
	const { sqlite, store } = open();
	try {
		const lease = await store.activate(identity, 0);
		const conversations = Array.from({ length: 1000 }, (_, i) => `D${1000 + i}`);
		const prefs = { ...emptySlackPreferences(), sequence: 1, conversationIds: conversations };
		await store.savePreferences(lease, prefs, 0);
		await assert.rejects(
			store.savePreferences(
				lease,
				{ ...prefs, sequence: 2, conversationIds: [...conversations, "D9999"] },
				1
			),
			SlackStoreError
		);
		assert.deepEqual(await store.preferences(lease), prefs);
		const data = checkpoint();
		data.polls = Array.from({ length: 4096 }, (_, i) => ({
			key: `D${10000 + i}:history`,
			conversationId: `D${10000 + i}`,
			threadTs: null,
			oldest: ts(),
			latest: ts(1),
			through: ts(1),
			cursor: null,
			active: false,
		}));
		await store.saveCheckpoint(lease, data, 0);
		assert.equal((await store.checkpoint(lease))?.data.polls.length, 4096);
		const firstPoll = data.polls[0];
		assert.ok(firstPoll);
		await assert.rejects(
			store.saveCheckpoint(
				lease,
				{ ...data, polls: [...data.polls, { ...firstPoll, key: "overflow:history" }] },
				1
			),
			SlackStoreError
		);
		assert.equal((await store.checkpoint(lease))?.sequence, 1);
	} finally {
		sqlite.close();
	}
});
