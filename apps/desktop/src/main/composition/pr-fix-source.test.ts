import assert from "node:assert/strict";
import { test } from "node:test";
import { getReviewFixture } from "../../shared/fixtures/review";
import { sourceFromPRFix } from "./pr-fix-source";

function candidate() {
	const pr = getReviewFixture().preparation.pr;
	const head = "c".repeat(40);
	const time = "2026-10-31T12:00:00Z";
	const feedback = {
		id: "feedback",
		prId: pr.id,
		author: "peer",
		body: "Correct the total",
		url: pr.url,
		createdAt: time,
		updatedAt: time,
		kind: "inline" as const,
		state: null,
		path: "total.ts",
		line: 1,
		commitSha: pr.headSha,
		suggestion: null,
	};
	const fix = {
		id: "fix",
		jobId: "job",
		pr,
		feedback,
		phase: "ready" as const,
		summary: "Local correction",
		question: null,
		baseSha: pr.headSha,
		headSha: head,
		checks: [],
		changedFiles: ["total.ts"],
		createdAt: time,
		updatedAt: time,
		reviewedAt: null,
		error: null,
		publication: "not-published" as const,
	};
	const job = {
		id: "job",
		ticket: null,
		feedback,
		repositoryId: "repo",
		repository: pr.repository,
		state: "ready" as const,
		branch: "muse/fix",
		worktreePath: null,
		baseSha: pr.headSha,
		headSha: head,
		brief: feedback.body,
		summary: fix.summary,
		createdAt: time,
		updatedAt: time,
		decisions: [],
		checks: [],
		changedFiles: fix.changedFiles,
		pullRequest: pr,
		error: null,
	};
	const file = {
		path: "total.ts",
		status: "modified" as const,
		patch: "@@ -1 +1 @@\n-old\n+new\n",
		base: {
			path: "total.ts",
			commitSha: pr.headSha,
			status: "available" as const,
			content: "old\r\nrest\r\n",
		},
		head: {
			path: "total.ts",
			commitSha: head,
			status: "available" as const,
			content: "new\r\nrest\r\n",
		},
	};
	return {
		detail: { fix, review: { job, files: [file] } },
		location: {
			repository: pr.repository,
			revision: "head" as const,
			commitSha: head,
			path: file.path,
			startLine: 1,
			endLine: 2,
		},
	};
}

test("isolated candidate source preserves exact CRLF and pinned inclusive lines", () => {
	const { detail, location } = candidate();
	const source = sourceFromPRFix(detail, location);
	assert.equal(source.text, "new\r\nrest\r\n");
	assert.deepEqual(source.location, location);
	assert.equal(
		sourceFromPRFix(detail, { ...location, startLine: 2, endLine: 20 }).text,
		"rest\r\n"
	);
	assert.equal(
		sourceFromPRFix(detail, { ...location, startLine: 2, endLine: 20 }).location.endLine,
		2
	);
	assert.equal(
		sourceFromPRFix(detail, { ...location, revision: "base", commitSha: detail.fix.baseSha }).text,
		"old\r\nrest\r\n"
	);
});

test("candidate reads reject a different revision, missing path, oversized range and unavailable text", () => {
	const { detail, location } = candidate();
	for (const bad of [
		{ ...location, commitSha: "d".repeat(40) },
		{ ...location, path: "missing.ts" },
		{ ...location, endLine: 501 },
		{ ...location, startLine: 3, endLine: 3 },
	])
		assert.throws(() => sourceFromPRFix(detail, bad));
	assert.throws(() =>
		sourceFromPRFix(
			{
				...detail,
				review: { ...detail.review, job: { ...detail.review.job, headSha: "d".repeat(40) } },
			},
			location
		)
	);
	assert.throws(() => sourceFromPRFix({ ...detail, review: null }, location));
});
