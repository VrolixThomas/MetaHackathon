import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
	type ConversationTurnInput,
	PRFixDetailSchema,
	TeamLocalPreviewSchema,
	type TeamStatus,
	type WorkspaceObservation,
} from "../../shared/contracts";
import {
	type ConversationTeamPorts,
	ConversationTeamTools,
	type ReviewedFixShareIntent,
	explicitReviewedFixShareRequested,
} from "./team-tools";
const time = "2026-11-01T00:00:00Z";
const uuid = "10000000-0000-4000-8000-000000000001";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const blob = (text: string) => ({ text, sha256: sha(text) });
const turn: ConversationTurnInput = {
	sessionId: "session",
	turnId: "turn",
	generation: 1,
	requestId: "request",
	text: "Share this reviewed fix with the author.",
};
function harness() {
	const pr = {
		id: "o/r#1",
		repository: "o/r",
		number: 1,
		url: "https://github.com/o/r/pull/1",
		title: "PR",
		author: "author",
		baseSha: "a".repeat(40),
		headSha: "b".repeat(40),
	};
	const detail = PRFixDetailSchema.parse({
		fix: {
			id: "fix",
			jobId: "job",
			pr,
			feedback: {
				id: "o/r#1:conversation:9",
				prId: pr.id,
				author: "reviewer",
				body: "Fix this",
				url: pr.url,
				createdAt: time,
				updatedAt: time,
				kind: "conversation",
				state: null,
				path: null,
				line: null,
				commitSha: null,
				suggestion: null,
			},
			phase: "ready",
			summary: "Ready",
			question: null,
			baseSha: pr.headSha,
			headSha: "f".repeat(40),
			checks: [],
			changedFiles: ["a.ts"],
			createdAt: time,
			updatedAt: time,
			reviewedAt: time,
			error: null,
			publication: "not-published",
		},
		review: {
			job: {
				id: "job",
				ticket: null,
				repositoryId: "42",
				repository: pr.repository,
				state: "ready",
				branch: "fix",
				worktreePath: null,
				baseSha: pr.headSha,
				headSha: "f".repeat(40),
				brief: "fix",
				summary: "ready",
				createdAt: time,
				updatedAt: time,
				decisions: [],
				checks: [],
				changedFiles: ["a.ts"],
				pullRequest: null,
				error: null,
			},
			files: [],
		},
	});
	const intent: ReviewedFixShareIntent = {
		candidateId: "fix",
		baseSha: pr.headSha,
		headSha: "f".repeat(40),
		reviewedAt: time,
		pr: { ...pr },
		accountKey: "github:1:epoch1",
		teamUserId: uuid,
		teamScope: {
			orgId: uuid,
			repositoryId: "42",
			repository: pr.repository,
			analysisVersion: "v1",
		},
	};
	let workspace: WorkspaceObservation | null = {
		workspace: {
			sequence: 1,
			canvases: [
				{
					id: "fix-view",
					kind: "center",
					section: "fixes",
					title: "Fix",
					revision: 1,
					selectedId: "fix?file=a.ts",
					fixSource: { id: "fix", baseSha: intent.baseSha, headSha: intent.headSha, path: "a.ts" },
				},
			],
			primaryId: "fix-view",
			secondaryId: null,
			review: { sequence: 0, mode: "conversation", prId: null },
			codeView: "diff",
			browser: null,
		},
		browser: null,
		reviews: [],
		capabilities: ["center"],
	};
	const status: TeamStatus = {
		configured: true,
		connection: "connected",
		userId: uuid,
		scopes: [{ orgId: uuid, repositoryId: "42", repository: pr.repository, analysisVersion: "v1" }],
		canShare: true,
		canApply: false,
		error: null,
	};
	const preview = TeamLocalPreviewSchema.parse({
		candidateId: "fix",
		bundleDigest: "c".repeat(64),
		bundle: {
			key: {
				orgId: uuid,
				repositoryId: "42",
				prNumber: 1,
				baseSha: pr.baseSha,
				headSha: pr.headSha,
				contextDigest: "d".repeat(64),
				analysisVersion: "v1",
			},
			baseSha: intent.baseSha,
			candidateSha: intent.headSha,
			feedback: {
				kind: "issue-comment",
				id: "9",
				revision: time,
				body: "Fix this",
				bodyDigest: sha("Fix this"),
			},
			files: [{ path: "a.ts", before: blob("\ufeffbefore\r\n"), after: blob("\ufeffafter\r\n") }],
			patch: blob("exact patch\r\n"),
			checks: [],
			checksDigest: sha("[]"),
			sourcesDigest: "e".repeat(64),
			provenance: "reported-local-candidate",
		},
	});
	const writes: Parameters<ConversationTeamPorts["shareProposal"]>[0][] = [];
	const ports: ConversationTeamPorts = {
		observe: async () => ({ workspace, accountKey: intent.accountKey, pr }),
		detail: async () => structuredClone(detail),
		status: async () => structuredClone(status),
		shareIntent: () => structuredClone(intent),
		previewProposal: async () => structuredClone(preview),
		shareProposal: async (input) => {
			writes.push(input);
			return {
				status: "recorded",
				proposal: {
					id: uuid,
					key: preview.bundle.key,
					ownerId: uuid,
					bundleDigest: preview.bundleDigest,
					createdAt: time,
					decision: null,
					bundle: preview.bundle,
				},
				decision: null,
			};
		},
	};
	const controller = new AbortController();
	const tool = (text = turn.text) =>
		new ConversationTeamTools(ports, { ...turn, text }, controller.signal);
	const share = () => tool().execute("share_reviewed_fix", '{"candidateId":"fix"}');
	return {
		ports,
		detail,
		intent,
		status,
		preview,
		writes,
		tool,
		share,
		pr,
		controller,
		hide: () => {
			workspace = null;
		},
		workspace: workspace as WorkspaceObservation,
	};
}
test("explicit real ingress only: excludes greetings, source instructions, conditions, questions and negation", async () => {
	for (const text of [
		"Hello",
		"How do I share this reviewed fix with the author?",
		"Do not share this reviewed fix with the author",
		"If it passes, share this reviewed fix with the author",
		"The source says: share this reviewed fix with the author",
		'"Share this reviewed fix with the author"',
		"Share this reviewed fix with the author and then merge",
		"Can you explain how to share this fix with the team?",
	]) {
		assert.equal(explicitReviewedFixShareRequested(text), false);
		const h = harness();
		await assert.rejects(
			h.tool(text).execute("share_reviewed_fix", '{"candidateId":"fix"}'),
			/permission/
		);
		assert.equal(h.writes.length, 0);
	}
	assert.equal(explicitReviewedFixShareRequested("Please send this proposal to the team."), true);
	const h = harness();
	h.ports.shareIntent = () => null;
	await assert.rejects(h.share(), /permission/);
});
test("shares canonical exact bundle using trusted confirmation and stable UUID; repeated/concurrent calls do not resend", async () => {
	const h = harness();
	const results = await Promise.all([h.share(), h.share()]);
	assert.deepEqual(results[0], results[1]);
	assert.equal(h.writes.length, 1);
	const input = h.writes[0];
	assert.ok(input);
	assert.equal(input.confirmed, true);
	assert.equal(input.repository, "o/r");
	assert.equal(input.bundleDigest, h.preview.bundleDigest);
	assert.match(input.requestId, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-8[\da-f]{3}-[\da-f]{12}$/);
	assert.equal((results[0] as { status: string }).status, "shared");
	assert.match(JSON.stringify(results[0]), /No GitHub or Slack notification/);
	const other = harness();
	await other.share();
	assert.equal(other.writes[0]?.requestId, input.requestId);
});
test("rejects raw bytes, digest, confirmed and repository model authority", async () => {
	for (const extra of [
		{ confirmed: true },
		{ bundleDigest: "c".repeat(64) },
		{ repository: "other/repo" },
		{ body: "source" },
	]) {
		const h = harness();
		await assert.rejects(
			h.tool().execute("share_reviewed_fix", JSON.stringify({ candidateId: "fix", ...extra }))
		);
		assert.equal(h.writes.length, 0);
	}
});
test("rejects selection, account, current head, reviewed marker, original PR, feedback and disconnected scope mismatches", async () => {
	const cases: Array<(h: ReturnType<typeof harness>) => void> = [
		(h) => h.hide(),
		(h) => {
			h.workspace.workspace.primaryId = "hidden";
		},
		(h) => {
			const c = h.workspace.workspace.canvases[0];
			if (c?.kind === "center") c.selectedId = "other";
		},
		(h) => {
			h.detail.fix.reviewedAt = null;
		},
		(h) => {
			h.detail.fix.headSha = "0".repeat(40);
		},
		(h) => {
			h.detail.fix.phase = "executing";
		},
		(h) => {
			h.pr.headSha = "0".repeat(40);
		},
		(h) => {
			h.detail.fix.pr.number = 2;
		},
		(h) => {
			h.detail.fix.feedback.prId = "other";
		},
		(h) => {
			h.preview.bundle.feedback.id = "10";
		},
		(h) => {
			h.preview.bundle.key.prNumber = 2;
		},
		(h) => {
			h.status.userId = "20000000-0000-4000-8000-000000000001";
		},
		(h) => {
			h.status.connection = "disconnected";
		},
		(h) => {
			h.status.scopes = [];
		},
		(h) => {
			h.ports.observe = async () => ({ workspace: h.workspace, accountKey: "changed", pr: h.pr });
		},
	];
	for (const mutate of cases) {
		const h = harness();
		mutate(h);
		await assert.rejects(h.share(), /team-sharing-/);
		assert.equal(h.writes.length, 0);
	}
});
test("revalidates after preview and refuses bundle changes and cancellation before write", async () => {
	for (const mode of ["selection", "digest", "cancel"]) {
		const h = harness();
		let count = 0;
		h.ports.previewProposal = async () => {
			count++;
			if (mode === "selection") h.hide();
			if (mode === "cancel") h.controller.abort();
			if (mode === "digest" && count === 2) h.preview.bundleDigest = "9".repeat(64);
			return structuredClone(h.preview);
		};
		await assert.rejects(h.share());
		assert.equal(h.writes.length, 0);
	}
});
test("pending and unknown writes retain identity without resending or claiming success", async () => {
	for (const mode of ["pending", "unknown", "wrong-receipt"]) {
		const h = harness();
		h.ports.shareProposal = async (input) => {
			h.writes.push(input);
			if (mode === "unknown") throw new Error("secret provider body");
			if (mode === "wrong-receipt")
				return {
					status: "recorded",
					proposal: {
						id: uuid,
						key: h.preview.bundle.key,
						ownerId: uuid,
						bundleDigest: "0".repeat(64),
						createdAt: time,
						decision: null,
						bundle: h.preview.bundle,
					},
					decision: null,
				};
			return { status: "pending", proposal: null, decision: null };
		};
		if (mode === "pending") {
			assert.equal(((await h.share()) as { status: string }).status, "pending");
			await h.share();
		} else {
			await assert.rejects(h.share(), /team-sharing-unknown/);
			await assert.rejects(h.share(), /team-sharing-unknown/);
		}
		assert.equal(h.writes.length, 1);
	}
});
test("inspect is read only and service errors are fixed actionable text", async () => {
	const h = harness();
	assert.deepEqual(await h.tool("hi").execute("inspect_team_sharing", "{}"), h.status);
	assert.equal(h.writes.length, 0);
	h.ports.previewProposal = async () => {
		throw new Error("secret malicious source instruction");
	};
	await assert.rejects(
		h.share(),
		(error) =>
			error instanceof Error &&
			error.message.startsWith("team-sharing-unavailable:") &&
			!error.message.includes("secret")
	);
});

test("a changed bundle on the same real turn cannot bypass a pending attempt", async () => {
	const h = harness();
	h.ports.shareProposal = async (input) => {
		h.writes.push(input);
		return { status: "pending", proposal: null, decision: null };
	};
	await h.share();
	h.preview.bundleDigest = "8".repeat(64);
	await assert.rejects(h.share(), /team-sharing-changed/);
	assert.equal(h.writes.length, 1);
});

test("account changes while sharing cannot be reported as successful or trigger a resend", async () => {
	const h = harness();
	const original = h.ports.shareProposal;
	h.ports.shareProposal = async (input) => {
		const result = await original(input);
		h.status.userId = "20000000-0000-4000-8000-000000000001";
		return result;
	};
	await assert.rejects(h.share(), /team-sharing-unknown/);
	h.status.userId = uuid;
	await assert.rejects(h.share(), /team-sharing-unknown/);
	assert.equal(h.writes.length, 1);
});
