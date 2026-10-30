import assert from "node:assert/strict";
import { it } from "node:test";
import { type ChatMessage, ChatMessageSchema } from "../../shared/contracts/chat";
import { AgentCommunicationSchema, KnowledgeFactSchema } from "../../shared/contracts/knowledge";
import { chatSourceId, sourceFromChatMessage } from "./chat-source";
import { KnowledgeAccessError } from "./policy";
import { alice, bob, eve, fact, harness, message, now } from "./tests/harness";

function chat(patch: Partial<ChatMessage> = {}): ChatMessage {
	return ChatMessageSchema.parse({
		citation: {
			source: {
				provider: "slack",
				workspaceId: "w1",
				conversationId: "C1",
				messageId: "1761859200.123456",
				threadId: "1761859100.000001",
				revisionId: "edited:1761859300.000001",
				permalink: "https://controlled.invalid/archives/C1/p1761859200123456",
			},
			audience: {
				workspaceId: "w1",
				conversationId: "C1",
				visibility: "public_channel",
				readerIds: [],
				membershipRevision: "acl-r1",
				observedAt: now,
			},
		},
		authorId: "alice",
		text: "Decision: ship blue.",
		createdAt: now,
		updatedAt: now,
		deletedAt: null,
		truncated: false,
		...patch,
	});
}

function inputFor(source = sourceFromChatMessage(chat(), 1)) {
	const ref = { sourceId: source.sourceId, revision: source.revision };
	return fact({ sources: [ref], basis: { kind: "recorded", source: ref } });
}

it("maps real source identity/revision, attribution, thread, permalink and captured audience without invention", () => {
	const original = chat();
	const row = sourceFromChatMessage(original, 10);
	assert.equal(row.sourceId, chatSourceId(original.citation.source));
	assert.equal(row.revision, original.citation.source.revisionId);
	assert.equal(row.text, original.text);
	assert.equal(row.authorUserId, original.authorId);
	assert.deepEqual(row.citation, original.citation);
	assert.equal(
		chatSourceId({ ...original.citation.source, revisionId: "another" }),
		row.sourceId,
		"Revision is pinned separately from source identity"
	);
	assert.notEqual(chatSourceId({ ...original.citation.source, workspaceId: "w2" }), row.sourceId);
	assert.notEqual(
		chatSourceId({ ...original.citation.source, messageId: "another" }),
		row.sourceId
	);
});

it("serves canonical strict shared knowledge DTOs with exact Slack citations", async () => {
	const h = harness();
	const row = sourceFromChatMessage(chat(), 1);
	await h.ingest(row);
	await h.service.recordFact(alice, inputFor(row));
	const results = await h.service.searchSharedExact(bob, {
		scope: { kind: "company" },
		text: "ship",
	});
	assert.equal(results.length, 1);
	const dto = KnowledgeFactSchema.parse(results[0]);
	assert.equal(dto.title, "Shipping decision");
	assert.equal(dto.provenance, "recorded");
	assert.deepEqual(dto.sources, [chat().citation]);
	assert.equal(dto.ownerUserId, null);
	assert.equal(dto.state, "active");
	assert.equal(dto.supersededById, null);
	assert.ok(!("createdBy" in dto));
});

it("inferred public DTOs retain the explanation and exact source revision", async () => {
	const h = harness();
	const row = sourceFromChatMessage(chat(), 1);
	await h.ingest(row);
	await h.service.recordFact(alice, {
		...inputFor(row),
		text: "Blue seems intended.",
		basis: { kind: "inferred", explanation: "Interpretation, not an author quotation." },
	});
	const results = await h.service.searchSharedExact(bob, {
		scope: { kind: "company" },
		text: "intended",
	});
	assert.equal(results[0]?.provenance, "inferred");
	assert.equal(results[0]?.explanation, "Interpretation, not an author quotation.");
	assert.equal(results[0]?.sources[0]?.source.revisionId, row.revision);
});

it("projects supersession and contradictions from authorized reverse edges outside the search match", async () => {
	const h = harness();
	const row = sourceFromChatMessage(chat(), 1);
	await h.ingest(row);
	await h.service.recordFact(alice, inputFor(row));
	const nextChat = chat({
		text: "Decision: ship red.",
		citation: {
			...chat().citation,
			source: { ...chat().citation.source, messageId: "1761859400.000001" },
		},
	});
	const next = sourceFromChatMessage(nextChat, 1);
	await h.ingest(next);
	await h.service.recordFact(alice, {
		...inputFor(next),
		id: "f2",
		text: "Decision: ship red.",
		supersedes: ["f1"],
		contradicts: ["f1"],
	});
	const query = { scope: { kind: "company" }, text: "blue" };
	const shared = await h.service.searchSharedExact(bob, query);
	assert.equal(shared.length, 1);
	assert.equal(shared[0]?.state, "superseded");
	assert.equal(shared[0]?.supersededById, "f2");
	const views = await h.service.searchExact(bob, query);
	assert.deepEqual(views[0]?.contradictedByIds, ["f2"]);
	h.setLive({ ...next, sequence: 2, state: "revoked", text: null });
	const visible = await h.service.searchSharedExact(bob, query);
	assert.equal(visible[0]?.state, "active");
	assert.equal(visible[0]?.supersededById, null);
	assert.deepEqual((await h.service.searchExact(bob, query))[0]?.contradictedByIds, []);
	assert.ok(!JSON.stringify(visible).includes("f2"));
});

it("canonical messages preserve citations and remain queued until an actual delivery receipt", async () => {
	const h = harness();
	const row = sourceFromChatMessage(chat(), 1);
	await h.ingest(row);
	await h.service.admitDirectMessage(alice, message({ sources: inputFor(row).sources }));
	const inbox = await h.service.readSharedInbox(bob);
	const dto = AgentCommunicationSchema.parse(inbox[0]);
	assert.equal(dto.fromUserId, "alice");
	assert.equal(dto.toUserId, "bob");
	assert.deepEqual(dto.sources, [chat().citation]);
	assert.equal(dto.state, "queued");
	assert.equal(dto.deliveredAt, null);
	h.revokeUser("alice");
	assert.deepEqual(await h.service.readSharedInbox(bob), []);
});

it("private and group DM mappings retain their actual visibility and cannot enter company memory", async () => {
	for (const visibility of ["private_channel", "direct_message", "group_direct_message"] as const) {
		const original = chat();
		original.citation.audience = {
			...original.citation.audience,
			visibility,
			readerIds: ["alice", "bob"],
		};
		const row = sourceFromChatMessage(original, 1);
		const h = harness();
		await h.ingest(row);
		await assert.rejects(h.service.recordFact(alice, inputFor(row)), KnowledgeAccessError);
		await h.service.recordFact(alice, {
			...inputFor(row),
			scope: { kind: "private", ownerUserId: "alice" },
		});
		const output = await h.service.searchSharedExact(alice, {
			scope: { kind: "private", ownerUserId: "alice" },
			text: "ship",
		});
		assert.equal(output[0]?.sources[0]?.audience.visibility, visibility);
		assert.equal(
			(
				await h.service.admitDirectMessage(
					alice,
					message({ sources: inputFor(row).sources, recipientAgentId: "eve-agent" })
				)
			).status,
			"rejected"
		);
	}
});

it("captured citations alone never grant current source audience access", async () => {
	const original = chat();
	original.citation.audience = {
		...original.citation.audience,
		visibility: "private_channel",
		readerIds: ["alice", "bob", "eve"],
	};
	const row = sourceFromChatMessage(original, 1);
	const h = harness();
	await h.ingest(row);
	await h.service.recordFact(eve, {
		...inputFor(row),
		scope: { kind: "private", ownerUserId: "eve" },
	});
	h.setLive({ ...row, sequence: 2, audience: { kind: "users", userIds: ["alice"] } });
	assert.deepEqual(
		await h.service.searchSharedExact(eve, {
			scope: { kind: "private", ownerUserId: "eve" },
			text: "ship",
		}),
		[]
	);
});

it("refuses citation/source identity mismatches and captured-audience forgery", async () => {
	const row = sourceFromChatMessage(chat(), 1);
	const h = harness();
	await h.ingest(row);
	for (const tampered of [
		{
			...row,
			citation: { ...chat().citation, source: { ...chat().citation.source, messageId: "another" } },
		},
		{
			...row,
			citation: {
				...chat().citation,
				source: { ...chat().citation.source, revisionId: "another" },
			},
		},
		{
			...row,
			citation: {
				...chat().citation,
				audience: { ...chat().citation.audience, visibility: "private_channel" as const },
			},
		},
	]) {
		h.setLive(tampered);
		await assert.rejects(h.service.applySource(tampered), KnowledgeAccessError);
	}
});

it("does not fabricate Slack identity for local-only sources", async () => {
	const h = harness();
	await h.ingest();
	await h.service.recordFact(alice, fact());
	assert.equal(
		(await h.service.searchExact(alice, { scope: { kind: "company" }, text: "ship" })).length,
		1
	);
	await assert.rejects(
		h.service.searchSharedExact(alice, { scope: { kind: "company" }, text: "ship" }),
		/shared projection unavailable/
	);
	await h.service.admitDirectMessage(alice, message());
	await assert.rejects(h.service.readSharedInbox(bob), /shared projection unavailable/);
});

it("does not silently truncate source text or invent missing private membership", () => {
	assert.throws(() => sourceFromChatMessage(chat({ truncated: true }), 1), /Truncated/);
	const original = chat();
	original.citation.audience = {
		...original.citation.audience,
		visibility: "private_channel",
		readerIds: [],
	};
	assert.throws(() => sourceFromChatMessage(original, 1));
	const deleted = sourceFromChatMessage(chat({ text: "", deletedAt: now }), 2);
	assert.equal(deleted.text, null);
	assert.equal(deleted.state, "deleted");
});

it("new owner can receive new messages without gaining the previous owner's history", async () => {
	const h = harness();
	const row = sourceFromChatMessage(chat(), 1);
	await h.ingest(row);
	await h.service.admitDirectMessage(alice, message({ sources: inputFor(row).sources }));
	h.setOwner("bob-agent", "eve");
	await h.service.admitDirectMessage(
		alice,
		message({ requestId: "new-owner", sources: inputFor(row).sources })
	);
	const inbox = await h.service.readSharedInbox({ ...eve, agentId: "bob-agent" });
	assert.equal(inbox.length, 1);
	assert.equal(inbox[0]?.toUserId, "eve");
	assert.equal(h.read().messages.length, 2);
});
