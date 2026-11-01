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
	assert.equal(requests[0]?.fields["limit"], "15");
	assert.equal(requests[0]?.fields["exclude_archived"], "true");
	assert.equal(requests[1]?.fields["cursor"], "next-page");
});

test("history and thread pages retain verbatim text, edit identity, private audience and cursor", async () => {
	const { client, requests } = harness((method) =>
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
	assert.equal(
		requests.find((row) => row.method === "conversations.history")?.fields["channel"],
		"D123"
	);
	assert.equal(
		requests.find((row) => row.method === "conversations.replies")?.fields["ts"],
		source.messageId
	);
});

test("joined catalog excludes archived and explicitly nonmember rows while preserving the actual cursor", async () => {
	const { client } = harness((method) =>
		method === "users.conversations"
			? {
					ok: true,
					channels: [
						{ id: "C1", name: "active", is_channel: true, is_private: false, is_member: true },
						{ id: "C2", name: "archived", is_channel: true, is_private: false, is_archived: true },
						{ id: "C3", name: "not-joined", is_channel: true, is_private: false, is_member: false },
					],
					response_metadata: { next_cursor: "next-page" },
				}
			: undefined
	);
	const page = await client.listConversations({}, undefined, false);
	assert.deepEqual(
		page.items.map((row) => row.id),
		["C1"]
	);
	assert.equal(page.nextCursor, "next-page");
	assert.equal(page.hasMore, true);
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

test("cancellation also bounds an injected credential lookup that never settles", async () => {
	const { client } = harness(undefined, () => new Promise(() => {}));
	const controller = new AbortController();
	const pending = client.history({ conversationId: "D123" }, controller.signal);
	controller.abort();
	await assert.rejects(
		pending,
		(error: unknown) => error instanceof SlackError && error.code === "cancelled"
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

test("discovered DMs and group DMs use actual peer profiles while retaining conversation IDs", async () => {
	const { client, requests } = harness((method, fields) => {
		if (method === "users.conversations")
			return {
				ok: true,
				channels: [
					{ id: "D123", is_im: true, user: "U456" },
					{ id: "D234", is_im: true, user: "USLACKBOT" },
					{
						id: "G123",
						is_mpim: true,
						name: "mpdm-actual-slug",
						members: ["U123", "U456", "U789"],
					},
					{ id: "C123", is_channel: true, is_private: false, name: "engineering" },
				],
			};
		if (method === "users.info")
			return {
				ok: true,
				user: {
					id: fields["user"],
					is_bot: fields["user"] === "USLACKBOT",
					deleted: fields["user"] === "U789",
					profile: {
						display_name: fields["user"] === "USLACKBOT" ? "Slackbot" : "Ada",
						real_name: null,
					},
				},
			};
		return undefined;
	});
	const page = await client.listConversations();
	assert.deepEqual(
		page.items.map(({ id, name }) => ({ id, name })),
		[
			{ id: "D123", name: "Ada" },
			{ id: "D234", name: "Slackbot" },
			{ id: "G123", name: "Ada, U789" },
			{ id: "C123", name: "engineering" },
		]
	);
	assert.equal(requests.filter((row) => row.method === "users.info").length, 3);
	assert.equal(requests.filter((row) => row.method === "conversations.members").length, 0);
	await client.listConversations();
	assert.equal(
		requests.filter((row) => row.method === "users.info").length,
		3,
		"cached peers must not refetch each scan"
	);
});

test("unavailable or mismatched peer profiles fall back to identities without failing discovery", async () => {
	const { client } = harness((method, fields) => {
		if (method === "users.conversations")
			return {
				ok: true,
				channels: [
					{ id: "D123", is_im: true, user: "U456" },
					{ id: "D234", is_im: true, user: "U789" },
				],
			};
		if (method === "users.info") {
			if (fields["user"] === "U456") throw new SlackError("rate-limited");
			return { ok: true, user: { id: "U999", name: "Unrelated person" } };
		}
		return undefined;
	});
	assert.deepEqual(
		(await client.listConversations()).items.map((row) => row.name),
		["U456", "U789"]
	);
});

test("background discovery skips all label and group-member work with the third parameter", async () => {
	const { client, requests } = harness((method, fields) => {
		if (method === "users.conversations")
			return {
				ok: true,
				channels: [privateChannel(), { id: "G123", is_mpim: true, name: "mpdm-source-name" }],
				response_metadata: { next_cursor: "next-page" },
			};
		if (method === "users.info") return { ok: true, user: { id: fields["user"], name: "Ada" } };
		return undefined;
	});
	const page = await client.listConversations({ limit: 15 }, undefined, false);
	assert.deepEqual(
		page.items.map((row) => row.name),
		["U456", "mpdm-source-name"]
	);
	assert.equal(page.nextCursor, "next-page");
	assert.equal(page.hasMore, true);
	assert.deepEqual(
		requests.map((row) => row.method),
		["users.conversations"]
	);
	assert.deepEqual(
		(await client.listConversations()).items.map((row) => row.name),
		["Ada", "Ada"]
	);
	assert.ok(requests.some((row) => row.method === "users.info"));
});

test("conversation returns actual authorized metadata and a cached profile label with one info request", async () => {
	const { client, requests } = harness((method, fields) => {
		if (method === "conversations.info")
			return { ok: true, channel: { ...privateChannel(), context_team_id: "T123" } };
		if (method === "users.info")
			return { ok: true, user: { id: fields["user"], profile: { display_name: "Ada" } } };
		return undefined;
	});
	assert.deepEqual(await client.conversation("D123"), {
		workspaceId: "T123",
		id: "D123",
		name: "Ada",
		visibility: "direct_message",
		canRead: true,
		canReply: true,
	});
	assert.equal(requests.filter((row) => row.method === "conversations.info").length, 1);
	assert.equal(
		requests.find((row) => row.method === "conversations.members")?.fields["limit"],
		"200"
	);
	assert.deepEqual(await client.authorLabels(["U456", "U456"]), [{ id: "U456", name: "Ada" }]);
	assert.equal(requests.filter((row) => row.method === "users.info").length, 1);
	assert.ok(requests.every((row) => row.method !== "chat.postMessage"));
});

test("group conversation names reuse the authorized audience instead of crawling for labels", async () => {
	const { client, requests } = harness((method, fields) => {
		if (method === "conversations.info")
			return {
				ok: true,
				channel: { id: "G123", context_team_id: "T123", is_mpim: true, members: ["U999"] },
			};
		if (method === "conversations.members") return { ok: true, members: ["U123", "U456", "U789"] };
		if (method === "users.info")
			return {
				ok: true,
				user: {
					id: fields["user"],
					profile: { display_name: fields["user"] === "U456" ? "Ada" : "Bo" },
				},
			};
		return undefined;
	});
	assert.equal((await client.conversation("G123")).name, "Ada, Bo");
	assert.equal(requests.filter((row) => row.method === "conversations.members").length, 1);
	assert.deepEqual(
		requests.filter((row) => row.method === "users.info").map((row) => row.fields["user"]),
		["U456", "U789"]
	);
});

test("conversation rejects wrong metadata identity, workspace, private membership and missing history scope", async () => {
	for (const channel of [
		{ ...privateChannel("D999") },
		{ ...privateChannel(), context_team_id: "T999" },
		{ ...privateChannel(), user: "U999" },
	]) {
		const { client, requests } = harness((method) =>
			method === "conversations.info" ? { ok: true, channel } : undefined
		);
		await assert.rejects(
			client.conversation("D123"),
			(error: unknown) => error instanceof SlackError && error.code === "invalid-data"
		);
		assert.ok(!requests.some((row) => row.method === "users.info"));
	}
	const denied = harness((method) =>
		method === "conversations.members" ? { ok: true, members: ["U456"] } : undefined
	);
	await assert.rejects(
		denied.client.conversation("D123"),
		(error: unknown) => error instanceof SlackError && error.code === "access-denied"
	);
	const missing = harness(undefined, async () => ({
		...credential,
		scopes: ["im:read", "users:read"],
	}));
	await assert.rejects(
		missing.client.conversation("D123"),
		(error: unknown) => error instanceof SlackError && error.code === "missing-scope"
	);
	assert.ok(!missing.requests.some((row) => row.method === "conversations.members"));
});

test("Slackbot metadata permits the system peer omitted by Slack while still requiring human membership", async () => {
	let joined = true;
	const { client } = harness((method) =>
		method === "conversations.info"
			? { ok: true, channel: { ...privateChannel(), user: "USLACKBOT" } }
			: method === "conversations.members"
				? { ok: true, members: joined ? [credential.userId] : [] }
				: undefined
	);
	assert.equal((await client.conversation("D123")).visibility, "direct_message");
	assert.deepEqual((await client.audience("D123")).readerIds, [credential.userId]);
	joined = false;
	await assert.rejects(
		client.conversation("D123"),
		(error: unknown) => error instanceof SlackError && error.code === "access-denied"
	);
});

test("reader conversation requires public membership while existing explicit source reads retain public visibility", async () => {
	let joined = false;
	const { client } = harness((method) =>
		method === "conversations.info"
			? {
					ok: true,
					channel: {
						id: "C123",
						name: "actual-public-channel",
						context_team_id: "T123",
						is_channel: true,
						is_private: false,
					},
				}
			: method === "conversations.members"
				? { ok: true, members: joined ? ["U123", "U456"] : ["U456"] }
				: undefined
	);
	await assert.rejects(
		client.conversation("C123"),
		(error: unknown) => error instanceof SlackError && error.code === "access-denied"
	);
	assert.equal((await client.history({ conversationId: "C123" })).items.length, 1);
	joined = true;
	const conversation = await client.conversation("C123");
	assert.equal(conversation.name, "actual-public-channel");
	assert.equal(conversation.workspaceId, "T123");
	assert.equal(conversation.visibility, "public_channel");
});

test("observed author labels retain IDs, deduplicate and fall back without a channel or member lookup", async () => {
	const { client, requests } = harness((method, fields) => {
		if (method === "conversations.history")
			return {
				ok: true,
				messages: [rawMessage, { ...rawMessage, ts: "1700000000.000002", user: "U789" }],
			};
		if (method === "users.info") {
			if (fields["user"] === "U789") throw new SlackError("rate-limited");
			return { ok: true, user: { id: fields["user"], profile: { display_name: "Ada" } } };
		}
		return undefined;
	});
	const page = await client.history({ conversationId: "D123" });
	const before = requests.length;
	assert.deepEqual(
		await client.authorLabels([
			...page.items.map((row) => row.authorId),
			page.items[0]?.authorId as string,
		]),
		[
			{ id: "U456", name: "Ada" },
			{ id: "U789", name: "U789" },
		]
	);
	assert.deepEqual(
		requests.slice(before).map((row) => row.method),
		["users.info", "users.info"]
	);
	await client.authorLabels(page.items.map((row) => row.authorId));
	assert.equal(requests.length, before + 2);
});

test("author input and metadata bounds reject before any provider request", async () => {
	const { client, requests } = harness();
	await assert.rejects(
		client.authorLabels(Array.from({ length: 16 }, (_, index) => `U${index}`)),
		SlackError
	);
	await assert.rejects(client.authorLabels(["../not-an-author"]), SlackError);
	await assert.rejects(client.conversation("../not-a-conversation"), SlackError);
	assert.deepEqual(await client.authorLabels([]), []);
	assert.equal(requests.length, 0);
});

test("reader metadata and authors reject account changes during info, membership and profile requests", async () => {
	for (const boundary of ["conversations.info", "conversations.members", "users.info"]) {
		let current = credential;
		const { client } = harness(
			(method, fields) => {
				if (method === boundary) current = { ...credential, workspaceId: "T999" };
				if (method === "users.info")
					return { ok: true, user: { id: fields["user"], name: "Old account name" } };
				return undefined;
			},
			async () => current
		);
		await assert.rejects(
			client.conversation("D123"),
			(error: unknown) => error instanceof SlackError && error.code === "stale-connection"
		);
	}
	let current = credential;
	const { client } = harness(
		(method, fields) => {
			if (method === "users.info") {
				current = { ...credential, connectionId: "new-session" };
				return { ok: true, user: { id: fields["user"], name: "Old author" } };
			}
			return undefined;
		},
		async () => current
	);
	await assert.rejects(
		client.authorLabels(["U456"]),
		(error: unknown) => error instanceof SlackError && error.code === "stale-connection"
	);
});

test("cancellation aborts metadata and author requests even if controlled fetch ignores the signal", async () => {
	for (const authors of [false, true]) {
		let started: () => void = () => {};
		const reached = new Promise<void>((resolve) => {
			started = resolve;
		});
		const { client } = harness((method) => {
			if (method === "users.info") {
				started();
				return new Promise(() => {});
			}
			return undefined;
		});
		const controller = new AbortController();
		const pending = authors
			? client.authorLabels(["U456"], controller.signal)
			: client.conversation("D123", controller.signal);
		await reached;
		controller.abort();
		await assert.rejects(
			pending,
			(error: unknown) => error instanceof SlackError && error.code === "cancelled"
		);
	}
});

test("thread-observation sends consume actual short-lived pages and recheck membership without duplicate history reads", async () => {
	const h = harness();
	const page = await h.client.thread({
		conversationId: source.conversationId,
		threadTs: source.messageId,
	});
	const input = { requestId: "clarification-post", source, body: "Which URL is affected?" };
	await assert.rejects(h.client.sendFromObservedThread(input, structuredClone(page)));
	const receipt = await h.client.sendFromObservedThread(input, page);
	assert.equal(receipt.bodyDigest.length, 64);
	assert.equal(h.requests.filter((r) => r.method === "conversations.replies").length, 1);
	assert.equal(h.requests.filter((r) => r.method === "conversations.history").length, 0);
	assert.equal(h.requests.filter((r) => r.method === "conversations.members").length, 2);
	await assert.rejects(h.client.sendFromObservedThread(input, page));
	assert.equal(h.requests.filter((r) => r.method === "chat.postMessage").length, 1);
});

for (const mode of ["membership", "account", "mutation", "partial", "final-authority"] as const)
	test(`observation send rejects ${mode} before POST`, async () => {
		let member = true;
		let active = credential;
		const ledger = new TestReplyLedger();
		const h = harness(
			(method) => {
				if (method === "conversations.members")
					return { ok: true, members: member ? ["U123", "U456"] : ["U456"] };
				if (mode === "partial" && method === "conversations.replies")
					return { ok: true, has_more: true, messages: [rawMessage] };
				return undefined;
			},
			async () => active,
			{
				reserve: ledger.reserve.bind(ledger),
				delivered: ledger.delivered.bind(ledger),
				authorize: async () => {
					if (mode === "final-authority") throw new Error("Delegation revoked after reserve");
				},
			}
		);
		const page = await h.client.thread({
			conversationId: source.conversationId,
			threadTs: source.messageId,
		});
		if (mode === "membership") member = false;
		if (mode === "account") active = { ...credential, connectionId: "new-connection" };
		if (mode === "mutation") {
			assert.ok(page.items[0]);
			page.items[0].text = "forged source";
		}
		await assert.rejects(
			h.client.sendFromObservedThread(
				{ requestId: `rejected-${mode}`, source, body: "Which URL?" },
				page
			)
		);
		assert.equal(h.requests.filter((r) => r.method === "chat.postMessage").length, 0);
	});
