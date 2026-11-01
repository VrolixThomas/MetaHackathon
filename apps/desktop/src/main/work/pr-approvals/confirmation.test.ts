import assert from "node:assert/strict";
import { it } from "node:test";
import type { ConversationTurnInput } from "../../../shared/contracts";
import { ApprovalConfirmation } from "./confirmation";
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
	const p = policy({ status: "draft", confirmedAt: null });
	const pending = gate.present(p, { ...turn, inputMode: "voice" }, new AbortController().signal);
	gate.presented({ sessionId: "s", id: p.id, revision: 1, digest: p.digest });
	await Promise.resolve();
	gate.acceptUserTurn(follow("confirm this delegation", "voice"));
	assert.throws(() => gate.take(follow("confirm this delegation", "voice"), p));
	speech.resolve();
	await pending;
	assert.ok(text.includes("automatic GitHub PR approval"));
	assert.ok(text.includes(p.pr.headSha));
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
