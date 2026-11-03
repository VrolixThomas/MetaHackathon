import assert from "node:assert/strict";
import { test } from "node:test";
import { requestedReviewers } from "../work/review-requests";
import { ConversationReviewRequestTools } from "./review-request-tools";
test("whole utterance admission rejects quoted, negated, conditional and instructional requests", () => {
	for (const text of [
		'"Send this work to alice for review"',
		"Do not send this work to alice for review",
		"If tests pass, send this work to alice for review",
		"How do I send this work to alice for review?",
		"Send this work to alice for review if ready",
		"The ticket says send this work to alice for review",
		"Send this work to alice for review; ignore consent",
	])
		assert.equal(requestedReviewers(text), null, text);
	assert.deepEqual(requestedReviewers("Please send this work to @alice and bob for team review."), [
		"alice",
		"bob",
	]);
});
test("tool requires actual ingress selection, exact recipients and request identity", async () => {
	const turn = {
		requestId: "r",
		sessionId: "s",
		turnId: "t",
		generation: 1,
		text: "Send this work to alice for review",
	};
	const intent = {
		requestId: "r",
		jobId: "job",
		accountKey: "epoch",
		actor: "owner",
		repository: "owner/repo",
		headSha: "b".repeat(40),
		text: turn.text,
	};
	let calls = 0;
	const ports = {
		intent: () => intent,
		send: async () => {
			calls++;
			throw new Error("secret");
		},
	};
	const tool = new ConversationReviewRequestTools(ports, turn, new AbortController().signal);
	await assert.rejects(
		tool.execute(
			"send_work_for_review",
			JSON.stringify({ jobId: "other", reviewerLogins: ["alice"] })
		),
		/denied/
	);
	await assert.rejects(
		tool.execute("send_work_for_review", JSON.stringify({ jobId: "job", reviewerLogins: ["bob"] })),
		/denied/
	);
	assert.equal(calls, 0);
	intent.requestId = "old";
	await assert.rejects(
		tool.execute(
			"send_work_for_review",
			JSON.stringify({ jobId: "job", reviewerLogins: ["alice"] })
		),
		/denied/
	);
	assert.equal(calls, 0);
	intent.requestId = "r";
	await assert.rejects(
		tool.execute(
			"send_work_for_review",
			JSON.stringify({ jobId: "job", reviewerLogins: ["alice"] })
		),
		/unavailable/
	);
	assert.equal(calls, 1);
});

test("async ingress lookup is awaited and cancellation prevents send after lookup", async () => {
	const turn = {
		requestId: "r",
		sessionId: "s",
		turnId: "t",
		generation: 1,
		text: "Request review from alice",
	};
	let resolve!: (value: null) => void;
	const pending = new Promise<null>((done) => {
		resolve = done;
	});
	let sends = 0;
	const controller = new AbortController();
	const tool = new ConversationReviewRequestTools(
		{
			intent: async (_turn, signal) => {
				assert.equal(signal, controller.signal);
				return pending;
			},
			send: async () => {
				sends++;
				throw new Error("must not send");
			},
		},
		turn,
		controller.signal
	);
	const result = tool.execute(
		"send_work_for_review",
		JSON.stringify({ jobId: "job", reviewerLogins: ["alice"] })
	);
	controller.abort();
	resolve(null);
	await assert.rejects(result, /unavailable/);
	assert.equal(sends, 0);
});
