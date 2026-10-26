import assert from "node:assert/strict";
import { test } from "node:test";
import { getReviewFixture } from "../../shared/fixtures/review";
import { CommentDrafts } from "./comments";

function setup() {
	const fixture = getReviewFixture();
	let posts = 0;
	let liveHead = fixture.preparation.pr.headSha;
	let failPost = false;
	const drafts = new CommentDrafts({
		getPullRequest: async () => ({ ...fixture.preparation.pr, headSha: liveHead }),
		postConfirmedComment: async () => {
			posts++;
			if (failPost) throw new Error("Network response lost after possible write");
			return { url: "https://github.com/demo/shop-web/pull/1284#comment-1" };
		},
	});
	const { id: _id, revision: _revision, ...fields } = fixture.draftComment;
	const draft = drafts.create({
		...fields,
		evidence: {
			kind: "source",
			url: "https://example.test/review-source",
			retrievedAt: "2026-10-26T20:00:00Z",
		},
	});
	const confirmation = {
		requestId: "confirm-1",
		draftId: draft.id,
		draftRevision: draft.revision,
		body: draft.body,
		headSha: draft.headSha,
		confirmed: true as const,
	};
	return {
		drafts,
		draft,
		confirmation,
		posts: () => posts,
		moveHead: () => {
			liveHead = "3".repeat(40);
		},
		failPosting: () => {
			failPost = true;
		},
	};
}
const signal = () => new AbortController().signal;

test("posting requires exact explicit confirmation and current draft revision/body", async () => {
	const ctx = setup();
	assert.equal(ctx.posts(), 0);
	assert.throws(() =>
		ctx.drafts.confirmAndPost({ ...ctx.confirmation, confirmed: false }, signal())
	);
	assert.throws(
		() => ctx.drafts.confirmAndPost({ ...ctx.confirmation, body: "different" }, signal()),
		/stale/
	);
	const edited = ctx.drafts.edit(ctx.draft.id, "Updated friendly wording");
	assert.equal(edited.originalWords, ctx.draft.originalWords);
	assert.throws(() => ctx.drafts.confirmAndPost(ctx.confirmation, signal()), /stale/);
	assert.equal(ctx.posts(), 0);
	await ctx.drafts.confirmAndPost(
		{ ...ctx.confirmation, body: edited.body, draftRevision: edited.revision },
		signal()
	);
	assert.equal(ctx.posts(), 1);
});

test("moved PR head rejects before write and draft values cannot be changed through returned objects", async () => {
	const ctx = setup();
	ctx.draft.body = "mutated externally";
	assert.notEqual(ctx.drafts.get(ctx.draft.id).body, ctx.draft.body);
	ctx.moveHead();
	await assert.rejects(
		ctx.drafts.confirmAndPost(ctx.confirmation, signal()),
		/Pull request changed/
	);
	assert.equal(ctx.posts(), 0);
	assert.equal(ctx.drafts.edit(ctx.draft.id, "Revised after failed head check").revision, 2);
});

test("concurrent and repeated confirmations never double-post a draft", async () => {
	const ctx = setup();
	const first = ctx.drafts.confirmAndPost(ctx.confirmation, signal());
	const retry = ctx.drafts.confirmAndPost(ctx.confirmation, signal());
	assert.equal(first, retry);
	assert.throws(
		() => ctx.drafts.confirmAndPost({ ...ctx.confirmation, requestId: "other" }, signal()),
		/already submitted/
	);
	await first;
	await ctx.drafts.confirmAndPost(ctx.confirmation, signal());
	assert.equal(ctx.posts(), 1);
});

test("ambiguous network failure stays unresolved and cannot trigger a blind repost", async () => {
	const ctx = setup();
	ctx.failPosting();
	await assert.rejects(ctx.drafts.confirmAndPost(ctx.confirmation, signal()));
	await assert.rejects(ctx.drafts.confirmAndPost(ctx.confirmation, signal()));
	assert.throws(
		() => ctx.drafts.confirmAndPost({ ...ctx.confirmation, requestId: "retry-new-id" }, signal()),
		/already submitted/
	);
	assert.equal(ctx.posts(), 1);
});

test("fixture drafts are blocked at the main confirmation boundary", () => {
	const ctx = setup();
	const { id: _id, revision: _revision, ...fields } = getReviewFixture().draftComment;
	const fixtureDraft = ctx.drafts.create(fields);
	assert.throws(
		() =>
			ctx.drafts.confirmAndPost(
				{
					...ctx.confirmation,
					draftId: fixtureDraft.id,
					body: fixtureDraft.body,
					draftRevision: fixtureDraft.revision,
				},
				signal()
			),
		/Fixture drafts cannot be posted/
	);
	assert.equal(ctx.posts(), 0);
});

test("a known pre-write lookup failure permits the same confirmation request to retry", async () => {
	const fixture = getReviewFixture();
	let reads = 0;
	let posts = 0;
	const drafts = new CommentDrafts({
		getPullRequest: () => {
			if (++reads === 1) throw new Error("Temporary lookup failure");
			return Promise.resolve(fixture.preparation.pr);
		},
		postConfirmedComment: async () => {
			posts++;
			return { url: "https://example.test/comment" };
		},
	});
	const { id: _id, revision: _revision, ...fields } = fixture.draftComment;
	const draft = drafts.create({
		...fields,
		evidence: {
			kind: "source",
			url: "https://example.test/source",
			retrievedAt: "2026-10-26T20:00:00Z",
		},
	});
	const input = {
		requestId: "retryable-preflight",
		draftId: draft.id,
		draftRevision: draft.revision,
		headSha: draft.headSha,
		body: draft.body,
		confirmed: true,
	};
	await assert.rejects(drafts.confirmAndPost(input, signal()), /Temporary/);
	await drafts.confirmAndPost(input, signal());
	assert.equal(reads, 2);
	assert.equal(posts, 1);
});

test("cancellation during head lookup never enters the write port with an aborted signal", async () => {
	const fixture = getReviewFixture();
	for (let depth = 0; depth <= 8; depth++) {
		const controller = new AbortController();
		let resolveRead: (pr: typeof fixture.preparation.pr) => void = () => {};
		const read = new Promise<typeof fixture.preparation.pr>((resolve) => {
			resolveRead = resolve;
		});
		const enteredAborted: boolean[] = [];
		const drafts = new CommentDrafts({
			getPullRequest: () => read,
			postConfirmedComment: async (_input, sig) => {
				enteredAborted.push(sig.aborted);
				return { url: "https://example.test/comment" };
			},
		});
		const { id: _id, revision: _revision, ...fields } = fixture.draftComment;
		const draft = drafts.create({
			...fields,
			evidence: {
				kind: "source",
				url: "https://example.test/source",
				retrievedAt: "2026-10-26T20:00:00Z",
			},
		});
		const pending = drafts
			.confirmAndPost(
				{
					requestId: "racy-confirmation",
					draftId: draft.id,
					draftRevision: draft.revision,
					headSha: draft.headSha,
					body: draft.body,
					confirmed: true,
				},
				controller.signal
			)
			.catch(() => {});
		resolveRead(fixture.preparation.pr);
		const tick = (remaining: number) => {
			if (!remaining) controller.abort();
			else queueMicrotask(() => tick(remaining - 1));
		};
		tick(depth);
		await pending;
		assert(!enteredAborted.includes(true));
	}
});
