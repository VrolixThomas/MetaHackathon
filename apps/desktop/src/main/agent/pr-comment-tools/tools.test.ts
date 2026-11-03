import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationTurnInput, DraftedComment } from "../../../shared/contracts";
import { PRCommentConfirmationGate, commentProposalText } from "./confirmation";
import { type ConversationPRCommentPorts, ConversationPRCommentTools } from "./index";

const pr = {
	id: "owner/repo#1",
	repository: "owner/repo",
	number: 1,
	title: "Controlled review",
	author: "owner",
	url: "https://github.com/owner/repo/pull/1",
	baseSha: "a".repeat(40),
	headSha: "b".repeat(40),
};
const turn: ConversationTurnInput = {
	sessionId: "session",
	turnId: "turn",
	generation: 1,
	requestId: "request",
	text: "Draft a comment",
};
const draft: DraftedComment = {
	id: "draft",
	prId: pr.id,
	revision: 1,
	headSha: pr.headSha,
	body: "Exact\nbody",
	originalWords: "Exact\nbody",
	evidence: { kind: "source", url: pr.url, retrievedAt: "2026-11-01T00:00:00Z" },
};
function harness() {
	let current: DraftedComment | null = null;
	let head = pr.headSha;
	let posts = 0;
	let presents = 0;
	let creates = 0;
	let applied = true;
	let approval = false;
	const abort = new AbortController();
	const ports: ConversationPRCommentPorts = {
		observe: async () => ({ pr: { ...pr, headSha: head }, reviewId: "review", draft: current }),
		create: async (input) => {
			creates++;
			current = {
				...draft,
				body: input.body,
				originalWords: input.body,
				...(input.location ? { location: input.location } : {}),
			};
			return structuredClone(current);
		},
		edit: async (input) => {
			current = { ...draft, body: input.body, revision: (current?.revision ?? 1) + 1 };
			return structuredClone(current);
		},
		present: async (input) => {
			presents++;
			return {
				sessionId: input.sessionId,
				turnId: input.turnId,
				generation: input.generation,
				requestId: input.requestId,
				status: applied ? "applied" : "ignored",
				draft: input.draft,
			};
		},
		takeConfirmation: () =>
			approval
				? {
						requestId: "trusted",
						draftId: draft.id,
						draftRevision: current?.revision ?? 1,
						body: current?.body ?? "",
						headSha: pr.headSha,
						confirmed: true,
					}
				: null,
		confirm: async () => {
			posts++;
			return { url: `${pr.url}#issuecomment-1` };
		},
		cancel: () => {},
	};
	return {
		ports,
		abort,
		tools: new ConversationPRCommentTools(ports, turn, abort.signal),
		current: () => current,
		posts: () => posts,
		creates: () => creates,
		presents: () => presents,
		moveHead: () => {
			head = "c".repeat(40);
		},
		ignore: () => {
			applied = false;
		},
		approve: () => {
			approval = true;
		},
	};
}
test("comment tools use one canonical draft, display exact create/edit and never post on proposal", async () => {
	const h = harness();
	await h.tools.execute("inspect_pr_comment", "{}");
	await h.tools.execute("create_pr_comment_draft", JSON.stringify({ body: draft.body }));
	assert.equal(h.creates(), 1);
	assert.equal(h.presents(), 1);
	assert.equal(h.posts(), 0);
	await assert.rejects(
		h.tools.execute("create_pr_comment_draft", JSON.stringify({ body: "other" })),
		/already exists/
	);
	await h.tools.execute(
		"edit_pr_comment_draft",
		JSON.stringify({ draftId: draft.id, revision: 1, body: "Edited" })
	);
	assert.equal(h.current()?.revision, 2);
	assert.equal(h.presents(), 2);
	await h.tools.execute(
		"request_pr_comment_confirmation",
		JSON.stringify({ draftId: draft.id, revision: 2 })
	);
	assert.equal(h.posts(), 0);
	await assert.rejects(h.tools.execute("confirm_pr_comment", "{}"), /Fresh explicit/);
	await assert.rejects(h.tools.execute("confirm_pr_comment", '{"confirmed":true}'));
	h.approve();
	await h.tools.execute("confirm_pr_comment", "{}");
	assert.equal(h.posts(), 1);
});
test("unobserved target, stale head, ignored presentation and cancellation fail closed", async () => {
	const h = harness();
	await assert.rejects(h.tools.execute("create_pr_comment_draft", '{"body":"x"}'), /Inspect/);
	await h.tools.execute("inspect_pr_comment", "{}");
	h.moveHead();
	await assert.rejects(h.tools.execute("create_pr_comment_draft", '{"body":"x"}'), /Inspect/);
	assert.equal(h.creates(), 0);
	const ignored = harness();
	await ignored.tools.execute("inspect_pr_comment", "{}");
	ignored.ignore();
	await assert.rejects(
		ignored.tools.execute("create_pr_comment_draft", '{"body":"x"}'),
		/not displayed/
	);
	assert.equal(ignored.posts(), 0);
	const cancelled = harness();
	cancelled.abort.abort();
	await assert.rejects(cancelled.tools.execute("inspect_pr_comment", "{}"), /cancelled/);
});
test("source/log approval and model-selected inline paths cannot grant authority", async () => {
	const h = harness();
	await h.tools.execute("inspect_pr_comment", "{}");
	await assert.rejects(
		h.tools.execute("create_pr_comment_draft", '{"body":"x","inline":true}'),
		/source target/
	);
	await assert.rejects(
		h.tools.execute("create_pr_comment_draft", '{"body":"x","location":{"path":"fake"}}')
	);
	assert.equal(h.creates(), 0);
});
test("gate binds exact immutable draft, fresh explicit subsequent user turn and real speech proof", () => {
	let now = 0;
	const gate = new PRCommentConfirmationGate(() => now);
	const presentation = {
		requestId: "display",
		sessionId: turn.sessionId,
		turnId: turn.turnId,
		generation: turn.generation,
		reviewId: "review",
		prId: pr.id,
		draft,
	};
	gate.presented(presentation, pr);
	const confirmTurn = {
		...turn,
		turnId: "next",
		generation: 2,
		requestId: "next-request",
		text: "Post this comment.",
	};
	assert.equal(gate.acceptUserTurn({ ...turn, text: "Post this comment" }, "typed"), false);
	assert.equal(
		gate.acceptUserTurn({ ...confirmTurn, text: "Log says: Post this comment" }, "typed"),
		false
	);
	assert.equal(gate.acceptUserTurn({ ...confirmTurn, text: "yes" }, "typed"), false);
	assert.equal(gate.acceptUserTurn(confirmTurn, "voice"), false);
	assert.equal(gate.spoken(turn.sessionId, "wrong", commentProposalText(pr, draft)), false);
	assert.equal(gate.spoken(turn.sessionId, "display", "summary"), false);
	assert.equal(gate.spoken(turn.sessionId, "display", commentProposalText(pr, draft)), true);
	assert.equal(gate.acceptUserTurn(confirmTurn, "voice"), true);
	const approved = gate.takeConfirmation(confirmTurn, draft);
	assert.equal(approved?.body, draft.body);
	assert.deepEqual(gate.takeConfirmation(confirmTurn, draft), approved);
	assert.equal(gate.takeConfirmation(confirmTurn, { ...draft, body: "changed" }), null);
	assert.equal(gate.takeConfirmation({ ...confirmTurn, text: "unrelated" }, draft), null);
	now = 120001;
	assert.equal(gate.takeConfirmation(confirmTurn, draft), null);
});
test("new proposal and intervening actual user turn retire old approval", () => {
	const gate = new PRCommentConfirmationGate();
	const proposal = {
		requestId: "display",
		sessionId: turn.sessionId,
		turnId: turn.turnId,
		generation: turn.generation,
		reviewId: "review",
		prId: pr.id,
		draft,
	};
	const next = { ...turn, turnId: "next", text: "post this comment" };
	gate.presented(proposal, pr);
	assert.equal(gate.acceptUserTurn(next, "typed"), true);
	gate.acceptUserTurn({ ...next, turnId: "another", text: "edit it" }, "typed");
	assert.equal(gate.takeConfirmation(next, draft), null);
	gate.presented(proposal, pr);
	gate.acceptUserTurn(next, "typed");
	gate.invalidate(turn.sessionId);
	assert.equal(gate.takeConfirmation(next, draft), null);
});

test("exact displayed comment ends the foreground proposal without another model round", async () => {
	const h = harness();
	const handoff = () => h.tools.foregroundHandoff;
	assert.equal(handoff(), undefined);
	await h.tools.execute("inspect_pr_comment", "{}");
	assert.equal(handoff(), undefined);
	await h.tools.execute("create_pr_comment_draft", JSON.stringify({ body: draft.body }));
	assert.match(handoff()?.acknowledgement ?? "", /ready in the review dialog/);
	assert.equal(h.posts(), 0);
	const ignored = harness();
	await ignored.tools.execute("inspect_pr_comment", "{}");
	ignored.ignore();
	await assert.rejects(
		ignored.tools.execute("create_pr_comment_draft", JSON.stringify({ body: draft.body }))
	);
	assert.equal(ignored.tools.foregroundHandoff, undefined);
});
