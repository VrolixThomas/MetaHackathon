import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256 } from "../../../../../services/team/protocol";
import {
	type ConversationPRContext,
	PRFixDetailSchema,
	WorkJobSchema,
} from "../../shared/contracts";
import { localFixProposal } from "./team-proposal-source";

const time = "2026-11-01T00:00:00Z";
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
const feedback = {
	id: `${pr.id}:conversation:42`,
	prId: pr.id,
	author: "reviewer",
	body: "Handle empty inputs.",
	url: `${pr.url}#issuecomment-42`,
	createdAt: time,
	updatedAt: time,
	kind: "conversation",
	state: null,
	path: null,
	line: null,
	commitSha: null,
	suggestion: null,
};
const scope = {
	orgId: "10000000-0000-4000-8000-000000000001",
	repositoryId: "77",
	repository: pr.repository,
	analysisVersion: "review-v1",
};
const before = "\ufeffbefore\r\n";
const after = "\ufeffafter\r\n";
const candidate = "c".repeat(40);
function fixture() {
	const checks = [
		{
			id: "check",
			command: "node",
			args: ["check.cjs"],
			commitSha: candidate,
			startedAt: time,
			finishedAt: time,
			exitCode: 0,
			logId: "log",
		},
	];
	const job = WorkJobSchema.parse({
		id: "job",
		ticket: null,
		repositoryId: pr.repository,
		repository: pr.repository,
		state: "ready",
		branch: "muse/fix",
		worktreePath: "/controlled/owned/worktree",
		baseSha: pr.headSha,
		headSha: candidate,
		brief: "Controlled fix",
		summary: "Changed",
		createdAt: time,
		updatedAt: time,
		decisions: [],
		checks,
		changedFiles: ["entry.ts"],
		pullRequest: pr,
		error: null,
	});
	return PRFixDetailSchema.parse({
		fix: {
			id: "fix",
			jobId: job.id,
			pr,
			feedback,
			phase: "ready",
			summary: "Controlled",
			question: null,
			baseSha: pr.headSha,
			headSha: candidate,
			checks,
			changedFiles: ["entry.ts"],
			createdAt: time,
			updatedAt: time,
			reviewedAt: time,
			error: null,
			publication: "not-published",
		},
		review: {
			job,
			files: [
				{
					path: "entry.ts",
					status: "modified",
					patch: "@@ -1 +1 @@\n-before\n+after",
					base: { path: "entry.ts", commitSha: pr.headSha, status: "available", content: before },
					head: { path: "entry.ts", commitSha: candidate, status: "available", content: after },
				},
			],
		},
	});
}
const context: ConversationPRContext = {
	pr,
	description: "Controlled source",
	files: [
		{
			path: "entry.ts",
			status: "modified",
			additions: 1,
			deletions: 1,
			patch: "@@ -1 +1 @@\n-before\n+after",
		},
	],
	truncated: false,
};
test("sharing exports exact reviewed UTF8 bytes and actual source identity without private runtime paths", async () => {
	const result = await localFixProposal(
		fixture(),
		scope,
		{ context: async () => context, log: async () => "controlled check output\n" },
		new AbortController().signal
	);
	assert.equal(result.files[0]?.before?.text, before);
	assert.equal(result.files[0]?.after?.text, after);
	assert.equal(result.files[0]?.after?.sha256, sha256(after));
	assert.equal(result.feedback.id, "42");
	assert.equal(result.feedback.kind, "issue-comment");
	assert.equal(result.baseSha, pr.headSha);
	assert.equal(result.candidateSha, candidate);
	assert.ok(!JSON.stringify(result).includes("/controlled/owned"));
});
test("unreviewed or stale local candidates cannot be silently shared", async () => {
	const detail = fixture();
	detail.fix.reviewedAt = null;
	await assert.rejects(
		localFixProposal(
			detail,
			scope,
			{ context: async () => context, log: async () => "" },
			new AbortController().signal
		),
		/reviewed/
	);
	await assert.rejects(
		localFixProposal(
			fixture(),
			scope,
			{
				context: async () => ({ ...context, pr: { ...pr, headSha: "d".repeat(40) } }),
				log: async () => "",
			},
			new AbortController().signal
		),
		/head changed/
	);
});
test("a rename exports both exact removal and addition instead of rewriting source paths", async () => {
	const detail = fixture();
	const file = detail.review?.files[0];
	if (!file) throw Error("fixture");
	file.status = "renamed";
	file.head.path = "renamed.ts";
	file.path = "renamed.ts";
	const result = await localFixProposal(
		detail,
		scope,
		{ context: async () => context, log: async () => "" },
		new AbortController().signal
	);
	assert.deepEqual(
		result.files.map((f) => [f.path, !!f.before, !!f.after]),
		[
			["entry.ts", true, false],
			["renamed.ts", false, true],
		]
	);
});
