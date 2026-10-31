import assert from "node:assert/strict";
import { it } from "node:test";
import type { SlackMessagePage } from "../../shared/contracts/chat";
import { SLACK_LIST_ERROR, SLACK_MESSAGES_ERROR } from "./controller";
import { connected, conversation, deferred, harness, message, page } from "./test-support";

it("loads only actual catalog metadata at startup, coalesces starts and issues queries only", async () => {
	const { controller, calls } = harness();
	await Promise.all([controller.start(), controller.start()]);
	assert.deepEqual(controller.store.getState().conversations, [conversation()]);
	assert.equal(controller.store.getState().loadedTarget, null);
	assert.deepEqual(
		calls.map((call) => call.path),
		["slack.status", "slack.conversations", "slack.status"]
	);
	assert.ok(calls.every((call) => call.type === "query"));
	controller.dispose();
});

it("reads unlisted selected metadata and an exact thread target; repeated ensures do not fan out", async () => {
	const { controller, calls } = harness();
	const target = "C02/1000000000.000001";
	await Promise.all([controller.ensureTarget(target), controller.ensureTarget(target)]);
	await controller.ensureTarget(target);
	const state = controller.store.getState();
	assert.equal(state.loadedTarget, target);
	assert.equal(state.conversation?.id, "C02");
	assert.equal(state.authors["U02"], "Controlled author");
	assert.deepEqual(
		calls.map((call) => call.path),
		["slack.status", "slack.conversation", "slack.thread", "slack.status"]
	);
	assert.deepEqual(calls[2]?.input, { conversationId: "C02", threadTs: "1000000000.000001" });
	controller.dispose();
});

it("rejects malformed selections without source reads and clears previously shown private bytes", async () => {
	const { controller, calls } = harness();
	await controller.ensureTarget("C01");
	const count = calls.length;
	for (const invalid of [
		"C01/",
		"C01/1",
		"C01/1000000000.000001/extra",
		"https://example.com",
		"C01%2F1000000000.000001",
	]) {
		await assert.rejects(controller.ensureTarget(invalid));
		assert.equal(controller.store.getState().loadedTarget, null);
		assert.deepEqual(controller.store.getState().messages, []);
	}
	assert.equal(calls.length, count);
	controller.dispose();
});

it("retires slow selection and its promise immediately; late bytes cannot replace a later conversation", async () => {
	const waiting = deferred<SlackMessagePage>();
	const entered = deferred<void>();
	const { controller } = harness(async (_, path, input) => {
		if (
			path === "slack.history" &&
			(input as { conversationId: string }).conversationId === "C01"
		) {
			entered.resolve();
			return waiting.promise;
		}
	});
	const old = controller.ensureTarget("C01").then(
		() => "applied",
		() => "retired"
	);
	await entered.promise;
	await controller.ensureTarget("C02");
	assert.equal(await old, "retired");
	waiting.resolve(page());
	await Promise.resolve();
	assert.equal(controller.store.getState().loadedTarget, "C02");
	assert.ok(
		controller.store
			.getState()
			.messages.every((row) => row.citation.source.conversationId === "C02")
	);
	controller.dispose();
});

it("reset fences an in-flight page and disposes all observed account data before another account", async () => {
	const waiting = deferred<SlackMessagePage>();
	const entered = deferred<void>();
	const { controller } = harness(async (_, path) => {
		if (path === "slack.history") {
			entered.resolve();
			return waiting.promise;
		}
	});
	await controller.start();
	const old = controller.ensureTarget("C01").catch(() => {});
	await entered.promise;
	controller.reset();
	await old;
	waiting.resolve(page());
	await Promise.resolve();
	assert.equal(controller.store.getState().status, null);
	assert.deepEqual(controller.store.getState().conversations, []);
	assert.deepEqual(controller.store.getState().messages, []);
	assert.deepEqual(controller.store.getState().authors, {});
	assert.equal(controller.store.getState().loadedTarget, null);
	controller.dispose();
});

it("detects an account switch between page dispatch and adoption, clearing the catalog and messages", async () => {
	let statusReads = 0;
	const { controller } = harness(async (_, path) => {
		if (path === "slack.status") {
			const status = connected();
			if (++statusReads === 4 && status.account) status.account.userId = "U99";
			return status;
		}
	});
	await controller.start();
	await assert.rejects(controller.ensureTarget("C01"));
	assert.equal(controller.store.getState().loadedTarget, null);
	assert.deepEqual(controller.store.getState().conversations, []);
	assert.deepEqual(controller.store.getState().messages, []);
	assert.match(controller.store.getState().messageError, /connection changed/);
	controller.dispose();
});

it("fails closed on disconnected status, never attempts a history read", async () => {
	const { controller, calls } = harness(async (_, path) =>
		path === "slack.status"
			? { ...connected(), phase: "disconnected", account: null, coverage: "disconnected" }
			: undefined
	);
	await assert.rejects(controller.ensureTarget("C01"));
	assert.deepEqual(
		calls.map((call) => call.path),
		["slack.status"]
	);
	assert.match(controller.store.getState().messageError, /Connect Slack in Settings/);
	controller.dispose();
});

for (const [label, alter] of [
	[
		"actor",
		(row: SlackMessagePage) => {
			row.actor.userId = "U99";
		},
	],
	[
		"workspace",
		(row: SlackMessagePage) => {
			row.actor.workspaceId = "T99";
		},
	],
	[
		"conversation",
		(row: SlackMessagePage) => {
			row.conversation.id = "C99";
		},
	],
	[
		"thread",
		(row: SlackMessagePage) => {
			row.threadTs = "1000000000.000002";
		},
	],
	[
		"source conversation",
		(row: SlackMessagePage) => {
			const item = row.items[0];
			if (item) {
				item.citation.source.conversationId = "C99";
				item.citation.audience.conversationId = "C99";
			}
		},
	],
	[
		"visibility",
		(row: SlackMessagePage) => {
			const item = row.items[0];
			if (item) item.citation.audience.visibility = "private_channel";
		},
	],
	[
		"unrelated author",
		(row: SlackMessagePage) => {
			row.authors.push({ id: "U99", name: "Unobserved label" });
		},
	],
	[
		"unreadable",
		(row: SlackMessagePage) => {
			row.conversation.canRead = false;
		},
	],
] as const) {
	it(`rejects ${label} mismatches without publishing a displayable target`, async () => {
		const { controller } = harness(async (_, path) => {
			if (path === "slack.history") {
				const row = page();
				alter(row);
				return row;
			}
		});
		await assert.rejects(controller.ensureTarget("C01"));
		assert.equal(controller.store.getState().loadedTarget, null);
		assert.deepEqual(controller.store.getState().messages, []);
		assert.equal(controller.store.getState().messageError, SLACK_MESSAGES_ERROR);
		controller.dispose();
	});
}

it("rejects unreadable or mismatched conversation metadata before fetching message text", async () => {
	for (const metadata of [
		{ ...conversation(), canRead: false },
		conversation("C99"),
		{ ...conversation(), workspaceId: "T99" },
	]) {
		const { controller, calls } = harness(async (_, path) =>
			path === "slack.conversation" ? metadata : undefined
		);
		await assert.rejects(controller.ensureTarget("C01"));
		assert.equal(
			calls.some((call) => call.path === "slack.history"),
			false
		);
		controller.dispose();
	}
});

it("merges overlapping older pages in timestamp order and keeps the latest edited/deleted revision", async () => {
	const fresh = message("1000000000.000003");
	fresh.text = "Fresh edited text";
	fresh.updatedAt = "2026-10-31T11:02:00.000Z";
	const deleted = message("1000000000.000002");
	deleted.text = "";
	deleted.deletedAt = deleted.updatedAt = "2026-10-31T11:01:00.000Z";
	const { controller, calls } = harness(async (_, path, input) => {
		if (path !== "slack.history") return;
		return (input as { cursor?: string }).cursor
			? {
					...page(),
					items: [
						message("1000000000.000003"),
						message("1000000000.000001"),
						{ ...message("1000000000.000002"), updatedAt: "2026-10-31T11:03:00.000Z" },
					],
					authors: [{ id: "U02", name: "Current profile label" }],
				}
			: { ...page(), items: [fresh, deleted], nextCursor: "older-1", hasMore: true };
	});
	await controller.ensureTarget("C01");
	await controller.loadOlder();
	const state = controller.store.getState();
	assert.deepEqual(
		state.messages.map((row) => row.citation.source.messageId),
		["1000000000.000001", "1000000000.000002", "1000000000.000003"]
	);
	assert.equal(state.messages[1]?.text, "");
	assert.equal(state.messages[1]?.deletedAt, "2026-10-31T11:01:00.000Z");
	assert.equal(state.messages[2]?.text, "Fresh edited text");
	assert.equal(state.authors["U02"], "Current profile label");
	assert.deepEqual(calls.filter((call) => call.path === "slack.history").at(-1)?.input, {
		conversationId: "C01",
		cursor: "older-1",
	});
	assert.equal(state.messageHasMore, false);
	controller.dispose();
});

it("merges catalog pages by source ID, refresh replaces old catalog, and rejects cross-workspace metadata", async () => {
	let invalid = false;
	const { controller } = harness(async (_, path, input) => {
		if (path !== "slack.conversations") return;
		if (invalid)
			return {
				items: [{ ...conversation(), workspaceId: "T99" }],
				nextCursor: null,
				hasMore: false,
			};
		return (input as { cursor?: string }).cursor
			? {
					items: [{ ...conversation(), name: "Current name" }, conversation("D01")],
					nextCursor: null,
					hasMore: false,
				}
			: { items: [conversation()], nextCursor: "catalog-2", hasMore: true };
	});
	await controller.start();
	await controller.loadMoreConversations();
	assert.equal(controller.store.getState().conversations.length, 2);
	assert.equal(controller.store.getState().conversations[0]?.name, "Current name");
	await controller.refreshConversations();
	assert.deepEqual(controller.store.getState().conversations, [conversation()]);
	invalid = true;
	await controller.refreshConversations();
	assert.equal(controller.store.getState().listError, SLACK_LIST_ERROR);
	assert.ok(controller.store.getState().conversations.every((row) => row.workspaceId === "T01"));
	controller.dispose();
});

it("rejects missing/repeated pagination cursors rather than looping or appending a poisoned page", async () => {
	for (const nextCursor of [null, "repeat"]) {
		const { controller } = harness(async (_, path) =>
			path === "slack.history" ? { ...page(), nextCursor, hasMore: true } : undefined
		);
		if (nextCursor) {
			await controller.ensureTarget("C01");
			await controller.loadOlder();
		} else await assert.rejects(controller.ensureTarget("C01"));
		assert.equal(controller.store.getState().loadedTarget, null);
		assert.equal(controller.store.getState().messageError, SLACK_MESSAGES_ERROR);
		controller.dispose();
	}
});

it("refresh immediately removes display authority and never presents arbitrary provider error text", async () => {
	let fail = false;
	const waiting = deferred<SlackMessagePage>();
	const { controller } = harness(async (_, path) => {
		if (path === "slack.history" && fail) return waiting.promise;
	});
	await controller.ensureTarget("C01");
	fail = true;
	const refresh = controller.refreshCurrent();
	assert.equal(controller.store.getState().loadedTarget, null);
	assert.equal(controller.store.getState().messageLoading, true);
	waiting.resolve({ ...page(), authors: [{ id: "U99", name: "Secret malicious provider text" }] });
	await refresh;
	assert.equal(controller.store.getState().messageError, SLACK_MESSAGES_ERROR);
	assert.deepEqual(controller.store.getState().authors, {});
	controller.dispose();
});

it("dispose cancels waiting readers and prevents all subsequent fetches", async () => {
	const entered = deferred<void>();
	const { controller, calls } = harness(async (_, path) => {
		if (path === "slack.history") {
			entered.resolve();
			return new Promise(() => {});
		}
	});
	const read = controller.ensureTarget("C01").catch(() => {});
	await entered.promise;
	controller.dispose();
	await read;
	const count = calls.length;
	await controller.start();
	await controller.refreshConversations();
	await controller.loadOlder();
	await assert.rejects(controller.ensureTarget("C02"));
	assert.equal(calls.length, count);
	assert.equal(controller.store.getState().loadedTarget, null);
});

it("bounded pagination retains the actual loaded messages and explicitly stops at the reader limit", async () => {
	const { controller, calls } = harness(async (_, path, input) => {
		if (path !== "slack.history") return;
		const offset = Number((input as { cursor?: string }).cursor ?? 0);
		return {
			...page(),
			items: Array.from({ length: 15 }, (_, index) =>
				message(`1000000000.${String(offset + index).padStart(6, "0")}`)
			),
			nextCursor: String(offset + 15),
			hasMore: true,
		};
	});
	await controller.ensureTarget("C01");
	for (let index = 0; index < 40; index++) await controller.loadOlder();
	const state = controller.store.getState();
	assert.equal(state.messages.length, 600);
	assert.equal(state.loadedTarget, "C01");
	assert.match(state.messageError, /600 messages/);
	assert.equal(state.messageHasMore, false);
	const count = calls.length;
	await controller.loadOlder();
	assert.equal(calls.length, count);
	await controller.refreshCurrent();
	assert.equal(controller.store.getState().messages.length, 15);
	assert.equal(controller.store.getState().messageError, "");
	controller.dispose();
});

it("rejects malformed catalog IDs before rendering navigation targets", async () => {
	const { controller } = harness(async (_, path) =>
		path === "slack.conversations"
			? { items: [{ ...conversation(), id: "C01/thread" }], nextCursor: null, hasMore: false }
			: undefined
	);
	await controller.start();
	assert.deepEqual(controller.store.getState().conversations, []);
	assert.equal(controller.store.getState().listError, SLACK_LIST_ERROR);
	controller.dispose();
});
