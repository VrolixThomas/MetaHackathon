import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CommentDrafts } from "../../main/agent/comments";
import type { DraftedComment, PreparedReview, ReviewFile } from "../../shared/contracts";
import { createPreparedApi } from "../prepared/api";
import { createPreparedController } from "../prepared/controller";
import { PRCommentButton, PRCommentComposer, PRCommentControl } from "./PRCommentComposer";
import { createPRCommentApi } from "./api";
import { type PRCommentContext, commentLocation, preparedCommentContext } from "./context";
import { createPRCommentController } from "./controller";

const pr = {
	id: "owner/project#7",
	repository: "owner/project",
	number: 7,
	title: "Controlled review",
	author: "owner",
	url: "https://github.com/owner/project/pull/7",
	baseSha: "a".repeat(40),
	headSha: "b".repeat(40),
};
const plan: PreparedReview = {
	id: "review-7",
	version: 1,
	pr,
	createdAt: "2026-10-31T09:00:00Z",
	summary: "Controlled analysis",
	orderRationale: "Entry first",
	coverage: "complete",
	evidence: "inferred-from-github",
	files: [{ path: "entry.ts", reason: "Entry", summary: "Change", suggestedComments: [] }],
};
const file: ReviewFile = {
	prId: pr.id,
	path: "entry.ts",
	status: "modified",
	patch: "@@ -1,2 +1,3 @@\n same\n-old\n+new\n+added",
	base: { path: "entry.ts", commitSha: pr.baseSha, status: "available", content: "same\nold\n" },
	head: {
		path: "entry.ts",
		commitSha: pr.headSha,
		status: "available",
		content: "same\nnew\nadded\n",
	},
};
const context: PRCommentContext = { pr, reviewId: plan.id, file, selectedLine: null };
const evidence = { kind: "source" as const, url: pr.url, retrievedAt: "2026-10-31T09:00:00Z" };
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
function harness() {
	let current: PRCommentContext | null = structuredClone(context);
	let liveHead = pr.headSha;
	let posts = 0;
	let failPost = false;
	let pendingRead: Promise<typeof pr> | null = null;
	let pendingPost: Promise<{ url: string }> | null = null;
	let transformDraft = (draft: DraftedComment) => draft;
	const active = new Map<string, AbortController>();
	const calls: { type: string; path: string; input: unknown }[] = [];
	const drafts = new CommentDrafts({
		getPullRequest: async () => pendingRead ?? { ...pr, headSha: liveHead },
		postConfirmedComment: async () => {
			posts++;
			if (failPost) throw new Error("Controlled ambiguous response");
			if (pendingPost) return pendingPost;
			return { url: `${pr.url}#issuecomment-123` };
		},
	});
	const call = async (type: "mutation" | "query", path: string, raw?: unknown) => {
		calls.push({ type, path, input: structuredClone(raw) });
		if (path === "prComments.create") {
			const input = raw as {
				prId: string;
				headSha: string;
				body: string;
				location?: DraftedComment["location"];
			};
			return transformDraft(
				drafts.create({
					prId: input.prId,
					headSha: input.headSha,
					originalWords: input.body,
					body: input.body,
					evidence,
					...(input.location ? { location: input.location } : {}),
				})
			);
		}
		if (path === "prComments.edit") {
			const input = raw as { draftId: string; body: string };
			return transformDraft(drafts.edit(input.draftId, input.body));
		}
		if (path === "prComments.confirm") {
			const input = raw as { requestId: string };
			let controller = active.get(input.requestId);
			if (!controller) {
				controller = new AbortController();
				active.set(input.requestId, controller);
			}
			return drafts.confirmAndPost(raw, controller.signal);
		}
		if (path === "prComments.cancel") {
			active.get((raw as { requestId: string }).requestId)?.abort();
			return;
		}
		throw new Error(`Unexpected route: ${path}`);
	};
	let ids = 0;
	const api = createPRCommentApi(call);
	const ui = createPRCommentController(
		api,
		() => current,
		() => `comment-request-${++ids}`
	);
	return {
		ui,
		api,
		drafts,
		calls,
		posts: () => posts,
		setContext: (value: PRCommentContext | null) => {
			current = value;
		},
		moveHead: () => {
			liveHead = "c".repeat(40);
		},
		failPost: () => {
			failPost = true;
		},
		pauseRead: (value: Promise<typeof pr>) => {
			pendingRead = value;
		},
		pausePost: (value: Promise<{ url: string }>) => {
			pendingPost = value;
		},
		transform: (value: (draft: DraftedComment) => DraftedComment) => {
			transformDraft = value;
		},
	};
}
async function ready(h: ReturnType<typeof harness>, body = "Please cover the edge case.") {
	h.ui.open();
	h.ui.setBody(body);
	await h.ui.review();
	assert.equal(h.ui.getSnapshot().phase, "review");
}

test("default prepared-review controller supplies exact actual-file context and empty startup is disabled", async () => {
	const reviews = createPreparedController(
		createPreparedApi(async (_type, path, raw) => {
			if (path === "reviews.get") return { pr, prepared: plan, status: "ready", progress: null };
			if (path === "reviews.file") return file;
			if (path === "reviews.screen") return (raw as { screen: unknown }).screen;
			if (path === "reviews.progress")
				return {
					...(raw as object),
					baseSha: pr.baseSha,
					headSha: pr.headSha,
					visited: [file.path],
					updatedAt: "2026-10-31T09:00:00Z",
				};
			throw new Error(path);
		}),
		"session"
	);
	try {
		assert.equal(preparedCommentContext(reviews.store.getState()), null);
		const empty = renderToStaticMarkup(
			createElement(PRCommentControl, {
				call: async () => {
					throw new Error("No startup calls");
				},
				reviews,
			})
		);
		assert.equal(
			empty,
			"",
			"Startup has no comment action until an actual prepared review is loaded"
		);
		assert.doesNotMatch(empty, /<dialog/);
		await reviews.open(pr.id);
		const actual = preparedCommentContext(reviews.store.getState());
		assert.equal(actual?.pr.id, pr.id);
		assert.equal(actual?.reviewId, plan.id);
		assert.equal(actual?.file.head.content, file.head.content);
		const h = harness();
		const html = renderToStaticMarkup(
			createElement(PRCommentButton, {
				controller: h.ui,
				reviews: {
					...reviews,
					store: { ...reviews.store, getInitialState: reviews.store.getState },
				},
			})
		);
		assert.doesNotMatch(html, /disabled/);
		const valid = reviews.store.getState();
		assert.ok(valid.detail);
		for (const patch of [
			{ stale: true },
			{ fileBusy: true },
			{ reviewError: "failed" },
			{ screen: { ...valid.screen, headSha: "c".repeat(40) } },
			{ file: { ...file, prId: "other/project#7" } },
			{ detail: { ...valid.detail, pr: { ...pr, headSha: "c".repeat(40) } } },
		]) {
			assert.equal(preparedCommentContext({ ...valid, ...patch }), null);
		}
		const location = commentLocation(context, "2");
		assert.ok(location);
		assert.equal(
			preparedCommentContext({ ...valid, highlight: { ...location, startLine: 1, endLine: 3 } })
				?.selectedLine,
			3
		);
		assert.equal(
			preparedCommentContext({
				...valid,
				highlight: { ...location, revision: "base", commitSha: pr.baseSha },
			})?.selectedLine,
			null
		);
	} finally {
		reviews.dispose();
	}
});

test("review preserves exact body, escapes source text, and posts only after explicit consent", async () => {
	const h = harness();
	const body = "  <script>alert('x')</script>\nExact wording.  \n";
	await ready(h, body);
	assert.equal(h.posts(), 0);
	const html = renderToStaticMarkup(createElement(PRCommentComposer, { controller: h.ui }));
	assert.match(html, /aria-label="Exact comment body"/);
	assert.match(html, /&lt;script&gt;/);
	assert.doesNotMatch(html, /<script>/);
	assert.match(html, /I confirm posting this exact comment/);
	assert.match(html, /Draft revision 1/);
	assert.match(html, /type="checkbox"/);
	assert.doesNotMatch(html, /checked=""/);
	await h.ui.post();
	assert.equal(h.posts(), 0);
	h.ui.setConsent(true);
	await Promise.all([h.ui.post(), h.ui.post()]);
	assert.equal(h.posts(), 1);
	assert.equal(h.calls.filter((call) => call.path === "prComments.confirm").length, 1);
	assert.equal(h.ui.getSnapshot().request?.body, body);
	assert.equal(h.ui.getSnapshot().phase, "posted");
	assert.equal(h.ui.getSnapshot().url, `${pr.url}#issuecomment-123`);
	h.ui.newComment();
	assert.equal(h.ui.getSnapshot().body, "");
	assert.equal(h.ui.getSnapshot().request, null);
});

test("selected ranges honestly attach only the selected final head-side diff line", async () => {
	const h = harness();
	h.setContext({ ...context, selectedLine: 3 });
	await ready(h);
	assert.equal(h.ui.getSnapshot().draft?.location?.startLine, 3);
	assert.equal(h.ui.getSnapshot().draft?.location?.endLine, 3);
	const html = renderToStaticMarkup(createElement(PRCommentComposer, { controller: h.ui }));
	assert.match(html, /entry.ts:3 · Head/);
	const invalid = harness();
	invalid.ui.open();
	invalid.ui.setBody("Comment");
	for (const line of ["0", "4", "-1", "1.5", "Infinity", "1e0"]) {
		invalid.ui.setLine(line);
		await invalid.ui.review();
		assert.equal(invalid.calls.length, 0);
		assert.match(invalid.ui.getSnapshot().error, /head-side line/);
	}
	assert.throws(() => commentLocation({ ...context, file: { ...file, patch: null } }, "1"));
	assert.throws(() =>
		commentLocation(
			{ ...context, file: { ...file, head: { ...file.head, status: "binary", content: null } } },
			"1"
		)
	);
});

test("editing clears consent and confirmation binds the returned incremented revision", async () => {
	const h = harness();
	await ready(h);
	h.ui.setConsent(true);
	h.ui.edit();
	assert.equal(h.ui.getSnapshot().consent, false);
	h.ui.setBody("  Revised\nbody  ");
	await h.ui.review();
	assert.equal(h.ui.getSnapshot().draft?.revision, 2);
	await h.ui.post();
	assert.equal(h.posts(), 0);
	h.ui.setConsent(true);
	await h.ui.post();
	assert.equal(h.ui.getSnapshot().request?.draftRevision, 2);
	assert.equal(h.ui.getSnapshot().request?.body, "  Revised\nbody  ");
	assert.equal(h.posts(), 1);
});

test("head/context change after consent is rechecked even before the subscription runs", async () => {
	for (const changed of [
		null,
		{ ...context, pr: { ...pr, headSha: "c".repeat(40) } },
		{ ...context, reviewId: "review-8" },
		{ ...context, file: { ...file, path: "other.ts" } },
	]) {
		const h = harness();
		await ready(h);
		h.ui.setConsent(true);
		h.setContext(changed);
		await h.ui.post();
		assert.equal(h.posts(), 0);
		assert.equal(h.ui.getSnapshot().consent, false);
		assert.equal(h.ui.getSnapshot().draft, null);
		assert.equal(h.calls.filter((call) => call.path === "prComments.confirm").length, 0);
		assert.equal(h.ui.getSnapshot().body, "Please cover the edge case.");
	}
});

test("main rejects moved head or stale revision before any controlled write", async () => {
	for (const change of ["head", "revision"]) {
		const h = harness();
		await ready(h);
		h.ui.setConsent(true);
		if (change === "head") h.moveHead();
		else {
			const draft = h.ui.getSnapshot().draft;
			assert.ok(draft);
			h.drafts.edit(draft.id, "Changed externally");
		}
		await h.ui.post();
		assert.equal(h.posts(), 0);
		assert.equal(h.ui.getSnapshot().phase, "uncertain");
		assert.ok(h.ui.getSnapshot().request);
		h.ui.newComment();
		assert.equal(h.ui.getSnapshot().phase, "uncertain");
	}
});

test("ambiguous controlled failure locks editing and retries keep exactly the original request", async () => {
	const h = harness();
	await ready(h);
	h.failPost();
	h.ui.setConsent(true);
	await h.ui.post();
	const original = structuredClone(h.ui.getSnapshot().request);
	assert.equal(h.posts(), 1);
	assert.equal(h.ui.getSnapshot().phase, "uncertain");
	h.ui.edit();
	h.ui.setBody("different");
	h.ui.setLine("2");
	assert.equal(h.ui.getSnapshot().body, original?.body);
	h.ui.close();
	h.ui.open();
	assert.equal(h.ui.getSnapshot().consent, false);
	await h.ui.post();
	assert.equal(h.calls.filter((call) => call.path === "prComments.confirm").length, 1);
	h.ui.setConsent(true);
	await h.ui.post();
	assert.deepEqual(h.ui.getSnapshot().request, original);
	assert.equal(h.posts(), 1);
	assert.deepEqual(
		h.calls.filter((call) => call.path === "prComments.confirm").map((call) => call.input),
		[original, original]
	);
});

test("cancel before confirmation sends nothing; cancellation during head preflight aborts main and retains attempt identity", async () => {
	const h = harness();
	await ready(h);
	h.ui.close();
	assert.equal(h.calls.filter((call) => /confirm|cancel/.test(call.path)).length, 0);
	h.ui.open();
	h.ui.setConsent(true);
	const read = deferred<typeof pr>();
	h.pauseRead(read.promise);
	const posting = h.ui.post();
	await Promise.resolve();
	h.ui.close();
	read.resolve(pr);
	await posting;
	assert.equal(h.posts(), 0);
	assert.equal(h.ui.getSnapshot().open, false);
	assert.equal(h.ui.getSnapshot().phase, "uncertain");
	const request = h.ui.getSnapshot().request;
	assert.ok(request);
	assert.deepEqual(h.calls.find((call) => call.path === "prComments.cancel")?.input, {
		requestId: request.requestId,
	});
});

test("context change while posting requests cancellation and preserves original target identity", async () => {
	const h = harness();
	await ready(h);
	const read = deferred<typeof pr>();
	h.pauseRead(read.promise);
	h.ui.setConsent(true);
	const posting = h.ui.post();
	await Promise.resolve();
	h.setContext({
		...context,
		pr: { ...pr, id: "different/repo#9", repository: "different/repo", number: 9 },
	});
	h.ui.refreshContext();
	read.resolve(pr);
	await posting;
	assert.equal(h.posts(), 0);
	assert.equal(h.ui.canConfirm(), false);
	const html = renderToStaticMarkup(createElement(PRCommentComposer, { controller: h.ui }));
	assert.match(html, /owner\/project #7/);
	assert.doesNotMatch(html, /different\/repo #9/);
});

test("cancellation after dispatch remains uncertain and cannot blindly repost", async () => {
	const h = harness();
	await ready(h);
	const posted = deferred<{ url: string }>();
	h.pausePost(posted.promise);
	h.ui.setConsent(true);
	const posting = h.ui.post();
	for (let tick = 0; tick < 20 && h.posts() === 0; tick++) await Promise.resolve();
	assert.equal(h.posts(), 1);
	h.ui.close();
	await posting;
	posted.resolve({ url: `${pr.url}#issuecomment-123` });
	assert.equal(h.ui.getSnapshot().phase, "uncertain");
	assert.equal(h.ui.getSnapshot().url, null);
	h.ui.open();
	h.ui.setConsent(true);
	await h.ui.post();
	assert.equal(h.posts(), 1);
	assert.equal(h.ui.getSnapshot().phase, "uncertain");
});

test("late draft preparation cannot restore a cancelled or changed target", async () => {
	for (const cancel of [true, false]) {
		const h = harness();
		const pending = deferred<DraftedComment>();
		let uiContext: PRCommentContext | null = context;
		const ui = createPRCommentController(
			{ ...h.api, create: () => pending.promise },
			() => uiContext,
			() => "create-delayed"
		);
		ui.open();
		ui.setBody("Waiting");
		const saving = ui.review();
		if (cancel) ui.close();
		else {
			uiContext = null;
			ui.refreshContext();
		}
		pending.resolve(
			h.drafts.create({
				prId: pr.id,
				headSha: pr.headSha,
				body: "Waiting",
				originalWords: "Waiting",
				evidence,
			})
		);
		await saving;
		assert.equal(ui.getSnapshot().draft, null);
		assert.equal(ui.getSnapshot().phase, "compose");
		assert.equal(ui.getSnapshot().body, "Waiting");
		assert.equal(h.posts(), 0);
	}
});

test("mismatched or fixture draft responses never enable confirmation", async () => {
	for (const mutate of [
		(draft: DraftedComment) => ({ ...draft, body: `${draft.body}!` }),
		(draft: DraftedComment) => ({ ...draft, headSha: "c".repeat(40) }),
		(draft: DraftedComment) => ({ ...draft, prId: "other/repo#1" }),
		(draft: DraftedComment) => ({ ...draft, originalWords: "changed" }),
		(draft: DraftedComment) => ({
			...draft,
			evidence: { kind: "fixture" as const, fixtureId: "controlled", label: "controlled fixture" },
		}),
	]) {
		const h = harness();
		h.transform(mutate);
		h.ui.open();
		h.ui.setBody("Exact");
		await h.ui.review();
		assert.equal(h.ui.getSnapshot().phase, "compose");
		assert.equal(h.ui.canConfirm(), false);
		assert.equal(h.posts(), 0);
		assert.equal(h.ui.getSnapshot().body, "Exact");
	}
});

test("an edit response with a stale revision is rejected", async () => {
	const h = harness();
	await ready(h);
	const saved = h.ui.getSnapshot().draft;
	assert.ok(saved);
	const oldRevision = saved.revision;
	h.ui.edit();
	h.ui.setBody("Reworded");
	h.transform((draft) => ({ ...draft, revision: oldRevision }));
	await h.ui.review();
	assert.equal(h.ui.getSnapshot().phase, "compose");
	assert.equal(h.ui.canConfirm(), false);
});

test("receipt outside the actual PR is uncertain and never a success link", async () => {
	const h = harness();
	const ui = createPRCommentController(
		{ ...h.api, confirm: async () => ({ url: "https://github.com/other/repo/pull/7#comment" }) },
		() => context
	);
	ui.open();
	ui.setBody("Test");
	await ui.review();
	ui.setConsent(true);
	await ui.post();
	assert.equal(ui.getSnapshot().phase, "uncertain");
	assert.equal(ui.getSnapshot().url, null);
});
