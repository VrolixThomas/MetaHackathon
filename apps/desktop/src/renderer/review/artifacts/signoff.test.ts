import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConfirmCommentInput, DraftedComment, Evidence } from "../../../shared/contracts";
import { getReviewFixture } from "../../../shared/fixtures/review";
import type { ReviewFile } from "../model";
import type { DraftAdapter } from "../services";
import { SignoffArtifact } from "./SignoffArtifact";
import {
	SignoffDraftSession,
	draftContextError,
	reviewCoverage,
	signoffSession,
} from "./signoff-model";

function liveReview() {
	const fixture = getReviewFixture();
	const evidence: Evidence = {
		kind: "source",
		url: fixture.preparation.pr.url,
		retrievedAt: "2026-10-26T12:00:00Z",
	};
	return {
		preparation: { ...fixture.preparation, evidence },
		draft: { ...fixture.draftComment, evidence },
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function harness() {
	const { preparation, draft } = liveReview();
	const edits: { id: string; body: string }[] = [];
	const confirmations: ConfirmCommentInput[] = [];
	let ids = 0;
	const session = new SignoffDraftSession(draft, preparation, () => `request-${++ids}`);
	const adapter: DraftAdapter = {
		edit: async (id, body) => {
			edits.push({ id, body });
			return { ...draft, body, revision: draft.revision + 1 };
		},
		confirm: async (input) => {
			confirmations.push(input);
			return { url: `${preparation.pr.url}#discussion_r42` };
		},
	};
	return { preparation, draft, session, adapter, edits, confirmations };
}

describe("sign-off coverage and presentation", () => {
	it("deduplicates visits, retains unseen triage files, and follows reading order", () => {
		const { preparation } = liveReview();
		const first = preparation.files[0];
		assert.ok(first);
		const files: ReviewFile[] = [
			{
				path: first.path,
				purpose: "Renderer purpose",
				attention: "mechanical",
				additions: 1,
				deletions: 0,
				lines: [],
			},
		];
		const coverage = reviewCoverage(preparation, files, [first.path, first.path, "unrelated.ts"]);
		assert.equal(coverage.total, preparation.files.length);
		assert.equal(coverage.viewed, 1);
		assert.deepEqual(
			coverage.unseen.map((file) => file.path),
			preparation.files
				.filter((file) => file.path !== first.path)
				.sort((a, b) => a.readingOrder - b.readingOrder)
				.map((file) => file.path)
		);
		assert.ok(coverage.unseen.some((file) => file.path.includes("Cache")));
		assert.equal(reviewCoverage(preparation, files, []).unseen[0]?.purpose, "Renderer purpose");
	});
	it("does not treat mechanical labels as viewed or executed and handles an empty review", () => {
		const { preparation } = liveReview();
		assert.equal(reviewCoverage(preparation, [], []).viewed, 0);
		assert.deepEqual(reviewCoverage({ ...preparation, files: [] }, [], ["stale.ts"]), {
			total: 0,
			viewed: 0,
			unseen: [],
		});
	});
	it("renders original words, editable body, coverage and source navigation without posting fixtures", () => {
		const fixture = getReviewFixture();
		const html = renderToStaticMarkup(
			createElement(SignoffArtifact, {
				preparation: fixture.preparation,
				files: [],
				seen: [],
				drafts: [fixture.draftComment],
				onOpenFile: () => {},
				onDraftChange: () => {},
				adapter: harness().adapter,
			})
		);
		assert.ok(html.includes(fixture.draftComment.originalWords));
		assert.ok(html.includes(fixture.draftComment.body));
		assert.ok(html.includes("textarea"));
		assert.ok(html.includes("open source"));
		assert.ok(html.includes("Still unseen"));
		assert.ok(html.includes("Nothing can be posted"));
		assert.ok(!html.includes("Post confirmed comment"));
	});
});

describe("sign-off confirmation boundary", () => {
	it("requires explicit consent and sends the exact saved ID, body, revision and current head", async () => {
		const h = harness();
		await h.session.post(h.adapter);
		assert.equal(h.confirmations.length, 0);
		h.session.setConsent(true);
		await h.session.post(h.adapter);
		assert.deepEqual(h.confirmations, [
			{
				requestId: "request-1",
				draftId: h.draft.id,
				draftRevision: h.draft.revision,
				body: h.draft.body,
				headSha: h.preparation.pr.headSha,
				confirmed: true,
			},
		]);
		assert.equal(h.session.getSnapshot().phase, "posted");
		h.session.setConsent(true);
		await h.session.post(h.adapter);
		assert.equal(h.confirmations.length, 1);
	});
	it("invalidates consent on any edit, even an edit reverted to the saved text", async () => {
		const h = harness();
		h.session.setConsent(true);
		h.session.setBody("Changed");
		assert.equal(h.session.canConfirm, false);
		h.session.setConsent(true);
		await h.session.post(h.adapter);
		h.session.setBody(h.draft.body);
		assert.equal(h.session.confirmed, false);
		await h.session.post(h.adapter);
		assert.equal(h.confirmations.length, 0);
	});
	it("saves live edits first and requires new consent for the authoritative returned body and revision", async () => {
		const h = harness();
		h.session.setConsent(true);
		h.session.setBody("Local edit");
		h.adapter.edit = async (id, body) => {
			h.edits.push({ id, body });
			return { ...h.draft, revision: 9, body: "Authoritative returned wording" };
		};
		await h.session.post(h.adapter);
		const result = await h.session.save(h.adapter);
		assert.equal(result?.revision, 9);
		assert.deepEqual(h.edits, [{ id: h.draft.id, body: "Local edit" }]);
		assert.equal(h.session.getSnapshot().body, "Authoritative returned wording");
		assert.equal(h.session.confirmed, false);
		await h.session.post(h.adapter);
		assert.equal(h.confirmations.length, 0);
		h.session.setConsent(true);
		await h.session.post(h.adapter);
		assert.equal(h.confirmations[0]?.body, result?.body);
		assert.equal(h.confirmations[0]?.draftRevision, 9);
	});
	it("blocks fixture drafts and fixture preparations even when a real adapter exists", async () => {
		const fixture = getReviewFixture();
		for (const fixtureDraft of [true, false]) {
			const h = harness();
			const session: SignoffDraftSession = new SignoffDraftSession(
				fixtureDraft ? fixture.draftComment : h.draft,
				fixtureDraft ? h.preparation : fixture.preparation
			);
			session.setConsent(true);
			await session.post(h.adapter);
			session.setBody("Local fixture edit");
			const result = await session.save(h.adapter);
			assert.equal(h.edits.length, 0);
			assert.equal(h.confirmations.length, 0);
			if (fixtureDraft) {
				assert.equal(result?.evidence.kind, "fixture");
				assert.equal(result?.revision, 2);
			} else assert.equal(result, null);
		}
	});
	it("fails closed without an adapter or for whitespace-only content", async () => {
		const h = harness();
		h.session.setConsent(true);
		await h.session.post(null);
		h.session.setBody("   ");
		assert.equal(await h.session.save(h.adapter), null);
		h.session.setConsent(true);
		await h.session.post(h.adapter);
		assert.equal(h.edits.length, 0);
		assert.equal(h.confirmations.length, 0);
	});
	it("resets consent for changed draft ID, revision, body, or head, including change-and-restore", async () => {
		const h = harness();
		for (const patch of [
			{ id: "another-draft" },
			{ revision: 2 },
			{ body: "Reworded" },
			{ headSha: "a".repeat(40) },
		]) {
			h.session.setConsent(true);
			h.session.sync({ ...h.draft, ...patch }, h.preparation);
			assert.equal(h.session.confirmed, false);
			h.session.sync(h.draft, h.preparation);
			assert.equal(h.session.confirmed, false);
			await h.session.post(h.adapter);
		}
		h.session.setConsent(true);
		h.session.sync(h.draft, {
			...h.preparation,
			pr: { ...h.preparation.pr, headSha: "a".repeat(40) },
		});
		assert.equal(h.session.canConfirm, false);
		h.session.sync(h.draft, h.preparation);
		assert.equal(h.session.confirmed, false);
		assert.equal(h.confirmations.length, 0);
	});
	it("rejects foreign PRs, stale or foreign source locations, and unready preparations", () => {
		const { draft, preparation } = liveReview();
		assert.ok(draft.location);
		assert.ok(draftContextError({ ...draft, prId: "other-pr" }, preparation));
		for (const patch of [
			{ repository: "other/repo" },
			{ commitSha: "b".repeat(40) },
			{ path: "missing.ts" },
		]) {
			const session: SignoffDraftSession = new SignoffDraftSession(
				{ ...draft, location: { ...draft.location, ...patch } },
				preparation
			);
			session.setConsent(true);
			assert.equal(session.confirmed, false);
		}
		assert.ok(draftContextError(draft, { ...preparation, status: "preparing" }));
		assert.equal(
			draftContextError(
				{
					...draft,
					location: { ...draft.location, revision: "base", commitSha: preparation.pr.baseSha },
				},
				preparation
			),
			null
		);
	});
});

describe("sign-off async failures and idempotency", () => {
	it("locks repeated save clicks and drops late edit responses after a head change", async () => {
		const h = harness();
		const pending = deferred<DraftedComment>();
		let calls = 0;
		h.adapter.edit = () => {
			calls++;
			return pending.promise;
		};
		h.session.setBody("Save me");
		const first = h.session.save(h.adapter);
		await h.session.save(h.adapter);
		assert.equal(calls, 1);
		h.session.sync(h.draft, {
			...h.preparation,
			pr: { ...h.preparation.pr, headSha: "c".repeat(40) },
		});
		pending.resolve({ ...h.draft, revision: 2, body: "Stale result" });
		assert.equal(await first, null);
		assert.notEqual(h.session.getSnapshot().body, "Stale result");
		assert.equal(h.session.canConfirm, false);
	});
	it("preserves unsaved edits, redacts provider errors, and rejects invalid edit responses", async () => {
		const changes = [
			{ revision: 1 },
			{ id: "wrong" },
			{ prId: "wrong" },
			{ headSha: "d".repeat(40) },
			{ originalWords: "Replaced" },
			{ evidence: getReviewFixture().draftComment.evidence },
		];
		for (const change of changes) {
			const h = harness();
			h.session.setBody("My unsaved wording");
			h.adapter.edit = async () => ({ ...h.draft, revision: 2, ...change });
			assert.equal(await h.session.save(h.adapter), null);
			assert.equal(h.session.getSnapshot().body, "My unsaved wording");
			assert.equal(h.session.confirmed, false);
		}
		const h = harness();
		h.session.setBody("Keep me");
		h.adapter.edit = async () => {
			throw new Error("Bearer secret-token");
		};
		await h.session.save(h.adapter);
		assert.ok(!h.session.getSnapshot().error.includes("secret-token"));
		assert.equal(h.session.getSnapshot().body, "Keep me");
	});
	it("locks double posts, never retries automatically, and reuses the exact request after ambiguous failure", async () => {
		const h = harness();
		const pending = deferred<{ url: string }>();
		h.adapter.confirm = (input) => {
			h.confirmations.push(input);
			return pending.promise;
		};
		h.session.setConsent(true);
		const first = h.session.post(h.adapter);
		h.session.setConsent(true);
		await h.session.post(h.adapter);
		assert.equal(h.confirmations.length, 1);
		pending.reject(new Error("Authorization secret-token"));
		await first;
		assert.equal(h.session.getSnapshot().phase, "uncertain");
		assert.ok(!h.session.getSnapshot().error.includes("secret-token"));
		assert.equal(h.session.canEdit, false);
		h.session.setBody("Do not lose the original request");
		assert.equal(h.session.getSnapshot().body, h.draft.body);
		await h.session.post(h.adapter);
		assert.equal(h.confirmations.length, 1);
		h.adapter.confirm = async (input) => {
			h.confirmations.push(input);
			return { url: `${h.preparation.pr.url}#discussion_r42` };
		};
		h.session.setConsent(true);
		await h.session.post(h.adapter);
		assert.equal(h.confirmations.length, 2);
		assert.deepEqual(h.confirmations[1], h.confirmations[0]);
	});
	it("retains the in-flight lock and original request across panel session lookups", async () => {
		const h = harness();
		const draft = { ...h.draft, id: "remount-lock-test" };
		const session = signoffSession(draft, h.preparation);
		const pending = deferred<{ url: string }>();
		h.adapter.confirm = (input) => {
			h.confirmations.push(input);
			return pending.promise;
		};
		session.setConsent(true);
		const first = session.post(h.adapter);
		const remounted = signoffSession(draft, h.preparation);
		assert.equal(remounted, session);
		remounted.setConsent(false);
		await remounted.post(h.adapter);
		pending.reject(new Error("Connection lost"));
		await first;
		assert.equal(remounted.getSnapshot().phase, "uncertain");
		assert.equal(remounted.getSnapshot().request?.requestId, h.confirmations[0]?.requestId);
		assert.equal(h.confirmations.length, 1);
	});
	it("does not retry a retained request against a new head or changed draft revision", async () => {
		const h = harness();
		h.adapter.confirm = async (input) => {
			h.confirmations.push(input);
			throw new Error("Lost response");
		};
		h.session.setConsent(true);
		await h.session.post(h.adapter);
		const request = h.session.getSnapshot().request;
		h.session.sync({ ...h.draft, revision: 2 }, h.preparation);
		h.session.setConsent(true);
		await h.session.post(h.adapter);
		assert.equal(h.confirmations.length, 1);
		assert.equal(h.session.getSnapshot().request, request);
		assert.ok(h.session.getSnapshot().error.includes("may already exist"));
	});
	it("attributes late posting success to the submitted revision, not a newly received draft", async () => {
		const h = harness();
		const pending = deferred<{ url: string }>();
		h.adapter.confirm = () => pending.promise;
		h.session.setConsent(true);
		const first = h.session.post(h.adapter);
		h.session.sync({ ...h.draft, revision: 3, body: "New draft body" }, h.preparation);
		pending.resolve({ url: `${h.preparation.pr.url}#discussion_r42` });
		await first;
		assert.ok(h.session.getSnapshot().notice.includes("revision 1 posted"));
		assert.equal(h.session.getSnapshot().draft.revision, 3);
		assert.equal(h.session.canConfirm, false);
	});
	it("never renders unsafe or foreign success URLs and retains the original request", async () => {
		for (const url of [
			"javascript:alert(1)",
			"https://evil.test/pull/1284",
			"https://github.com/other/repo/pull/1",
			"not a url",
		]) {
			const h = harness();
			h.adapter.confirm = async () => ({ url });
			h.session.setConsent(true);
			await h.session.post(h.adapter);
			assert.equal(h.session.getSnapshot().url, null);
			assert.equal(h.session.getSnapshot().phase, "uncertain");
			assert.equal(h.session.getSnapshot().request?.requestId, "request-1");
		}
	});
});
