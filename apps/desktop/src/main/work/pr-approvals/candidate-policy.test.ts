import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { evaluatePolicy } from ".";
import type { PRFixDetail } from "../../../shared/contracts";
import { reviewedFixTerms } from "./candidate-policy";
import { at, head, later, observation, policy, pr, terms } from "./test-support";

function candidate(): PRFixDetail {
	const time = new Date(at).toISOString();
	const feedback = {
		id: "feedback",
		prId: pr.id,
		author: "reviewer",
		body: "Fix this",
		url: pr.url,
		createdAt: time,
		updatedAt: time,
		kind: "inline" as const,
		state: null,
		path: "a.ts",
		line: 1,
		commitSha: head,
		suggestion: null,
	};
	const fix = {
		id: "fix",
		jobId: "job",
		pr,
		feedback,
		phase: "ready" as const,
		summary: "",
		question: null,
		baseSha: head,
		headSha: later,
		checks: [],
		changedFiles: ["a.ts"],
		createdAt: time,
		updatedAt: time,
		reviewedAt: time,
		error: null,
		publication: "not-published" as const,
	};
	return {
		fix,
		review: {
			job: {
				id: "job",
				ticket: null,
				feedback: structuredClone(feedback),
				repositoryId: "repo",
				repository: pr.repository,
				state: "ready",
				branch: "private/fix",
				worktreePath: null,
				baseSha: head,
				headSha: later,
				brief: "Fix",
				summary: "",
				createdAt: time,
				updatedAt: time,
				decisions: [],
				checks: [],
				changedFiles: ["a.ts"],
				pullRequest: null,
				error: null,
			},
			files: [
				{
					path: "a.ts",
					status: "modified",
					patch: null,
					base: { path: "a.ts", commitSha: head, status: "available", content: "before\n" },
					head: { path: "a.ts", commitSha: later, status: "available", content: "\uFEFFafter\r\n" },
				},
			],
		},
	};
}
const input = {
	candidateId: "fix",
	action: terms.action,
	expiresAt: terms.expiresAt,
	checks: [{ kind: "check" as const, name: "regression", appId: 42 }],
};
test("complete candidate bytes become source conditions; evaluator blocks extra files and edits", () => {
	const detail = candidate();
	const result = reviewedFixTerms(detail, pr, input);
	assert.equal(result.conditions.length, 2);
	assert.deepEqual(result.conditions[0], {
		kind: "source",
		path: "a.ts",
		expectedContent: "\uFEFFafter\r\n",
		reason:
			"Exact complete contents of the privately reviewed fix; other changes require renewed review.",
	});
	const p = policy({ terms: result });
	const o = observation({
		headSha: later,
		changes: [{ path: "a.ts", status: "modified" }],
		sources: [{ path: "a.ts", content: "\uFEFFafter\r\n" }],
	});
	assert.equal(evaluatePolicy(p, o, at).outcome, "satisfied");
	assert.equal(
		evaluatePolicy(
			p,
			{ ...o, changes: [...o.changes, { path: "unexpected.ts", status: "added" }] },
			at
		).outcome,
		"needs-review"
	);
	assert.equal(
		evaluatePolicy(p, { ...o, sources: [{ path: "a.ts", content: "extra edit\n" }] }, at).outcome,
		"needs-review"
	);
});
function review(d: PRFixDetail) {
	assert.ok(d.review);
	return d.review;
}
function file(d: PRFixDetail) {
	const f = review(d).files[0];
	assert.ok(f);
	return f;
}
const invalid: Record<string, (d: PRFixDetail) => void> = {
	unreviewed: (d) => {
		d.fix.reviewedAt = null;
	},
	changedHead: (d) => {
		d.fix.headSha = "d".repeat(40);
	},
	staleFeedback: (d) => {
		if (d.review?.job.feedback) d.review.job.feedback.body = "edited";
	},
	missingFile: (d) => {
		d.fix.changedFiles.push("missing.ts");
	},
	missingJobFile: (d) => {
		review(d).job.changedFiles = [];
	},
	duplicate: (d) => {
		review(d).files.push(file(d));
	},
	wrongSourcePin: (d) => {
		file(d).head.commitSha = head;
	},
	wrongPath: (d) => {
		file(d).head.path = "other.ts";
	},
	binary: (d) => {
		file(d).head.status = "binary";
	},
	missingBytes: (d) => {
		file(d).head.content = null;
	},
	removed: (d) => {
		file(d).status = "removed";
	},
	renamed: (d) => {
		file(d).status = "renamed";
	},
	oversized: (d) => {
		file(d).head.content = "a".repeat(30001);
	},
	noFiles: (d) => {
		d.fix.changedFiles = [];
		review(d).files = [];
		review(d).job.changedFiles = [];
	},
};
for (const [name, mutate] of Object.entries(invalid))
	test(`rejects ${name} without a partial policy`, () => {
		const d = structuredClone(candidate());
		mutate(d);
		assert.throws(() => reviewedFixTerms(d, pr, input));
	});
test("rejects other original PR and condition overflow", () => {
	assert.throws(() => reviewedFixTerms(candidate(), { ...pr, headSha: later }, input));
	assert.throws(() =>
		reviewedFixTerms(candidate(), pr, {
			...input,
			checks: Array.from({ length: 10 }, (_, i) => ({
				kind: "check",
				name: `check-${i}`,
				appId: null,
			})),
		})
	);
});

test("all files including an empty added file are included in deterministic path order", () => {
	const d = candidate();
	d.fix.changedFiles.push("0.txt");
	review(d).job.changedFiles.push("0.txt");
	review(d).files.push({
		path: "0.txt",
		status: "added",
		patch: null,
		base: { path: "0.txt", commitSha: head, status: "missing", content: null },
		head: { path: "0.txt", commitSha: later, status: "available", content: "" },
	});
	const result = reviewedFixTerms(d, pr, input);
	assert.deepEqual(
		result.conditions.filter((c) => c.kind === "source").map((c) => [c.path, c.expectedContent]),
		[
			["0.txt", ""],
			["a.ts", "\uFEFFafter\r\n"],
		]
	);
});

test("real MuseFocus attention files form one complete policy with exact source pins and no extra changes", () => {
	const d = candidate();
	const paths = [
		"main/work/attention.ts",
		"main/work/attention.test.ts",
		"renderer/conversation/attention.ts",
		"renderer/conversation/attention.test.ts",
	].map((p) => `apps/desktop/src/${p}`);
	const files = paths.map((path) => ({
		path,
		status: "modified" as const,
		patch: null,
		base: { path, commitSha: head, status: "available" as const, content: "before\n" },
		head: {
			path,
			commitSha: later,
			status: "available" as const,
			content: readFileSync(new URL(`../../../../../../${path}`, import.meta.url), "utf8"),
		},
	}));
	assert.ok(files.reduce((n, f) => n + Buffer.byteLength(f.head.content), 0) > 45000);
	d.fix.changedFiles = paths;
	review(d).job.changedFiles = paths;
	review(d).files = files;
	const result = reviewedFixTerms(d, pr, input);
	const sourceConditions = result.conditions.filter((c) => c.kind === "source");
	assert.equal(sourceConditions.length, files.length);
	for (const f of files)
		assert.equal(sourceConditions.find((c) => c.path === f.path)?.expectedContent, f.head.content);
	const p = policy({ terms: result });
	const o = observation({
		headSha: later,
		changes: files.map((f) => ({ path: f.path, status: f.status })),
		sources: files.map((f) => ({ path: f.path, content: f.head.content })),
	});
	assert.equal(evaluatePolicy(p, o, at).outcome, "satisfied");
	assert.equal(
		evaluatePolicy(p, { ...o, changes: [...o.changes, { path: "extra.ts", status: "added" }] }, at)
			.outcome,
		"needs-review"
	);
	const changed = structuredClone(p);
	const first = changed.terms.conditions.find((c) => c.kind === "source");
	assert.ok(first && first.kind === "source");
	first.expectedContent += "\n";
	assert.notEqual(policy(changed).digest, p.digest);
	const firstFile = files[0];
	assert.ok(firstFile);
	firstFile.head.commitSha = head;
	assert.throws(() => reviewedFixTerms(d, pr, input));
});

test("complete candidate aggregate overflow rejects rather than dropping files or checks", () => {
	const d = candidate();
	const files = Array.from({ length: 5 }, (_, i) => ({
		path: `src/large-${i}.ts`,
		status: "modified" as const,
		patch: null,
		base: {
			path: `src/large-${i}.ts`,
			commitSha: head,
			status: "available" as const,
			content: "before\n",
		},
		head: {
			path: `src/large-${i}.ts`,
			commitSha: later,
			status: "available" as const,
			content: "x".repeat(30000),
		},
	}));
	d.fix.changedFiles = files.map((f) => f.path);
	review(d).job.changedFiles = d.fix.changedFiles;
	review(d).files = files;
	assert.throws(() => reviewedFixTerms(d, pr, input), /128 KiB/);
	assert.equal(review(d).files.length, 5);
	assert.ok(review(d).files.every((f) => f.head.content?.length === 30000));
});
