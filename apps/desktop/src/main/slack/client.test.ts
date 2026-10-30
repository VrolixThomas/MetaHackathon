import assert from "node:assert/strict";
import { test } from "node:test";
import {
	TestReplyLedger,
	credential,
	harness,
	privateChannel,
	rawMessage,
	source,
} from "./test-support";
import { SlackError } from "./types";

test("capabilities verify user identity; bots cannot imply user-level DMs", async () => {
	const { client } = harness();
	const capability = await client.capabilities();
	assert.equal(capability.discovery, "user-memberships");
	assert.equal(capability.polling.deletes, "not-observable");
	assert.equal(
		capability.visibility.find((row) => row.kind === "direct_message")?.membershipRequired,
		true
	);
	await assert.rejects(
		harness(() => ({
			ok: true,
			team_id: "T123",
			user_id: "U123",
			bot_id: "B123",
		})).client.capabilities(),
		SlackError
	);
});

test("conversation discovery asks for connected user memberships and preserves empty cursor pages", async () => {
	const { client, requests } = harness((method, fields) =>
		method === "users.conversations"
			? {
					ok: true,
					channels: fields["cursor"] ? [privateChannel()] : [],
					response_metadata: { next_cursor: fields["cursor"] ? "" : "next-page" },
				}
			: undefined
	);
	const first = await client.listConversations();
	assert.deepEqual(first, { items: [], hasMore: true, nextCursor: "next-page" });
	const second = await client.listConversations({ cursor: first.nextCursor ?? undefined });
	assert.equal(second.items[0]?.visibility, "direct_message");
	assert.equal(requests[0]?.method, "users.conversations");
	assert.equal(requests[0]?.fields["user"], undefined);
	assert.equal(requests[0]?.fields["limit"], 15);
});

test("history and thread pages retain verbatim text, edit identity, private audience and cursor", async () => {
	const { client } = harness((method) =>
		method === "conversations.history"
			? {
					ok: true,
					messages: [{ ...rawMessage, edited: { ts: "1700000001.000002" }, reply_count: 2 }],
					response_metadata: { next_cursor: "history-next" },
				}
			: method === "conversations.replies"
				? {
						ok: true,
						messages: [{ ...rawMessage, ts: "1700000002.000003", thread_ts: source.messageId }],
					}
				: undefined
	);
	const page = await client.history({ conversationId: "D123" });
	assert.equal(page.items[0]?.text, rawMessage.text);
	assert.equal(page.items[0]?.citation.source.revisionId, "1700000001.000002");
	assert.equal(page.items[0]?.citation.audience.visibility, "direct_message");
	assert.deepEqual(page.items[0]?.citation.audience.readerIds, ["U123", "U456"]);
	assert.equal(page.nextCursor, "history-next");
	assert.deepEqual(page.threadIds, [source.messageId]);
	const thread = await client.thread({ conversationId: "D123", threadTs: source.messageId });
	assert.equal(thread.items[0]?.citation.source.threadId, source.messageId);
});

test("private membership loss, incomplete membership, missing scopes and foreign channels fail closed", async () => {
	for (const handler of [
		(method: string) =>
			method === "conversations.members" ? { ok: true, members: ["U456"] } : undefined,
		(method: string) =>
			method === "conversations.members"
				? { ok: true, members: ["U123"], response_metadata: { next_cursor: "repeat" } }
				: undefined,
		(method: string) =>
			method === "conversations.info" ? { ok: true, channel: privateChannel("D999") } : undefined,
	])
		await assert.rejects(harness(handler).client.history({ conversationId: "D123" }), SlackError);
	await assert.rejects(
		harness(undefined, async () => ({ ...credential, scopes: ["im:read"] })).client.history({
			conversationId: "D123",
		}),
		(error: unknown) => error instanceof SlackError && error.code === "missing-scope"
	);
});

test("account changes fence late provider responses", async () => {
	let account = credential;
	const { client } = harness(
		(method) => {
			if (method === "conversations.history") {
				account = { ...credential, connectionId: "new-account" };
				return { ok: true, messages: [rawMessage] };
			}
			return undefined;
		},
		async () => account
	);
	await assert.rejects(
		client.history({ conversationId: "D123" }),
		(error: unknown) => error instanceof SlackError && error.code === "stale-connection"
	);
});

test("explicit public reads support user visibility beyond membership; C-prefixed private channels stay private", async () => {
	const publicClient = harness((method) =>
		method === "conversations.info"
			? { ok: true, channel: { id: "C123", is_channel: true, is_private: false } }
			: method === "conversations.members"
				? { ok: true, members: ["U456"] }
				: undefined
	);
	const publicPage = await publicClient.client.history({ conversationId: "C123" });
	assert.equal(publicPage.items[0]?.citation.audience.visibility, "public_channel");
	const privateClient = harness((method) =>
		method === "conversations.info"
			? { ok: true, channel: { id: "C123", is_channel: true, is_private: true } }
			: undefined
	);
	assert.equal(
		(await privateClient.client.history({ conversationId: "C123" })).items[0]?.citation.audience
			.visibility,
		"private_channel"
	);
});

test("source authorization requires exact current revision and thread", async () => {
	await assert.rejects(
		harness().client.sourceMessage({ ...source, revisionId: "1700000001.000001" }),
		SlackError
	);
	await assert.rejects(
		harness((method) =>
			method === "conversations.replies"
				? {
						ok: true,
						messages: [{ ...rawMessage, ts: "1700000003.000003", thread_ts: "1700000002.000002" }],
					}
				: undefined
		).client.thread({ conversationId: "D123", threadTs: source.messageId }),
		SlackError
	);
});

test("reply dedup uses durable exact-body reservation and delivers only confirmed original-thread receipt", async () => {
	const { client, requests, ledger } = harness();
	const input = { requestId: "reply-1", source, body: "Actual answer" };
	const [first, second] = await Promise.all([client.send(input), client.send(input)]);
	assert.deepEqual(first, second);
	assert.equal(first.source.messageId, "1800000000.000001");
	assert.equal(first.source.threadId, source.messageId);
	assert.equal(first.bodyDigest.length, 64);
	assert.equal(requests.filter((row) => row.method === "chat.postMessage").length, 1);
	const restored = harness(undefined, undefined, ledger);
	assert.deepEqual(await restored.client.send(input), first);
	assert.equal(restored.requests.filter((row) => row.method === "chat.postMessage").length, 0);
	await assert.rejects(
		restored.client.send({ ...input, body: "Different answer" }),
		(error: unknown) => error instanceof SlackError && error.code === "request-conflict"
	);
});

test("ambiguous delivery survives adapter restart and is never automatically resent", async () => {
	const ledger = new TestReplyLedger();
	const first = harness(
		(method) => {
			if (method === "chat.postMessage") throw new Error("transport-secret");
			return undefined;
		},
		undefined,
		ledger
	);
	const input = { requestId: "reply-uncertain", source, body: "answer" };
	await assert.rejects(
		first.client.send(input),
		(error: unknown) => error instanceof SlackError && error.code === "uncertain-delivery"
	);
	const restored = harness(undefined, undefined, ledger);
	await assert.rejects(
		restored.client.send(input),
		(error: unknown) => error instanceof SlackError && error.code === "uncertain-delivery"
	);
	assert.equal(restored.requests.filter((row) => row.method === "chat.postMessage").length, 0);
});

test("wrong provider receipts, stale source and wrong workspace cannot establish delivery", async () => {
	const input = { requestId: "reply-wrong", source, body: "answer" };
	await assert.rejects(
		harness((method) =>
			method === "chat.postMessage"
				? {
						ok: true,
						channel: "D999",
						ts: "1800000000.000001",
						message: { text: "answer", thread_ts: source.messageId },
					}
				: undefined
		).client.send(input),
		(error: unknown) => error instanceof SlackError && error.code === "uncertain-delivery"
	);
	const stale = harness((method) =>
		method === "conversations.history"
			? { ok: true, messages: [{ ...rawMessage, edited: { ts: "1700000001.000001" } }] }
			: undefined
	);
	await assert.rejects(stale.client.send(input), SlackError);
	assert.equal(stale.requests.filter((row) => row.method === "chat.postMessage").length, 0);
	await assert.rejects(
		harness().client.send({ ...input, source: { ...source, workspaceId: "T999" } }),
		SlackError
	);
});
