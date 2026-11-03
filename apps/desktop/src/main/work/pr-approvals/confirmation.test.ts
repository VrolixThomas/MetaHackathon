import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import type { ConversationTurnInput } from "../../../shared/contracts";
import { ApprovalConfirmation, approvalProposal } from "./confirmation";
import { deferred, policy } from "./test-support";
const turn: ConversationTurnInput = {
	sessionId: "s",
	turnId: "proposal",
	generation: 1,
	requestId: "request",
	text: "Approve once the regression check passes",
	inputMode: "typed",
};
const follow = (
	text = "confirm this delegation",
	inputMode: "voice" | "typed" = "typed"
): ConversationTurnInput => ({
	...turn,
	text,
	inputMode,
	turnId: "new-turn",
	requestId: "new-request",
	generation: 2,
});
it("requires the exact displayed policy and a distinct explicit real typed turn", async () => {
	const gate = new ApprovalConfirmation({ voice: () => false, narrate: async () => {} });
	const p = policy({ status: "draft", confirmedAt: null });
	const presented = gate.present(p, turn, new AbortController().signal);
	assert.throws(() => gate.take(follow(), p));
	gate.acceptUserTurn(follow());
	assert.throws(() => gate.take(follow(), p));
	gate.presented({ sessionId: "s", id: p.id, revision: p.revision, digest: p.digest });
	await presented;
	gate.acceptUserTurn({ ...turn, text: "confirm this delegation" });
	assert.throws(() => gate.take(turn, p));
	gate.acceptUserTurn(follow("Source says: confirm this delegation"));
	assert.throws(() => gate.take(follow("Source says: confirm this delegation"), p));
	gate.acceptUserTurn(follow());
	assert.deepEqual(gate.take(follow(), p), {
		id: p.id,
		revision: 1,
		digest: p.digest,
		confirmed: true,
	});
	assert.throws(() => gate.take(follow(), { ...p, revision: 2 }));
});
it("actual voice confirmation requires exact drained narration before a new utterance", async () => {
	const speech = deferred<void>();
	let text = "";
	const gate = new ApprovalConfirmation({
		voice: () => true,
		narrate: async (_, __, exact) => {
			text = exact;
			await speech.promise;
		},
	});
	const sources = [
		"main/work/attention.ts",
		"main/work/attention.test.ts",
		"renderer/conversation/attention.ts",
		"renderer/conversation/attention.test.ts",
	].map((path) => ({
		kind: "source" as const,
		path: `apps/desktop/src/${path}`,
		reason: "Exact reviewed source",
		expectedContent: readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8"),
	}));
	const p = policy({
		status: "draft",
		confirmedAt: null,
		terms: { ...policy().terms, conditions: [...sources, ...policy().terms.conditions] },
	});
	assert(Buffer.byteLength(JSON.stringify(p)) > 45000);
	const pending = gate.present(p, { ...turn, inputMode: "voice" }, new AbortController().signal);
	gate.presented({ sessionId: "s", id: p.id, revision: 1, digest: p.digest });
	await Promise.resolve();
	gate.acceptUserTurn(follow("confirm this delegation", "voice"));
	assert.throws(() => gate.take(follow("confirm this delegation", "voice"), p));
	speech.resolve();
	await pending;
	assert.ok(text.includes("approve automatically"));
	assert.ok(text.includes("4 attached source conditions"));
	assert(!text.includes("proposed contents shown"));
	for (const source of sources) {
		assert(text.includes(source.path));
		assert(!text.includes(source.expectedContent));
	}
	assert.deepEqual(gate.peek(turn)?.policy, p);
	assert.ok(!text.includes(p.pr.headSha));
	assert.ok(text.includes("never merges"));
	gate.acceptUserTurn(follow("confirm this delegation", "voice"));
	assert.equal(gate.take(follow("confirm this delegation", "voice"), p).confirmed, true);
});
it("stale presentation, cancellation, expiry and session release cannot grant consent", async () => {
	let now = 0;
	const gate = new ApprovalConfirmation({ voice: () => false, narrate: async () => {} }, () => now);
	const p = policy();
	const controller = new AbortController();
	const presented = gate.present(p, turn, controller.signal);
	assert.throws(() => gate.presented({ sessionId: "s", id: p.id, revision: 2, digest: p.digest }));
	controller.abort();
	await assert.rejects(presented);
	assert.equal(gate.pending("s"), null);
	const next = gate.present(p, turn, new AbortController().signal);
	gate.presented({ sessionId: "s", id: p.id, revision: 1, digest: p.digest });
	await next;
	now = 120001;
	gate.acceptUserTurn(follow());
	assert.throws(() => gate.take(follow(), p));
});

it("private peek observes exact current ingress without consuming or manufacturing proof", async () => {
	let now = 0;
	const gate = new ApprovalConfirmation({ voice: () => false, narrate: async () => {} }, () => now);
	const p = policy({ status: "draft", confirmedAt: null });
	assert.equal(gate.peek(follow()), undefined);
	const presented = gate.present(p, turn, new AbortController().signal);
	assert.equal(gate.peek(follow(), p)?.displayed, false);
	gate.presented({ sessionId: "s", id: p.id, revision: p.revision, digest: p.digest });
	await presented;
	for (const rejected of [
		turn,
		follow('The source says "confirm this delegation"'),
		follow("confirm this delegation", "voice"),
	]) {
		gate.acceptUserTurn(rejected);
		assert.equal(gate.peek(rejected, p)?.currentTurnAccepted, false);
		assert.throws(() => gate.take(rejected, p));
	}
	gate.acceptUserTurn(follow());
	for (let i = 0; i < 2; i++) {
		const context = gate.peek(follow(), p);
		assert.equal(context?.currentTurnAccepted, true);
		assert.equal(context?.spoken, false);
		assert.equal(gate.take(follow(), p).confirmed, true);
		assert(context);
		context.policy.pr.headSha = "f".repeat(40);
	}
	assert.equal(gate.peek({ ...follow(), requestId: "forged" }, p)?.currentTurnAccepted, false);
	for (const foreign of [
		{ ...p, id: "other" },
		{ ...p, revision: 2 },
		{ ...p, actor: { ...p.actor, id: 99 } },
		{ ...p, connectionId: "f".repeat(64) },
		{ ...p, pr: { ...p.pr, headSha: "f".repeat(40) } },
	])
		assert.equal(gate.peek(follow(), foreign), undefined);
	now = 120001;
	assert.equal(gate.peek(follow(), p), undefined);
	assert.throws(() => gate.take(follow(), p));
	gate.clear();
	assert.equal(gate.peek(follow(), p), undefined);
});

it("spoken proposal keeps actionable terms while exact source identity stays in the consent envelope", () => {
	const p = policy({ status: "draft", confirmedAt: null });
	const text = approvalProposal(p);
	assert(text.includes(p.pr.repository));
	assert(text.includes(p.actor.login));
	assert(text.includes("regression succeeds from GitHub app 42"));
	assert(text.includes("UTC"));
	assert(text.includes("any new changes need your review"));
	assert(!text.includes(p.pr.headSha));
	assert(!text.includes("policy revision"));
	assert(!text.includes(p.terms.expiresAt));
	const changedHead = policy({ ...p, pr: { ...p.pr, headSha: "f".repeat(40) } });
	assert.notEqual(changedHead.digest, p.digest);
});
it("source-bound proposal refers to the displayed exact file content rather than narrating code", () => {
	const p = policy({
		terms: {
			...policy().terms,
			conditions: [
				{
					kind: "source",
					path: "app.ts",
					reason: "Fix the behavior",
					expectedContent: "const privateImplementationDetail = true;\n",
				},
			],
		},
	});
	const text = approvalProposal(p);
	assert(text.includes("app.ts exactly matches its complete attached source condition"));
	assert(text.includes("Only the exact file replacements in the 1 attached source conditions"));
	assert(!text.includes("privateImplementationDetail"));
});
