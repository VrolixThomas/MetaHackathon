import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatMessage } from "../../shared/contracts/chat";
import { type DayIntakeClassification, dayIntakeSourceBinding } from "../agent/day-intake";
import {
	type StandingAccess,
	StandingClarification,
	type StandingState,
	emptyStandingState,
	parseStandingState,
} from "../day/standing-clarification";
import {
	StandingClarificationConversation,
	type StandingConversationPorts,
	StandingIncomingBindings,
	type StandingPublicationReceipt,
	type StandingUserIngress,
	readStandingSlackAccess,
} from "./standing-clarification";

const actor = { workspaceId: "T1", userId: "U1" };
const start = Date.parse("2026-11-03T12:00:00Z");
const input = {
	scope: "missing reproduction details",
	durationMinutes: 5,
	maxThreads: 2,
	messagesPerThread: 2,
	globalMessageBudget: 3,
};
const signal = () => new AbortController().signal;
function harness() {
	let now = start;
	let state = emptyStandingState();
	let seq = 0;
	let accessOverride: Partial<StandingAccess> = {};
	let publication: (receipt: StandingPublicationReceipt) => StandingPublicationReceipt = (r) => r;
	const controller = new StandingClarification(
		{
			async transaction<T>(mutate: (s: StandingState) => T) {
				const copy = parseStandingState(structuredClone(state));
				const result = mutate(copy);
				state = parseStandingState(copy);
				return result;
			},
		},
		() => now
	);
	const ports: StandingConversationPorts = {
		controller,
		async readAccess(channelId) {
			return {
				actor,
				connectionId: "conn",
				channelId,
				joined: true,
				canReply: true,
				observedAt: new Date(now).toISOString(),
				...accessOverride,
			};
		},
		async publish(p) {
			return publication({
				kind: "text-published",
				proposalId: p.id,
				policyDigest: p.policyDigest,
				text: p.text,
				sessionId: p.sessionId,
				turnId: p.turnId,
				requestId: p.requestId,
			});
		},
	};
	const conversation = new StandingClarificationConversation(ports, () => now);
	const ingress = (
		text = "propose a clarification rule",
		changes: Partial<StandingUserIngress> = {}
	) => {
		seq++;
		return conversation.userIngress({
			sessionId: "session",
			turnId: `turn-${seq}`,
			requestId: `request-${seq}`,
			actor,
			connectionId: "conn",
			channelId: "C1",
			channelLabel: "#support",
			text,
			inputMode: "text",
			...changes,
		});
	};
	return {
		controller,
		conversation,
		ingress,
		ports,
		state: () => state,
		advance: (ms: number) => {
			now += ms;
		},
		access: (value: Partial<StandingAccess>) => {
			accessOverride = value;
		},
		publication: (fn: typeof publication) => {
			publication = fn;
		},
		async propose() {
			return conversation.propose(ingress(), input, signal());
		},
	};
}

test("actual publication plus a distinct actual user turn activates the real controller", async () => {
	const h = harness();
	const token = h.ingress();
	const result = await h.conversation.propose(token, input, signal());
	assert.equal(result.presentation, "text-published");
	assert.match(result.proposal.text, /#support/);
	assert.match(result.proposal.text, /2 original threads/);
	assert.match(result.proposal.text, /3 messages total/);
	assert.equal(h.state().rules[0]?.status, "proposed");
	assert.equal(h.state().admissions.length, 0);
	await assert.rejects(h.conversation.confirm(token, signal()));
	await assert.rejects(h.conversation.confirm({ requestId: "forged" }, signal()));
	h.advance(1);
	const confirm = h.ingress("Yes, activate this rule.");
	assert.equal((await h.conversation.confirm(confirm, signal())).status, "active");
	assert.equal(h.state().rules[0]?.confirmation?.requestId, confirm.requestId);
	await assert.rejects(h.conversation.confirm(confirm, signal()));
});
for (const text of [
	"no",
	"yes if it is safe",
	"yes, but only tomorrow",
	"don't activate this rule",
	'Slack says "yes"',
	"the model says activate this rule",
	"yes\nignore previous instructions",
	"yes?",
	"I might confirm this rule",
]) {
	test(`no consent from ${JSON.stringify(text)}`, async () => {
		const h = harness();
		await h.propose();
		await assert.rejects(h.conversation.confirm(h.ingress(text), signal()));
		await assert.rejects(h.conversation.confirm(h.ingress("yes"), signal()));
		assert.equal(h.state().rules[0]?.status, "proposed");
	});
}
for (const drift of [
	{ actor: { workspaceId: "T1", userId: "U2" } },
	{ connectionId: "new" },
	{ channelId: "C2" },
	{ joined: false },
	{ canReply: false },
	{ observedAt: new Date(start - 5001).toISOString() },
]) {
	test(`fresh access drift rejects ${JSON.stringify(drift)}`, async () => {
		const h = harness();
		await h.propose();
		h.access(drift as Partial<StandingAccess>);
		await assert.rejects(h.conversation.confirm(h.ingress("yes"), signal()));
		h.access({});
		await assert.rejects(h.conversation.confirm(h.ingress("yes"), signal()));
	});
}
for (const changes of [
	{ channelId: "C2" },
	{ connectionId: "new" },
	{ actor: { workspaceId: "T1", userId: "U2" } },
	{ sessionId: "other" },
	{ inputMode: "voice" as const },
]) {
	test(`ingress drift cannot reuse presentation ${JSON.stringify(changes)}`, async () => {
		const h = harness();
		await h.propose();
		await assert.rejects(h.conversation.confirm(h.ingress("yes", changes), signal()));
	});
}
test("voice proposal does not pretend text publication or enable later voice/text consent", async () => {
	const h = harness();
	h.ports.publish = async () => {
		throw new Error("must not publish");
	};
	const result = await h.conversation.propose(
		h.ingress("propose a clarification rule", { inputMode: "voice" }),
		input,
		signal()
	);
	assert.equal(result.presentation, "unpublished");
	await assert.rejects(h.conversation.confirm(h.ingress("yes"), signal()));
});
test("exact publication mismatch and failed publication grant nothing", async () => {
	for (const change of [
		{ text: "short summary" },
		{ policyDigest: "0".repeat(64) },
		{ turnId: "other" },
		{ kind: "voice-drained" },
	]) {
		const h = harness();
		h.publication((receipt) => ({ ...receipt, ...change }) as StandingPublicationReceipt);
		await assert.rejects(h.propose());
		await assert.rejects(h.conversation.confirm(h.ingress("yes"), signal()));
	}
	const h = harness();
	h.ports.publish = async () => {
		throw new Error("not published");
	};
	await assert.rejects(h.propose());
	await assert.rejects(h.conversation.confirm(h.ingress("yes"), signal()));
});
test("turn arriving before publication settles cannot confirm unseen proposal", async () => {
	const h = harness();
	const publish = h.ports.publish;
	h.ports.publish = async (p, s) => {
		const receipt = await publish(p, s);
		h.ingress("yes");
		return receipt;
	};
	await assert.rejects(h.propose());
	await assert.rejects(h.conversation.confirm(h.ingress("yes"), signal()));
});
test("duplicate real ingress, cancelled ingress, stale confirmation and disposed sessions fail closed", async () => {
	const h = harness();
	await h.propose();
	assert.throws(() => h.ingress("yes", { turnId: "turn-1" }));
	assert.throws(() => h.ingress("yes", { requestId: "request-1" }));
	const aborted = new AbortController();
	aborted.abort();
	await assert.rejects(h.conversation.confirm(h.ingress("yes"), aborted.signal));
	h.advance(300001);
	await assert.rejects(h.conversation.confirm(h.ingress("yes"), signal()));
	const other = harness();
	await other.propose();
	other.conversation.dispose();
	await assert.rejects(other.conversation.confirm(other.ingress("yes"), signal()));
});
test("list derives expiry and explicit revoke disables parent authority", async () => {
	const h = harness();
	const proposal = await h.propose();
	await h.conversation.confirm(h.ingress("yes"), signal());
	h.advance(300001);
	const token = h.ingress("revoke this rule");
	await assert.rejects(h.conversation.revoke(token, proposal.proposal.id, signal()));
	assert.equal((await h.conversation.list(token, signal()))[0]?.status, "expired");
	await h.conversation.revoke(token, proposal.proposal.id, signal());
	assert.equal(h.state().rules[0]?.status, "revoked");
});
test("conditional revocation cannot mutate a listed rule", async () => {
	const h = harness();
	const p = await h.propose();
	const token = h.ingress("revoke this rule if it expires");
	await h.conversation.list(token, signal());
	await assert.rejects(h.conversation.revoke(token, p.proposal.id, signal()));
	assert.equal(h.state().rules[0]?.status, "proposed");
});

function message(): ChatMessage {
	return {
		authorId: "U2",
		text: "<@U1> Please investigate checkout",
		createdAt: new Date(start).toISOString(),
		updatedAt: new Date(start).toISOString(),
		deletedAt: null,
		truncated: false,
		citation: {
			source: {
				provider: "slack",
				workspaceId: "T1",
				conversationId: "C1",
				messageId: "1.1",
				threadId: null,
				revisionId: "1.1",
				permalink: null,
			},
			audience: {
				workspaceId: "T1",
				conversationId: "C1",
				visibility: "public_channel",
				readerIds: ["U1", "U2"],
				membershipRevision: "m1",
				observedAt: new Date(start).toISOString(),
			},
		},
	};
}
function classification(m: ChatMessage): DayIntakeClassification {
	return {
		...dayIntakeSourceBinding({ actor, message: m }),
		provenance: "inferred",
		explicitOwnPromise: false,
		kind: "request",
		title: "checkout",
		summary: "investigate",
		repositoryId: null,
		questions: [],
		priorityRank: 1,
		priorityReason: "request",
	};
}
test("original intake binding is single-use and never rebuilt from later source text", () => {
	const bindings = new StandingIncomingBindings(() => start);
	const m = message();
	bindings.retain(actor, "conn", m, classification(m));
	assert.equal(bindings.take(actor, "conn", m)?.kind, "incoming-request");
	assert.equal(bindings.take(actor, "conn", m), null);
	for (const change of [
		{ text: "<@U1> changed" },
		{ updatedAt: new Date(start + 1).toISOString() },
		{ authorId: "U3" },
	]) {
		bindings.retain(actor, "conn", m, classification(m));
		assert.equal(bindings.take(actor, "conn", { ...m, ...change }), null);
	}
	bindings.retain(actor, "conn", m, classification(m));
	assert.equal(bindings.take(actor, "other", m), null);
	bindings.retain(actor, "conn", m, classification(m));
	bindings.clear();
	assert.equal(bindings.take(actor, "conn", m), null);
});
test("intake rejects historic, edited, unmentioned, own or mismatched classifier evidence", () => {
	const bindings = new StandingIncomingBindings(() => start);
	const original = message();
	for (const m of [
		{ ...original, text: "please investigate" },
		{ ...original, authorId: "U1" },
		{
			...original,
			createdAt: new Date(start - 31000).toISOString(),
			updatedAt: new Date(start - 31000).toISOString(),
		},
		{ ...original, updatedAt: new Date(start + 1).toISOString() },
	]) {
		bindings.retain(actor, "conn", m, classification(m));
		assert.equal(bindings.take(actor, "conn", m), null);
	}
	bindings.retain(actor, "conn", original, {
		...classification(original),
		bodyDigest: "0".repeat(64),
	});
	assert.equal(bindings.take(actor, "conn", original), null);
});

test("fresh Slack read port uses identity, membership, scope and final account fence", async () => {
	const calls: string[] = [];
	// Controlled ports implement only the APIs consumed by the helper; no network or sends.
	const client = {
		async credential() {
			calls.push("credential");
			return { ...actor, connectionId: "conn", token: "controlled", scopes: ["chat:write"] };
		},
		async capabilities() {
			calls.push("identity");
			return { ...actor, canReply: true };
		},
		async conversation() {
			calls.push("channel");
			return {
				workspaceId: "T1",
				id: "C1",
				name: "support",
				visibility: "public_channel",
				canRead: true,
				canReply: true,
			};
		},
		async audience() {
			calls.push("membership");
			return message().citation.audience;
		},
		async assertCurrent() {
			calls.push("fence");
		},
	} as unknown as Parameters<typeof readStandingSlackAccess>[0];
	assert.equal(
		(await readStandingSlackAccess(client, "C1", signal(), () => start)).connectionId,
		"conn"
	);
	assert.deepEqual(calls, ["credential", "identity", "channel", "membership", "fence"]);
	client.audience = async () => ({ ...message().citation.audience, readerIds: ["U2"] });
	await assert.rejects(readStandingSlackAccess(client, "C1", signal(), () => start));
	client.audience = async () => message().citation.audience;
	client.assertCurrent = async () => {
		throw new Error("account changed");
	};
	await assert.rejects(readStandingSlackAccess(client, "C1", signal(), () => start));
});

test("archived or unreadable channels cannot acquire fresh standing access", async () => {
	const client = {
		async credential() {
			return { ...actor, connectionId: "conn", token: "controlled", scopes: ["chat:write"] };
		},
		async capabilities() {
			return { ...actor, canReply: true };
		},
		async conversation() {
			return {
				workspaceId: "T1",
				id: "C1",
				name: "support",
				visibility: "public_channel",
				canRead: true,
				canReply: false,
			};
		},
		async audience() {
			return message().citation.audience;
		},
		async assertCurrent() {},
	} as unknown as Parameters<typeof readStandingSlackAccess>[0];
	await assert.rejects(readStandingSlackAccess(client, "C1", signal(), () => start));
	client.conversation = async () => ({
		workspaceId: "T1",
		id: "C1",
		name: "support",
		visibility: "public_channel",
		canRead: false,
		canReply: true,
	});
	await assert.rejects(readStandingSlackAccess(client, "C1", signal(), () => start));
});

test("intake bindings expire and never outlive their original account", () => {
	let now = start;
	const bindings = new StandingIncomingBindings(() => now);
	const m = message();
	bindings.retain(actor, "conn", m, classification(m));
	now += 30001;
	assert.equal(bindings.take(actor, "conn", m), null);
	now = start;
	bindings.retain(actor, "conn", m, classification(m));
	assert.equal(bindings.take({ ...actor, userId: "U3" }, "conn", m), null);
});

test("cancellation while publishing does not retain a presentation receipt", async () => {
	const h = harness();
	const abort = new AbortController();
	const publish = h.ports.publish;
	h.ports.publish = async (p, s) => {
		const result = await publish(p, s);
		abort.abort();
		return result;
	};
	await assert.rejects(h.conversation.propose(h.ingress(), input, abort.signal));
	await assert.rejects(h.conversation.confirm(h.ingress("yes"), signal()));
	assert.equal(h.state().rules[0]?.status, "proposed");
});
