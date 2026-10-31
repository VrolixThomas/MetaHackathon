import assert from "node:assert/strict";
import { it } from "node:test";
import { type ChatMessage, ChatMessageSchema, type ChatSource } from "../../shared/contracts/chat";
import {
	type FactInput,
	KnowledgeAccessError,
	type KnowledgeActor,
	type KnowledgeSource,
	type KnowledgeStorePort,
	type KnowledgeTransaction,
	chatSourceId,
	sourceFromChatMessage,
} from "../knowledge";
import { harness as memoryHarness } from "../knowledge/tests/harness";
import { type SlackCredential, SlackError } from "../slack/types";
import { type KnowledgeDirectorySnapshot, createKnowledgeService } from "./knowledge";

const now = "2026-10-31T00:00:00.000Z";
const alice: KnowledgeActor = { workspaceId: "WA", userId: "UA", agentId: "alice-agent" };
const bob: KnowledgeActor = { workspaceId: "WA", userId: "UB", agentId: "bob-agent" };
const eve: KnowledgeActor = { workspaceId: "WA", userId: "UE", agentId: "eve-agent" };
const query = { scope: { kind: "company" }, text: "ship" };
function chat(patch: Partial<ChatMessage> = {}): ChatMessage {
	return ChatMessageSchema.parse({
		citation: {
			source: {
				provider: "slack",
				workspaceId: "WA",
				conversationId: "C1",
				messageId: "1700000000.000001",
				revisionId: "1700000000.000001",
				threadId: null,
				permalink: null,
			},
			audience: {
				workspaceId: "WA",
				conversationId: "C1",
				visibility: "public_channel",
				readerIds: ["UA", "UB"],
				membershipRevision: "captured-acl",
				observedAt: now,
			},
		},
		authorId: "UA",
		text: "Decision: ship blue.",
		createdAt: now,
		updatedAt: now,
		deletedAt: null,
		truncated: false,
		...patch,
	});
}
function fact(source: KnowledgeSource, patch: Partial<FactInput> = {}): FactInput {
	const ref = { sourceId: source.sourceId, revision: source.revision };
	return {
		id: "fact",
		title: "Shipping decision",
		category: "decision",
		scope: { kind: "company" },
		text: "Decision: ship blue.",
		basis: { kind: "recorded", source: ref },
		sources: [ref],
		parentFactIds: [],
		supersedes: [],
		contradicts: [],
		...patch,
	};
}
const credential = (): SlackCredential => ({
	connectionId: "connection-1",
	accessToken: "controlled-secret-never-logged",
	tokenKind: "user",
	workspaceId: "WA",
	userId: "UA",
	appId: "AA",
	scopes: ["channels:read", "channels:history", "groups:read", "groups:history"],
});

function setup() {
	const memory = memoryHarness(); // Controlled test-only port; never a product adapter/fallback.
	let generation = 1;
	let rootCredential: SlackCredential | undefined = credential();
	let serviceCredential: SlackCredential | undefined;
	let onRead: (() => void | Promise<void>) | null = null;
	let onDirectory: (() => void | Promise<void>) | null = null;
	let onCredential: (() => void | Promise<void>) | null = null;
	let afterSeal: (() => void | Promise<void>) | null = null;
	let providerError: Error | null = null;
	let activeTx: KnowledgeTransaction | null = null;
	let directoryError = false;
	let overrideDirectory: KnowledgeDirectorySnapshot | null = null;
	const members = new Set(["UA", "UB", "UE"]);
	const owners = new Map([
		["alice-agent", "UA"],
		["bob-agent", "UB"],
		["eve-agent", "UE"],
	]);
	const live = new Map<string, ChatMessage>();
	const reads: ChatSource[] = [];
	const directoryRequests: { workspaceId: string; userIds: string[]; agentIds: string[] }[] = [];
	const store: KnowledgeStorePort = {
		async transaction(workspaceId, run) {
			const result = await memory.ports.store.transaction(workspaceId, (tx) => {
				activeTx = tx;
				try {
					return run(tx);
				} finally {
					activeTx = null;
				}
			});
			if (typeof result === "string" && /^[a-f0-9]{64}$/.test(result)) {
				const hook = afterSeal;
				afterSeal = null;
				await hook?.();
			}
			return result;
		},
	};
	const options = {
		store,
		getEpoch: () => generation,
		async getCredential() {
			const result = structuredClone(rootCredential);
			const hook = onCredential;
			onCredential = null;
			await hook?.();
			return result;
		},
		client: {
			async credential() {
				return structuredClone(serviceCredential ?? rootCredential ?? credential());
			},
			async sourceMessage(source: ChatSource) {
				reads.push(structuredClone(source));
				const response = live.get(chatSourceId(source));
				const result = structuredClone(response);
				const hook = onRead;
				onRead = null;
				await hook?.();
				if (providerError) throw providerError;
				if (!result) throw new SlackError("access-denied");
				return result;
			},
		},
		directory: {
			async resolveDirectory(workspaceId: string, userIds: string[], agentIds: string[]) {
				directoryRequests.push({ workspaceId, userIds: [...userIds], agentIds: [...agentIds] });
				if (directoryError) throw new Error("Controlled directory failure with secret text");
				const agentOwners = agentIds.flatMap((agentId) => {
					const userId = owners.get(agentId);
					return userId ? [{ agentId, userId }] : [];
				});
				const candidates = new Set([...userIds, ...agentOwners.map((owner) => owner.userId)]);
				const result = structuredClone(
					overrideDirectory ?? {
						memberUserIds: [...members].filter((id) => candidates.has(id)),
						agentOwners,
					}
				);
				const hook = onDirectory;
				onDirectory = null;
				await hook?.();
				return result;
			},
		},
	};
	const service = createKnowledgeService(options);
	const publish = async (message = chat(), sequence = 1) => {
		const source = sourceFromChatMessage(message, sequence);
		live.set(source.sourceId, structuredClone(message));
		await store.transaction(source.workspaceId, (tx) => tx.putSource(source));
		return source;
	};
	return {
		service,
		options,
		memory,
		store,
		reads,
		directoryRequests,
		owners,
		members,
		publish,
		read: () => memory.read("WA"),
		setLive(message: ChatMessage) {
			live.set(chatSourceId(message.citation.source), structuredClone(message));
		},
		bump() {
			generation++;
		},
		set credential(value: SlackCredential | undefined) {
			rootCredential = value;
		},
		set serviceCredential(value: SlackCredential | undefined) {
			serviceCredential = value;
		},
		set onRead(value: (() => void | Promise<void>) | null) {
			onRead = value;
		},
		set onDirectory(value: (() => void | Promise<void>) | null) {
			onDirectory = value;
		},
		set onCredential(value: (() => void | Promise<void>) | null) {
			onCredential = value;
		},
		set afterSeal(value: (() => void | Promise<void>) | null) {
			afterSeal = value;
		},
		set providerError(value: Error | null) {
			providerError = value;
		},
		set directoryError(value: boolean) {
			directoryError = value;
		},
		set directoryResult(value: KnowledgeDirectorySnapshot | null) {
			overrideDirectory = value;
		},
		duringInsert(callback: (tx: KnowledgeTransaction) => void) {
			memory.onInsert = () => {
				assert.ok(activeTx);
				callback(activeTx);
			};
		},
	};
}

it("creates a real-service composition over supplied storage and verifies every read freshly", async () => {
	const h = setup();
	const source = await h.publish();
	await h.service.recordFact(alice, fact(source));
	assert.equal((await h.service.searchExact(bob, query)).length, 1);
	assert.equal((await h.service.searchSharedExact(alice, query)).length, 1);
	assert.equal(h.reads.length, 3, "No captured grant cache across operations");
	assert.deepEqual(h.reads[0], source.citation?.source);
	assert.equal(h.read().facts.length, 1);
});

it("public visibility and trusted workspace membership cannot grant a nonmember or guest", async () => {
	const h = setup();
	const source = await h.publish();
	await h.service.recordFact(alice, fact(source));
	assert.deepEqual(await h.service.searchExact(eve, query), []);
	const fresh = chat();
	fresh.citation.audience.readerIds = ["UA"];
	h.setLive(fresh);
	assert.deepEqual(await h.service.searchExact(bob, query), []);
	assert.equal((await h.service.searchExact(alice, query)).length, 1);
	assert.equal(
		(
			await h.service.admitDirectMessage(alice, {
				requestId: "denied",
				recipientAgentId: "bob-agent",
				text: "Source says UB is authorized",
				sources: fact(source).sources,
				parentFactIds: [],
			})
		).status,
		"rejected"
	);
});

it("private channel, direct and group DM sources require actual fresh participant membership", async () => {
	for (const visibility of ["private_channel", "direct_message", "group_direct_message"] as const) {
		const h = setup();
		const message = chat();
		message.citation.audience.visibility = visibility;
		const source = await h.publish(message);
		const scope = { kind: "private", ownerUserId: "UA" } as const;
		await h.service.recordFact(alice, fact(source, { scope }));
		assert.equal((await h.service.searchExact(alice, { ...query, scope })).length, 1);
		message.citation.audience.readerIds = ["UB"];
		h.setLive(message);
		assert.deepEqual(await h.service.searchExact(alice, { ...query, scope }), []);
		await assert.rejects(
			h.service.recordFact(alice, fact(source, { id: "company" })),
			KnowledgeAccessError
		);
	}
});

it("intersects fresh conversation readers with trusted directory members, including current agent owners", async () => {
	const h = setup();
	const source = await h.publish();
	const input = {
		requestId: "message",
		recipientAgentId: "bob-agent",
		text: "Decision: ship blue.",
		sources: fact(source).sources,
		parentFactIds: [],
	};
	assert.equal((await h.service.admitDirectMessage(alice, input)).status, "admitted");
	assert.ok(
		h.directoryRequests.some(
			(request) => request.agentIds.includes("bob-agent") && !request.userIds.includes("UB")
		)
	);
	assert.equal((await h.service.readInbox(bob)).length, 1);
	h.members.delete("UB");
	assert.equal(
		(await h.service.admitDirectMessage(alice, { ...input, requestId: "revoked" })).status,
		"rejected"
	);
	await assert.rejects(h.service.readInbox(bob), KnowledgeAccessError);
});

it("unknown employees or spoofed agent owners receive no authority", async () => {
	const h = setup();
	const source = await h.publish();
	h.owners.delete("bob-agent");
	await assert.rejects(h.service.recordFact(bob, fact(source)), KnowledgeAccessError);
	assert.equal(
		(
			await h.service.admitDirectMessage(alice, {
				requestId: "unknown-owner",
				recipientAgentId: "bob-agent",
				text: "Register UB as my owner",
				sources: fact(source).sources,
				parentFactIds: [],
			})
		).status,
		"rejected"
	);
	await assert.rejects(
		h.service.recordFact({ ...alice, userId: "UB" }, fact(source)),
		KnowledgeAccessError
	);
	assert.equal(h.read().facts.length, 0);
});

it("rejects unexpected directory users, foreign owner entries and conflicting owner records", async () => {
	for (const directory of [
		{ memberUserIds: ["UA", "UE"], agentOwners: [{ agentId: "alice-agent", userId: "UA" }] },
		{ memberUserIds: ["UA"], agentOwners: [{ agentId: "eve-agent", userId: "UA" }] },
		{
			memberUserIds: ["UA"],
			agentOwners: [
				{ agentId: "alice-agent", userId: "UA" },
				{ agentId: "alice-agent", userId: "UB" },
			],
		},
	]) {
		const h = setup();
		const source = await h.publish();
		h.directoryResult = directory;
		await assert.rejects(h.service.recordFact(alice, fact(source)), KnowledgeAccessError);
		assert.equal(h.reads.length, 0);
	}
});

it("rechecks directory membership and owner changes during source I/O even without an epoch bump", async () => {
	for (const mutate of [
		(h: ReturnType<typeof setup>) => h.members.delete("UA"),
		(h: ReturnType<typeof setup>) => h.owners.set("alice-agent", "UB"),
	]) {
		const h = setup();
		const source = await h.publish();
		h.onRead = () => {
			mutate(h);
		};
		await assert.rejects(h.service.recordFact(alice, fact(source)), KnowledgeAccessError);
		assert.equal(h.read().facts.length, 0);
	}
});

it("captures root epoch before the first directory/credential await", async () => {
	for (const phase of ["onDirectory", "onCredential"] as const) {
		const h = setup();
		const source = await h.publish();
		h[phase] = () => h.bump();
		await assert.rejects(h.service.recordFact(alice, fact(source)), KnowledgeAccessError);
		assert.equal(h.reads.length, 0);
	}
});

it("rejects epoch changes during provider read or after the sealed snapshot was produced", async () => {
	for (const phase of ["onRead", "afterSeal"] as const) {
		const h = setup();
		const source = await h.publish();
		h[phase] = () => h.bump();
		await assert.rejects(h.service.recordFact(alice, fact(source)), KnowledgeAccessError);
		assert.equal(h.read().facts.length, 0);
	}
});

it("root and Slack service credentials must identify the same current workspace/account/app/scopes", async () => {
	for (const patch of [
		{ connectionId: "different" },
		{ userId: "UB" },
		{ appId: "AB" },
		{ workspaceId: "WB" },
		{ scopes: [] },
	]) {
		const h = setup();
		const source = await h.publish();
		h.serviceCredential = { ...credential(), ...patch };
		await assert.rejects(h.service.recordFact(alice, fact(source)), KnowledgeAccessError);
		assert.equal(h.reads.length, 0);
	}
});

it("account replacement, disconnect and service identity changes during I/O fence results without relying on epoch alone", async () => {
	for (const mutate of [
		(h: ReturnType<typeof setup>) => {
			h.credential = undefined;
		},
		(h: ReturnType<typeof setup>) => {
			h.credential = { ...credential(), connectionId: "new-account" };
		},
		(h: ReturnType<typeof setup>) => {
			h.serviceCredential = { ...credential(), userId: "UB" };
		},
	]) {
		const h = setup();
		const source = await h.publish();
		h.onRead = () => mutate(h);
		await assert.rejects(h.service.recordFact(alice, fact(source)), KnowledgeAccessError);
	}
});

it("rejects source sequence/revision changes during source I/O without an epoch bump", async () => {
	for (const patch of [
		{ sequence: 2 },
		{ sequence: 2, revision: "1700000001.000001", citation: null },
	]) {
		const h = setup();
		const source = await h.publish();
		h.onRead = async () => {
			await h.store.transaction("WA", (tx) => tx.putSource({ ...source, ...patch }));
		};
		await assert.rejects(h.service.recordFact(alice, fact(source)), KnowledgeAccessError);
		assert.equal(h.read().facts.length, 0);
	}
});

it("synchronous final isCurrent checks source heads changed after all authorization I/O", async () => {
	const h = setup();
	const source = await h.publish();
	h.afterSeal = async () => {
		await h.store.transaction("WA", (tx) => tx.putSource({ ...source, sequence: 2 }));
	};
	await assert.rejects(h.service.recordFact(alice, fact(source)), KnowledgeAccessError);
	assert.equal(h.read().facts.length, 0);
});

it("source or root epoch mutation inside the final transaction rolls back the fact", async () => {
	for (const updateSource of [false, true]) {
		const h = setup();
		const source = await h.publish();
		h.duringInsert((tx) => {
			if (updateSource) tx.putSource({ ...source, sequence: 2 });
			else h.bump();
		});
		await assert.rejects(h.service.recordFact(alice, fact(source)), KnowledgeAccessError);
		assert.equal(h.read().facts.length, 0);
		assert.equal(h.read().sources[0]?.sequence, 1);
	}
});

it("checks exact source workspace/conversation/message/revision/thread/text/author and visibility", async () => {
	const original = chat();
	const variations = [
		{
			...original,
			citation: {
				...original.citation,
				source: { ...original.citation.source, workspaceId: "WB" },
				audience: { ...original.citation.audience, workspaceId: "WB" },
			},
		},
		{
			...original,
			citation: {
				...original.citation,
				source: { ...original.citation.source, conversationId: "C2" },
				audience: { ...original.citation.audience, conversationId: "C2" },
			},
		},
		{
			...original,
			citation: {
				...original.citation,
				source: { ...original.citation.source, messageId: "1700000002.000001" },
			},
		},
		{
			...original,
			citation: {
				...original.citation,
				source: { ...original.citation.source, revisionId: "1700000002.000001" },
			},
		},
		{
			...original,
			citation: {
				...original.citation,
				source: { ...original.citation.source, threadId: "1699999999.000001" },
			},
		},
		{ ...original, text: "Decision: ship red." },
		{ ...original, authorId: "UB" },
		{
			...original,
			citation: {
				...original.citation,
				audience: { ...original.citation.audience, visibility: "private_channel" as const },
			},
		},
		{ ...original, text: "", deletedAt: now },
		{ ...original, truncated: true },
	];
	for (const response of variations) {
		const h = setup();
		const source = await h.publish();
		h.options.client.sourceMessage = async () => response;
		await assert.rejects(h.service.recordFact(alice, fact(source)), KnowledgeAccessError);
		assert.equal(h.read().facts.length, 0);
	}
});

it("fresh observedAt and membership revision may change while current exact source remains readable", async () => {
	const h = setup();
	const source = await h.publish();
	const fresh = chat();
	fresh.citation.audience.observedAt = "2026-10-31T00:01:00.000Z";
	fresh.citation.audience.membershipRevision = "fresh-complete-acl";
	h.setLive(fresh);
	await h.service.recordFact(alice, fact(source));
	assert.equal((await h.service.searchExact(alice, query)).length, 1);
});

it("unknown, malformed and cross-workspace source IDs never select caller-supplied network locations", async () => {
	const h = setup();
	const source = await h.publish();
	await assert.rejects(
		h.service.recordFact(
			alice,
			fact(source, { sources: [{ sourceId: "https://attacker.invalid/private", revision: "r1" }] })
		),
		KnowledgeAccessError
	);
	await assert.rejects(
		h.service.recordFact({ ...alice, workspaceId: "WB" }, fact(source)),
		KnowledgeAccessError
	);
	await assert.rejects(
		h.service.recordFact(alice, {
			...fact(source),
			sources: [{ ...fact(source).sources[0], citation: chat().citation }],
		})
	);
	assert.equal(h.reads.length, 0);
});

it("foreign or mismatched persisted citations are rejected before a provider call", async () => {
	for (const patch of [{ workspaceId: "WB" }, { sourceId: "wrong-id" }, { containerId: "C2" }]) {
		const h = setup();
		const source = await h.publish();
		const transaction = h.store.transaction.bind(h.store);
		h.store.transaction = (workspaceId, run) =>
			transaction(workspaceId, (tx) =>
				run({
					...tx,
					getSource(id) {
						const source = tx.getSource(id);
						return source ? { ...source, ...patch } : null;
					},
				})
			);
		await assert.rejects(h.service.recordFact(alice, fact(source)), KnowledgeAccessError);
		assert.equal(h.reads.length, 0);
	}
});

it("source errors, rate limits, missing credential and uncertain membership never reuse prior grants", async () => {
	for (const error of [
		new SlackError("rate-limited", 30),
		new SlackError("capacity"),
		new SlackError("access-denied"),
		new Error("Raw provider text controlled-secret-never-logged"),
	]) {
		const h = setup();
		const source = await h.publish();
		await h.service.recordFact(alice, fact(source));
		h.providerError = error;
		await assert.rejects(h.service.searchExact(alice, query), {
			message: "Knowledge access denied",
		});
		const result = await h.service.admitDirectMessage(alice, {
			requestId: "failed",
			recipientAgentId: "bob-agent",
			text: "Private rejected attempt",
			sources: fact(source).sources,
			parentFactIds: [],
		});
		assert.equal(result.status, "rejected");
		assert.ok(!JSON.stringify(h.read().audits).includes("Private rejected attempt"));
		assert.ok(!JSON.stringify(h.read().audits).includes("controlled-secret"));
	}
	const h = setup();
	const source = await h.publish();
	h.credential = undefined;
	await assert.rejects(h.service.recordFact(alice, fact(source)), KnowledgeAccessError);
	assert.equal(h.reads.length, 0);
});

it("deleted and revoked persisted source heads grant nobody and require no stale source read", async () => {
	for (const state of ["deleted", "revoked"] as const) {
		const h = setup();
		const source = await h.publish();
		await h.service.recordFact(alice, fact(source));
		await h.store.transaction("WA", (tx) =>
			tx.putSource({ ...source, sequence: 2, state, text: null })
		);
		const previousCalls = h.reads.length;
		assert.deepEqual(await h.service.searchExact(alice, query), []);
		assert.equal(h.reads.length, previousCalls);
	}
});

it("local private notes require the trusted current owner without fabricating a Slack citation or credential", async () => {
	const h = setup();
	h.credential = undefined;
	const source: KnowledgeSource = {
		workspaceId: "WA",
		sourceId: "local-note",
		revision: "r1",
		sequence: 1,
		kind: "private-note",
		containerId: "local-owner",
		authorUserId: "UA",
		ownerUserId: "UA",
		audience: { kind: "users", userIds: ["UA", "UB"] },
		observedAt: now,
		state: "active",
		text: "Decision: ship blue.",
		citation: null,
	};
	await h.store.transaction("WA", (tx) => tx.putSource(source));
	await h.service.recordFact(
		alice,
		fact(source, { scope: { kind: "private", ownerUserId: "UA" } })
	);
	assert.equal(
		(
			await h.service.searchExact(alice, {
				...query,
				scope: { kind: "private", ownerUserId: "UA" },
			})
		).length,
		1
	);
	await assert.rejects(
		h.service.recordFact(
			bob,
			fact(source, { id: "not-owner", scope: { kind: "private", ownerUserId: "UB" } })
		),
		KnowledgeAccessError
	);
	assert.equal(h.reads.length, 0);
	h.members.delete("UA");
	await assert.rejects(
		h.service.searchExact(alice, { ...query, scope: { kind: "private", ownerUserId: "UA" } }),
		KnowledgeAccessError
	);
});

it("directory unavailability fails closed with a fixed public error", async () => {
	const h = setup();
	const source = await h.publish();
	h.directoryError = true;
	await assert.rejects(h.service.recordFact(alice, fact(source)), {
		message: "Knowledge access denied",
	});
	assert.equal(h.reads.length, 0);
});

it("checks current service identity after the final asynchronous store fence read", async () => {
	const h = setup();
	const source = await h.publish();
	h.afterSeal = () => {
		h.credential = { ...credential(), connectionId: "replacement-after-store" };
	};
	await assert.rejects(h.service.recordFact(alice, fact(source)), KnowledgeAccessError);
	assert.equal(h.read().facts.length, 0);
});

it("new service instances rebuild current authority from durable source/fact rows", async () => {
	const h = setup();
	const source = await h.publish();
	await h.service.recordFact(alice, fact(source));
	const restored = createKnowledgeService(h.options);
	assert.equal((await restored.searchExact(bob, query)).length, 1);
	h.members.delete("UB");
	await assert.rejects(restored.searchExact(bob, query), KnowledgeAccessError);
	assert.equal(h.read().facts.length, 1);
});

it("separate current source audiences remain an intersection, never a union", async () => {
	const h = setup();
	const first = await h.publish();
	const secondMessage = chat();
	secondMessage.citation.source.conversationId = "C2";
	secondMessage.citation.audience.conversationId = "C2";
	secondMessage.citation.audience.readerIds = ["UA"];
	const second = await h.publish(secondMessage);
	const sources = [...fact(first).sources, ...fact(second).sources];
	await h.service.recordFact(alice, fact(first, { sources }));
	assert.deepEqual(await h.service.searchExact(bob, query), []);
	assert.equal((await h.service.searchExact(alice, query)).length, 1);
	assert.ok(h.reads.some((source) => source.conversationId === "C1"));
	assert.ok(h.reads.some((source) => source.conversationId === "C2"));
	assert.equal(
		(
			await h.service.admitDirectMessage(alice, {
				requestId: "both-sources",
				recipientAgentId: "bob-agent",
				text: "Decision: ship blue.",
				sources,
				parentFactIds: [],
			})
		).status,
		"rejected"
	);
});
