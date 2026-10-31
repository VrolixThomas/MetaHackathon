import assert from "node:assert/strict";
import { test } from "node:test";
import { credential, harness, source } from "../slack/test-support";
import { SlackError } from "../slack/types";
import { SlackReader } from "./slack-reader";

test("reader returns only actual message identity, authorized metadata and observed author labels", async () => {
	const h = harness((method, fields) =>
		method === "users.info"
			? { ok: true, user: { id: fields["user"], profile: { display_name: "Observed peer" } } }
			: undefined
	);
	const reader = new SlackReader({
		getClient: () => h.client,
		getCredential: async () => credential,
		getEpoch: () => 0,
	});
	const page = await reader.read({ conversationId: source.conversationId, threadTs: null });
	assert.equal(page.conversation.id, source.conversationId);
	assert.deepEqual(page.actor, { workspaceId: credential.workspaceId, userId: credential.userId });
	assert.equal(page.items[0]?.citation.source.messageId, source.messageId);
	assert.deepEqual(page.authors, [{ id: "U456", name: "Observed peer" }]);
	assert.equal(page.threadTs, null);
});

test("retired actor or generation cannot receive a delayed message page", async () => {
	for (const changeActor of [false, true]) {
		const h = harness();
		let epoch = 0;
		let current = credential;
		const client = {
			listConversations: h.client.listConversations.bind(h.client),
			conversation: h.client.conversation.bind(h.client),
			history: h.client.history.bind(h.client),
			thread: h.client.thread.bind(h.client),
			authorLabels: async () => {
				if (changeActor) current = { ...credential, userId: "UOTHER" };
				else epoch++;
				return [{ id: "U456", name: "Observed peer" }];
			},
		};
		const reader = new SlackReader({
			getClient: () => client,
			getCredential: async () => current,
			getEpoch: () => epoch,
		});
		await assert.rejects(
			reader.read({ conversationId: source.conversationId, threadTs: null }),
			(error) => error instanceof SlackError && error.code === "stale-connection"
		);
	}
});

test("unauthenticated and cancelled reads never call the provider", async () => {
	const h = harness();
	const reader = new SlackReader({
		getClient: () => h.client,
		getCredential: async () => undefined,
		getEpoch: () => 0,
	});
	await assert.rejects(
		reader.read({ conversationId: source.conversationId, threadTs: null }),
		(error) => error instanceof SlackError && error.code === "connection-required"
	);
	const abort = new AbortController();
	abort.abort();
	await assert.rejects(
		reader.read({ conversationId: source.conversationId, threadTs: null }, abort.signal)
	);
	assert.equal(h.requests.length, 0);
});
