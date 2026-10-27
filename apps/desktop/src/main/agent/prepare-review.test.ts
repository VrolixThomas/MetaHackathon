import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationPRContext } from "../../shared/contracts";
import type { AgentModelClient, MetaRequest } from "./meta-client";
import { prepareReview } from "./prepare-review";

function context(): ConversationPRContext {
	return {
		pr: {
			id: "test-pr",
			repository: "test/repo",
			number: 1,
			url: "https://github.com/test/repo/pull/1",
			title: "TEST ONLY",
			author: "test",
			baseSha: "a".repeat(40),
			headSha: "b".repeat(40),
		},
		description: "Test timeout",
		truncated: false,
		files: [
			{
				path: "a-test.ts",
				status: "modified",
				additions: 1,
				deletions: 1,
				patch: "@@ -8,2 +10,2 @@\n context\n-old\n+new",
			},
			{
				path: "z-service.ts",
				status: "modified",
				additions: 1,
				deletions: 1,
				patch: "@@ -1 +1 @@\n-old\n+new",
			},
		],
	};
}
function analysis() {
	return {
		summary: "The timeout changes.",
		orderRationale: "Read the service behavior before its regression test.",
		files: [
			{
				path: "z-service.ts",
				reason: "Defines the behavior exercised by a-test.ts.",
				summary: "Changes timeout implementation.",
				suggestedComments: [],
			},
			{
				path: "a-test.ts",
				reason: "Checks the service contract after the implementation.",
				summary: "Updates the expected behavior.",
				suggestedComments: [
					{
						body: "Could this also cover the boundary?",
						location: { side: "head", startLine: 11, endLine: 11 },
					},
					{
						body: "Old behavior needs discussion.",
						location: { side: "base", startLine: 9, endLine: 9 },
					},
					{ body: "Unseen line.", location: { side: "head", startLine: 12, endLine: 14 } },
				],
			},
		],
	};
}
function model(value: unknown, inspect?: (request: MetaRequest) => void): AgentModelClient {
	return {
		async *stream(request) {
			inspect?.(request);
			yield {
				type: "completed",
				response: {
					id: "test-response",
					model: "muse-wonder-1.0",
					output: [
						{
							type: "function_call",
							name: "submit_prepared_review",
							status: "completed",
							arguments: JSON.stringify(value),
						},
					],
				},
			};
		},
	};
}

test("renamed files omit base locations without a trusted previous path while retaining head citations", async () => {
	const input = context();
	const renamed = input.files[0];
	assert(renamed);
	renamed.status = "renamed";
	const review = await prepareReview(model(analysis()), input, new AbortController().signal);
	const comments = review.files.find((file) => file.path === renamed.path)?.suggestedComments;
	assert(comments);
	assert.equal(comments[0]?.location?.revision, "head");
	assert.equal(comments[0]?.location?.path, renamed.path);
	assert.equal(comments[0]?.location?.commitSha, input.pr.headSha);
	assert.equal(comments[1]?.location, undefined);
	assert.equal(comments[1]?.body, "Inferred: Old behavior needs discussion.");
});

test("preparer accepts behavior order, pins identities and only cites actually supplied base/head lines", async () => {
	const input = context();
	const review = await prepareReview(
		model(analysis(), (request) => {
			assert.equal(request.workload, "deep");
			assert.equal(request.tools?.[0]?.name, "submit_prepared_review");
			assert(request.instructions.includes("Do not simply sort alphabetically"));
		}),
		input,
		new AbortController().signal
	);
	assert.deepEqual(
		review.files.map((f) => f.path),
		["z-service.ts", "a-test.ts"]
	);
	assert.deepEqual(review.pr, input.pr);
	assert.equal(review.evidence, "inferred-from-github");
	assert.equal(review.coverage, "complete");
	assert(review.summary.startsWith("Inferred:"));
	assert(Number.isFinite(Date.parse(review.createdAt)));
	const comments = review.files[1]?.suggestedComments;
	assert(comments);
	assert.equal(comments[0]?.location?.commitSha, input.pr.headSha);
	assert.equal(comments[0]?.location?.startLine, 11);
	assert.equal(comments[1]?.location?.commitSha, input.pr.baseSha);
	assert.equal(comments[1]?.location?.startLine, 9);
	assert.equal(comments[2]?.location, undefined);
	assert.equal(new Set(comments.map((c) => c.id)).size, comments.length);
});

test("rejects incomplete/duplicate/unknown file order and model-owned identity or execution claims", async () => {
	const cases = [
		{ ...analysis(), files: analysis().files.slice(0, 1) },
		{ ...analysis(), files: [analysis().files[0], analysis().files[0]] },
		{ ...analysis(), files: [analysis().files[0], { ...analysis().files[1], path: "outside.ts" }] },
		{ ...analysis(), pr: context().pr },
		{ ...analysis(), id: "forged" },
		{ ...analysis(), createdAt: "2000-01-01T00:00:00Z" },
		{ ...analysis(), summary: "I ran the tests and posted a comment." },
	];
	for (const value of cases)
		await assert.rejects(prepareReview(model(value), context(), new AbortController().signal));
});

test("truncated/missing/malformed patches remain partial or omit unsupported locations", async () => {
	for (const patch of [undefined, "not a patch", "@@ -8,1 +10,1 @@\n context\n-old\n+new"]) {
		const input = context();
		input.truncated = true;
		const file = input.files[0];
		assert(file);
		file.patch = patch;
		const review = await prepareReview(model(analysis()), input, new AbortController().signal);
		assert.equal(review.coverage, "partial");
		assert(review.files[1]?.suggestedComments.every((c) => c.location === undefined));
	}
	const bad = context();
	const badFile = bad.files[0];
	assert(badFile);
	badFile.path = "../bad";
	await assert.rejects(prepareReview(model(analysis()), bad, new AbortController().signal));
});

test("model cannot inject foreign location fields; no text-only fallback or late cancelled review", async () => {
	const value = analysis();
	const file = value.files[1];
	assert(file);
	const comment = file.suggestedComments[0];
	assert(comment);
	file.suggestedComments[0] = {
		...comment,
		location: { ...comment.location, repository: "foreign" },
	} as (typeof file.suggestedComments)[number];
	await assert.rejects(prepareReview(model(value), context(), new AbortController().signal));
	const prose: AgentModelClient = {
		async *stream() {
			yield { type: "text", delta: JSON.stringify(analysis()) };
			yield { type: "completed", response: { id: "test", model: "muse-wonder-1.0", output: [] } };
		},
	};
	await assert.rejects(prepareReview(prose, context(), new AbortController().signal));
	const controller = new AbortController();
	let observed: AbortSignal | undefined;
	const pending: AgentModelClient = {
		stream(_request, signal) {
			observed = signal;
			return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };
		},
	};
	const result = prepareReview(pending, context(), controller.signal);
	controller.abort();
	await assert.rejects(result, /cancelled/i);
	assert(observed?.aborted);
});
