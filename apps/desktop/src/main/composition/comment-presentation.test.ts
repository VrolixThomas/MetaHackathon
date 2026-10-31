import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type AgentAction,
	AgentActionSchema,
	type DraftedComment,
	type PRCommentPresentation,
} from "../../shared/contracts";
import { CommentPresentationCoordinator } from "./comment-presentation";

const pr = {
	id: "owner/repo#1",
	repository: "owner/repo",
	number: 1,
	title: "Controlled PR",
	author: "owner",
	url: "https://github.com/owner/repo/pull/1",
	baseSha: "a".repeat(40),
	headSha: "b".repeat(40),
};
const initial: DraftedComment = {
	id: "draft",
	prId: pr.id,
	revision: 1,
	headSha: pr.headSha,
	body: "Handle the empty state.",
	originalWords: "Handle the empty state.",
	evidence: { kind: "source", url: pr.url, retrievedAt: "2026-11-01T00:00:00Z" },
};
const presentation: PRCommentPresentation = {
	sessionId: "session",
	turnId: "proposal",
	generation: 1,
	requestId: "present",
	prId: pr.id,
	reviewId: "review",
	draft: initial,
};
async function waitFor(check: () => boolean) {
	for (let i = 0; i < 100; i++) {
		if (check()) return;
		await new Promise((r) => setTimeout(r, 1));
	}
	throw new Error("No actual effect");
}
function setup(voice = false, delivery: "spoken" | "displayed" = "spoken") {
	let current = initial;
	const actions: AgentAction[] = [];
	const posts: unknown[] = [];
	const broker = new CommentPresentationCoordinator({
		getDraft: async () => current,
		readPR: async () => pr,
		voice: () => voice,
		narrate: async () => delivery,
		publish: (action) => actions.push(AgentActionSchema.parse(action)),
		confirm: async (input) => {
			posts.push(input);
			return { url: `${pr.url}#issuecomment-1` };
		},
	});
	return {
		broker,
		actions,
		posts,
		change: () => {
			current = { ...initial, revision: 2, body: "Changed" };
		},
	};
}
test("canonical display receipt and distinct actual user turn gate one mirrored posting attempt", async () => {
	const { broker, actions, posts } = setup();
	const abort = new AbortController();
	const pending = broker.present(presentation, abort.signal);
	await waitFor(() => actions.length === 1);
	const receipt = {
		sessionId: "session",
		turnId: "proposal",
		generation: 1,
		requestId: "present",
		draft: initial,
		status: "applied" as const,
	};
	assert.deepEqual(await broker.applied({ ...receipt, generation: 99 }), { status: "stale" });
	assert.deepEqual(await broker.applied(receipt), { status: "accepted" });
	assert.equal((await pending).status, "applied");
	const turn = {
		sessionId: "session",
		turnId: "consent",
		generation: 2,
		requestId: "user-2",
		text: "post this comment",
	};
	assert.equal(broker.takeConfirmation(turn, initial), null);
	assert.equal(broker.confirmation.acceptUserTurn(turn, "typed"), true);
	const input = broker.takeConfirmation(turn, initial);
	assert.ok(input);
	await broker.confirm(input);
	assert.equal(posts.length, 1);
	assert.deepEqual(
		actions.slice(1).map((a) => (a.kind === "comment-post-state" ? a.status : null)),
		["posting", "posted"]
	);
});
test("a changed canonical body cannot acknowledge old frames and cancellation rejects late receipts", async () => {
	const { broker, actions, change } = setup();
	const abort = new AbortController();
	const pending = broker.present(presentation, abort.signal);
	await waitFor(() => actions.length === 1);
	change();
	const receipt = {
		sessionId: "session",
		turnId: "proposal",
		generation: 1,
		requestId: "present",
		draft: initial,
		status: "applied" as const,
	};
	assert.deepEqual(await broker.applied(receipt), { status: "stale" });
	abort.abort();
	assert.equal((await pending).status, "ignored");
	assert.deepEqual(await broker.applied(receipt), { status: "stale" });
});
test("displayed text alone does not authorize a spoken confirmation", async () => {
	const { broker, actions } = setup(true, "displayed");
	const pending = broker.present(presentation, new AbortController().signal);
	await waitFor(() => actions.length === 1);
	await broker.applied({
		sessionId: "session",
		turnId: "proposal",
		generation: 1,
		requestId: "present",
		draft: initial,
		status: "applied",
	});
	await assert.rejects(pending, /not spoken/);
	assert.equal(
		broker.confirmation.acceptUserTurn(
			{
				sessionId: "session",
				turnId: "consent",
				generation: 2,
				requestId: "user-2",
				text: "post this comment",
			},
			"voice"
		),
		false
	);
});
