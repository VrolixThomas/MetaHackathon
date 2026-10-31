import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	CodeLocation,
	DraftedComment,
	PRCommentCreateInput,
	PullRequest,
	ReviewDetail,
	ReviewFile,
} from "../../shared/contracts";
import { PreparedComments, type PreparedCommentsPorts } from "./prepared-comments";

const pr: PullRequest = {
	id: "owner/project#12",
	repository: "owner/project",
	number: 12,
	url: "https://github.com/owner/project/pull/12",
	title: "Review source",
	author: "owner",
	baseSha: "a".repeat(40),
	headSha: "b".repeat(40),
};
const review: ReviewDetail = {
	pr,
	status: "ready",
	progress: null,
	prepared: {
		id: "prepared-12",
		version: 1,
		pr,
		createdAt: "2026-10-31T12:00:00Z",
		summary: "Source inference",
		orderRationale: "Read the API",
		files: [{ path: "src/api.ts", reason: "API", summary: "API changes", suggestedComments: [] }],
		coverage: "complete",
		evidence: "inferred-from-github",
	},
};
const file: ReviewFile = {
	prId: pr.id,
	path: "src/api.ts",
	status: "modified",
	patch: "@@ -2,2 +2,3 @@\n kept\n-old\n+new\n+added",
	base: {
		path: "src/api.ts",
		commitSha: pr.baseSha,
		status: "available",
		content: "first\nkept\nold\n",
	},
	head: {
		path: "src/api.ts",
		commitSha: pr.headSha,
		status: "available",
		content: "first\nkept\nnew\nadded\nlast\n",
	},
};
const location: CodeLocation = {
	repository: pr.repository,
	revision: "head",
	commitSha: pr.headSha,
	path: file.path,
	startLine: 3,
	endLine: 3,
};
const input: PRCommentCreateInput = {
	requestId: "create-1",
	prId: pr.id,
	reviewId: "prepared-12",
	headSha: pr.headSha,
	body: "  Original words\nwith exact spacing.  ",
	location,
};
function confirmation(draft: DraftedComment, requestId = "confirm-1") {
	return {
		requestId,
		draftId: draft.id,
		draftRevision: draft.revision,
		headSha: draft.headSha,
		body: draft.body,
		confirmed: true as const,
	};
}
function deferred() {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
type Stage = "review" | "file" | "pr" | "post";
function harness(capacity = 256) {
	const state = {
		review: structuredClone(review),
		file: structuredClone(file),
		pr: structuredClone(pr),
		epoch: 1,
		receipt: `${pr.url}#discussion_r123`,
		error: "",
		hook: null as ((stage: Stage, signal: AbortSignal) => Promise<void>) | null,
	};
	const reads: Stage[] = [];
	const signals: AbortSignal[] = [];
	const posts: Array<{
		draft: DraftedComment;
		idempotencyKey: string;
		expectedHeadSha: string;
	}> = [];
	const enter = async (stage: Stage, signal: AbortSignal) => {
		assert.equal(signal.aborted, false, `aborted signal entered ${stage}`);
		reads.push(stage);
		signals.push(signal);
		await state.hook?.(stage, signal);
	};
	const ports: PreparedCommentsPorts = {
		getEpoch: () => state.epoch,
		getReview: async (prId, signal) => {
			assert.equal(prId, pr.id);
			await enter("review", signal);
			return state.review;
		},
		readFile: async (request, signal) => {
			assert.deepEqual(request, { prId: pr.id, reviewId: input.reviewId, path: file.path });
			await enter("file", signal);
			return state.file;
		},
		readPR: async (prId, signal) => {
			assert.equal(prId, pr.id);
			await enter("pr", signal);
			return state.pr;
		},
		post: async (draft, options, signal) => {
			posts.push({ draft: structuredClone(draft), ...options });
			await enter("post", signal);
			if (state.error) throw new Error(state.error);
			return { id: 123, url: state.receipt };
		},
	};
	return { state, reads, signals, posts, service: new PreparedComments(ports, capacity) };
}
async function until(predicate: () => boolean) {
	for (let n = 0; n < 40 && !predicate(); n++)
		await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(predicate(), true, "Expected controlled work to reach its gate");
}

test("derives exact words, source evidence and a single pinned anchor from the real ready record", async () => {
	const h = harness();
	try {
		const draft = await h.service.create(input);
		assert.equal(draft.body, input.body);
		assert.equal(draft.originalWords, input.body);
		assert.deepEqual(draft.location, location);
		assert.equal(draft.evidence.kind, "source");
		if (draft.evidence.kind === "source") {
			assert.equal(
				draft.evidence.url,
				`https://github.com/owner/project/blob/${pr.headSha}/src/api.ts#L3`
			);
			assert.ok(Number.isFinite(Date.parse(draft.evidence.retrievedAt)));
		}
		draft.body = "external mutation";
		const retried = await h.service.create(input);
		assert.equal(retried.id, draft.id);
		assert.equal(retried.body, input.body);
		assert.deepEqual(h.reads, ["review", "file", "pr"]);
		await assert.rejects(h.service.create({ ...input, body: "other" }), /request ID reused/);
		const general = await h.service.create({ ...input, requestId: "general", location: undefined });
		assert.equal(general.location, undefined);
		if (general.evidence.kind === "source") assert.equal(general.evidence.url, pr.url);
	} finally {
		h.service.dispose();
	}
});

test("edits preserve original words and anchor; exact revision/body/head/consent gate the ledger post", async () => {
	const h = harness();
	try {
		const draft = await h.service.create(input);
		const edited = await h.service.edit({ draftId: draft.id, body: "Revised exact body" });
		assert.equal(edited.revision, 2);
		assert.equal(edited.originalWords, input.body);
		assert.deepEqual(edited.location, location);
		assert.deepEqual(edited.evidence, draft.evidence);
		for (const invalid of [
			confirmation(draft),
			{ ...confirmation(edited), body: "different" },
			{ ...confirmation(edited), headSha: "c".repeat(40) },
			{ ...confirmation(edited), confirmed: false },
		])
			await assert.rejects(h.service.confirm(invalid));
		assert.equal(h.posts.length, 0);
		const results = await Promise.all([
			h.service.confirm(confirmation(edited)),
			h.service.confirm(confirmation(edited)),
		]);
		assert.deepEqual(results, [{ url: h.state.receipt }, { url: h.state.receipt }]);
		assert.deepEqual(h.posts, [
			{ draft: edited, idempotencyKey: "confirm-1", expectedHeadSha: pr.headSha },
		]);
		h.service.cancel("confirm-1");
		assert.deepEqual(await h.service.confirm(confirmation(edited)), { url: h.state.receipt });
		await assert.rejects(
			h.service.edit({ draftId: draft.id, body: "Too late" }),
			/cannot be edited/
		);
	} finally {
		h.service.dispose();
	}
});

test("rejects stale review/head, foreign repositories, nonfiles, LEFT/ranges and nondiff source lines", async () => {
	for (const changes of [
		{ reviewId: "older-review" },
		{ headSha: "c".repeat(40) },
		{ location: { ...location, repository: "foreign/repository" } },
		{ location: { ...location, path: "not-prepared.ts" } },
		{ location: { ...location, revision: "base" } },
		{ location: { ...location, commitSha: pr.baseSha } },
		{ location: { ...location, endLine: 4 } },
		{ location: { ...location, startLine: 1, endLine: 1 } },
		{ location: { ...location, startLine: 6, endLine: 6 } },
	]) {
		const h = harness();
		try {
			await assert.rejects(h.service.create({ ...input, ...changes }));
			assert.equal(h.posts.length, 0);
		} finally {
			h.service.dispose();
		}
	}
	for (const line of [2, 4]) {
		const h = harness();
		try {
			const draft = await h.service.create({
				...input,
				location: { ...location, startLine: line, endLine: line },
			});
			assert.equal(draft.location?.endLine, line, "RIGHT context and added lines are valid");
		} finally {
			h.service.dispose();
		}
	}
});

test("validates fetched file identity/content and complete diff hunks instead of trusting renderer provenance", async () => {
	for (const change of [
		{ prId: "foreign/pr#1" },
		{ path: "other.ts" },
		{ head: { ...file.head, path: "other.ts" } },
		{ head: { ...file.head, commitSha: "c".repeat(40) } },
		{ base: { ...file.base, commitSha: "c".repeat(40) } },
		{ head: { ...file.head, status: "binary" as const, content: null } },
		{ head: { ...file.head, content: "first\nkept\nnot the diff\nadded\n" } },
		{ patch: null },
		{ patch: "@@ -2,2 +2,3 @@\n kept\n-old\n+new" },
		{ patch: "@@ -2,2 +2,1 @@\n kept\n-old\n+new" },
	]) {
		const h = harness();
		h.state.file = { ...h.state.file, ...change };
		try {
			await assert.rejects(h.service.create(input));
			assert.equal(h.posts.length, 0);
		} finally {
			h.service.dispose();
		}
	}
});

test("moved live heads and replaced ready plans reject before posting, including after draft creation", async () => {
	const h = harness();
	try {
		h.state.pr.headSha = "c".repeat(40);
		await assert.rejects(h.service.create(input), /Pull request changed/);
		h.state.pr = structuredClone(pr);
		const draft = await h.service.create({ ...input, requestId: "second-create" });
		h.state.pr.headSha = "c".repeat(40);
		await assert.rejects(h.service.confirm(confirmation(draft)), /Pull request changed/);
		h.state.pr = structuredClone(pr);
		assert.deepEqual(
			await h.service.confirm(confirmation(draft)),
			{ url: h.state.receipt },
			"known pre-write failure can retry the same request"
		);
		assert.equal(h.posts.length, 1);
	} finally {
		h.service.dispose();
	}
	const changed = harness();
	try {
		const draft = await changed.service.create(input);
		if (changed.state.review.prepared) changed.state.review.prepared.id = "replaced";
		await assert.rejects(changed.service.confirm(confirmation(draft)), /Prepared review changed/);
		assert.equal(changed.posts.length, 0);
	} finally {
		changed.service.dispose();
	}
});

test("new files and renamed base paths retain a single real head-side diff anchor", async () => {
	for (const renamed of [false, true]) {
		const h = harness();
		try {
			h.state.file = renamed
				? { ...h.state.file, status: "renamed", base: { ...file.base, path: "src/old-api.ts" } }
				: {
						...h.state.file,
						status: "added",
						patch: "@@ -0,0 +1,3 @@\n+first\n+kept\n+new\n\\ No newline at end of file",
						base: { ...file.base, status: "missing", content: null },
						head: { ...file.head, content: "first\nkept\nnew" },
					};
			const draft = await h.service.create(input);
			assert.deepEqual(draft.location, location);
			await h.service.confirm(confirmation(draft));
			assert.equal(h.posts[0]?.draft.location?.startLine, 3);
			assert.equal(h.posts[0]?.draft.location?.endLine, 3);
		} finally {
			h.service.dispose();
		}
	}
});

test("invalid boundary payloads and provider failures return sanitized errors without trusting provenance", async () => {
	const h = harness();
	try {
		await assert.rejects(
			h.service.create({ ...input, evidence: { kind: "execution", command: ["SECRET"] } }),
			(error: Error) => {
				assert.equal(error.message, "Invalid PR comment request");
				return true;
			}
		);
		h.state.hook = async () => {
			throw new Error("SECRET provider response");
		};
		await assert.rejects(h.service.create(input), (error: Error) => {
			assert.equal(error.message, "Could not prepare this exact PR comment");
			return true;
		});
		assert.equal(h.posts.length, 0);
	} finally {
		h.service.dispose();
	}
});

test("cancellation tombstones win before confirmation registration and cancel in-flight preflight", async () => {
	for (const stage of [null, "review", "file", "pr"] as const) {
		const h = harness();
		try {
			const draft = await h.service.create(input);
			const gate = deferred();
			h.reads.length = 0;
			h.state.hook = async (entered) => {
				if (entered === stage) await gate.promise;
			};
			if (stage === null) h.service.cancel("confirm-1");
			const pending = h.service.confirm(confirmation(draft));
			const rejected = assert.rejects(pending);
			if (stage) {
				await until(() => h.reads.includes(stage));
				h.service.cancel("confirm-1");
			}
			await rejected;
			gate.resolve();
			await assert.rejects(h.service.confirm(confirmation(draft)));
			assert.equal(h.posts.length, 0);
			if (stage === null) assert.deepEqual(h.reads, []);
		} finally {
			h.service.dispose();
		}
	}
});

test("account epoch fences each read, the immediate posting boundary and late post receipts", async () => {
	for (const stage of ["review", "file", "pr", "post"] as const) {
		const h = harness();
		try {
			const draft = await h.service.create(input);
			const gate = deferred();
			h.reads.length = 0;
			h.state.hook = async (entered) => {
				if (entered === stage) await gate.promise;
			};
			const pending = assert.rejects(h.service.confirm(confirmation(draft)));
			await until(() => h.reads.includes(stage));
			h.state.epoch++;
			gate.resolve();
			await pending;
			assert.equal(h.posts.length, stage === "post" ? 1 : 0);
			assert.equal(h.signals.at(-1)?.aborted, true);
			await assert.rejects(
				h.service.edit({ draftId: draft.id, body: "old account" }),
				/unavailable/
			);
		} finally {
			h.service.dispose();
		}
	}
	const boundary = harness();
	try {
		const draft = await boundary.service.create(input);
		boundary.state.hook = async (stage) => {
			if (stage === "pr") queueMicrotask(() => boundary.state.epoch++);
		};
		await assert.rejects(boundary.service.confirm(confirmation(draft)));
		assert.equal(boundary.posts.length, 0);
	} finally {
		boundary.service.dispose();
	}
});

test("invalidate/dispose abort pending work immediately and retire every draft and cached create", async () => {
	for (const action of ["invalidate", "dispose"] as const) {
		const h = harness();
		const gate = deferred();
		try {
			const draft = await h.service.create(input);
			h.state.hook = async () => gate.promise;
			const pending = assert.rejects(h.service.confirm(confirmation(draft)));
			await until(() => h.signals.length > 3);
			h.service[action]();
			await pending;
			assert.equal(h.signals.at(-1)?.aborted, true);
			gate.resolve();
			await assert.rejects(h.service.confirm(confirmation(draft)));
			assert.equal(h.posts.length, 0);
		} finally {
			h.service.dispose();
		}
	}
});

test("account changes fence late create/edit results and a new create retires the previous account", async () => {
	for (const operation of ["create", "edit"] as const) {
		const h = harness();
		const gate = deferred();
		try {
			const draft = await h.service.create(input);
			h.reads.length = 0;
			h.state.hook = async () => gate.promise;
			const pending = assert.rejects(
				operation === "create"
					? h.service.create({ ...input, requestId: "late-create" })
					: h.service.edit({ draftId: draft.id, body: "late edit" })
			);
			await until(() => h.reads.length > 0);
			h.state.epoch++;
			gate.resolve();
			await pending;
			await assert.rejects(h.service.confirm(confirmation(draft)), /unavailable/);
		} finally {
			h.service.dispose();
		}
	}
	const h = harness(1);
	try {
		const old = await h.service.create(input);
		h.state.epoch++;
		const fresh = await h.service.create({ ...input, requestId: "new-account" });
		assert.notEqual(old.id, fresh.id);
		await assert.rejects(h.service.confirm(confirmation(old)), /unavailable/);
		assert.deepEqual(await h.service.confirm(confirmation(fresh)), { url: h.state.receipt });
	} finally {
		h.service.dispose();
	}
});

test("cancelling a dispatched write ignores its late result and never retries the external write", async () => {
	const h = harness();
	const gate = deferred();
	try {
		const draft = await h.service.create(input);
		h.state.hook = async (stage) => {
			if (stage === "post") await gate.promise;
		};
		const pending = assert.rejects(h.service.confirm(confirmation(draft)));
		await until(() => h.posts.length === 1);
		h.service.cancel("confirm-1");
		await pending;
		assert.equal(h.signals.at(-1)?.aborted, true);
		gate.resolve();
		await assert.rejects(h.service.confirm(confirmation(draft)));
		await assert.rejects(h.service.confirm(confirmation(draft, "new-attempt")), /original/);
		assert.equal(h.posts.length, 1);
	} finally {
		h.service.dispose();
	}
});

test("ambiguous writes retain their exact request, block edits/new IDs and never blindly repost", async () => {
	const h = harness();
	try {
		const draft = await h.service.create(input);
		h.state.error = "SECRET token and provider response lost after possible write";
		const request = confirmation(draft);
		await assert.rejects(h.service.confirm(request), (error: Error) => {
			assert.match(error.message, /Posting was not confirmed/);
			assert.doesNotMatch(error.message, /SECRET|token|provider response/);
			return true;
		});
		h.state.error = "";
		await assert.rejects(h.service.confirm(request));
		await assert.rejects(h.service.confirm(confirmation(draft, "new-id")), /original/);
		await assert.rejects(
			h.service.edit({ draftId: draft.id, body: "changed" }),
			/cannot be edited/
		);
		assert.equal(h.posts.length, 1);
	} finally {
		h.service.dispose();
	}
});

test("accepts only actual HTTPS GitHub comment receipts for this same PR and retains invalid outcomes", async () => {
	for (const receipt of [
		"http://github.com/owner/project/pull/12#issuecomment-1",
		"https://attacker.test/owner/project/pull/12#issuecomment-1",
		"https://github.com/owner/project/pull/13#issuecomment-1",
		"https://github.com/other/project/pull/12#issuecomment-1",
		"https://user:password@github.com/owner/project/pull/12#issuecomment-1",
		"https://github.com/owner/project/pull/12?other=1#issuecomment-1",
		"https://github.com/owner/project/pull/12#unverified",
	]) {
		const h = harness();
		try {
			const draft = await h.service.create(input);
			h.state.receipt = receipt;
			await assert.rejects(h.service.confirm(confirmation(draft)));
			h.state.receipt = `${pr.url}#issuecomment-123`;
			await assert.rejects(h.service.confirm(confirmation(draft)));
			assert.equal(h.posts.length, 1);
		} finally {
			h.service.dispose();
		}
	}
});

test("bounded capacity never evicts drafts, unknown attempts or pre-registration cancellations", async () => {
	const h = harness(2);
	try {
		const first = await h.service.create(input);
		await h.service.create({ ...input, requestId: "create-2" });
		await assert.rejects(h.service.create({ ...input, requestId: "create-3" }), /capacity/);
		h.service.cancel("cancel-1");
		h.service.cancel("cancel-2");
		h.service.cancel("overflow");
		await assert.rejects(h.service.confirm(confirmation(first)), /cancelled/);
		assert.equal(h.posts.length, 0);
		h.service.invalidate();
		await assert.rejects(h.service.confirm(confirmation(first)), /unavailable/);
	} finally {
		h.service.dispose();
	}
});
