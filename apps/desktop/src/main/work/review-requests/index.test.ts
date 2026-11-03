import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { WorkReview } from "../../../shared/contracts";
import { GitHubReviewRequestProvider } from "./github";
import { type ReviewRequestIntent, ReviewRequestLedger, ReviewRequests } from "./index";
const intent: ReviewRequestIntent = {
	requestId: "turn",
	jobId: "job",
	accountKey: "epoch",
	actor: "author",
	repository: "owner/repo",
	headSha: "b".repeat(40),
	text: "Send this work to @alice for review",
};
async function harness() {
	const directory = await mkdtemp(join(tmpdir(), "review-requests-"));
	const at = "2026-11-03T00:00:00.000Z";
	const pr = {
		id: "pr",
		repository: intent.repository,
		number: 1,
		url: "https://github.com/owner/repo/pull/1",
		title: "Work",
		author: "author",
		headSha: intent.headSha,
		baseSha: "a".repeat(40),
	};
	const review: WorkReview = {
		job: {
			id: "job",
			repositoryId: "repo",
			repository: intent.repository,
			state: "ready",
			ticket: null,
			branch: "work",
			worktreePath: null,
			baseSha: pr.baseSha,
			headSha: pr.headSha,
			brief: "work",
			summary: "done",
			createdAt: at,
			updatedAt: at,
			decisions: [],
			checks: [
				{
					id: "check",
					command: "test",
					args: [],
					commitSha: pr.headSha,
					startedAt: at,
					finishedAt: at,
					exitCode: 0,
					logId: "log",
				},
			],
			changedFiles: ["file.ts"],
			pullRequest: null,
			error: null,
		},
		files: [],
	};
	const state = {
		draft: true,
		reviewers: [] as string[],
		head: pr.headSha,
		permission: "write",
		account: "epoch",
		posts: 0,
		ready: 0,
		publish: 0,
		lose: false,
		afterPost: false,
		drift: false,
	};
	const response = () => ({
		number: 1,
		node_id: "node",
		html_url: pr.url,
		state: "open",
		draft: state.draft,
		user: { login: "author" },
		head: { sha: state.head, repo: { full_name: intent.repository } },
		base: { repo: { full_name: intent.repository } },
		requested_reviewers: state.reviewers.map((login) => ({ login })),
	});
	const transport = (async (url: string | URL | Request, init?: RequestInit) => {
		const path = String(url);
		if (path.endsWith("/permission"))
			return Response.json({ permission: state.permission, user: { login: "alice" } });
		if (path.endsWith("/graphql")) {
			state.ready++;
			state.draft = false;
			if (state.drift) state.head = "c".repeat(40);
			return Response.json({
				data: { markPullRequestReadyForReview: { pullRequest: { id: "node", isDraft: false } } },
			});
		}
		if (init?.method === "POST") {
			state.posts++;
			if (state.afterPost) state.account = "changed";
			if (!state.lose) state.reviewers = ["alice"];
			if (state.lose) throw new Error("secret-token");
		}
		return Response.json(response());
	}) as typeof fetch;
	const provider = new GitHubReviewRequestProvider(async () => "test-secret", transport);
	const ports = {
		selected: async () => review,
		account: async () => ({ accountKey: state.account, login: "author" }),
		publish: async () => {
			state.publish++;
			review.job.pullRequest = pr;
			review.job.publishedHeadSha = pr.headSha;
		},
		provider,
	};
	const service = () => new ReviewRequests(ports, new ReviewRequestLedger(directory));
	return {
		directory,
		state,
		review,
		ports,
		service,
		send: (s = service(), signal = new AbortController().signal) =>
			s.send(intent, ["alice"], signal),
		close: () => rm(directory, { recursive: true, force: true }),
	};
}
test("publishes draft, makes ready, requests named reviewer and persists private receipt across reopen", async () => {
	const h = await harness();
	try {
		const first = await h.send();
		assert.equal(first.evidence, "request-response");
		assert.deepEqual(first.reviewers, ["alice"]);
		assert.deepEqual(await h.send(), first);
		assert.equal(h.state.posts, 1);
		assert.equal(h.state.ready, 1);
		assert.equal(h.state.publish, 1);
		for (const file of await readdir(h.directory))
			assert.equal((await stat(join(h.directory, file))).mode & 0o777, 0o600);
	} finally {
		await h.close();
	}
});
for (const condition of [
	"head drift",
	"failed validation",
	"no permission",
	"account change",
	"cancelled",
	"self",
	"invented recipient",
]) {
	test(`rejects ${condition}`, async () => {
		const h = await harness();
		try {
			const controller = new AbortController();
			if (condition === "head drift") h.state.drift = true;
			if (condition === "failed validation")
				h.review.job.checks = h.review.job.checks.map((check) => ({ ...check, exitCode: 1 }));
			if (condition === "no permission") h.state.permission = "read";
			if (condition === "account change") h.state.account = "changed";
			if (condition === "cancelled") controller.abort();
			const input =
				condition === "self" ? { ...intent, text: "Send this work to author for review" } : intent;
			const names =
				condition === "self"
					? ["author"]
					: condition === "invented recipient"
						? ["bob"]
						: ["alice"];
			await assert.rejects(h.service().send(input, names, controller.signal), /review-request-/);
			assert.equal(h.state.posts, 0);
		} finally {
			await h.close();
		}
	});
}
test("uncertain POST survives reopen without replay and can reconcile actual requested reviewers", async () => {
	const h = await harness();
	try {
		h.state.lose = true;
		await assert.rejects(h.send(), /unknown/);
		await assert.rejects(h.send(), /unknown/);
		assert.equal(h.state.posts, 1);
		h.state.reviewers = ["alice"];
		assert.equal((await h.send()).evidence, "already-requested");
		assert.equal(h.state.posts, 1);
	} finally {
		await h.close();
	}
});
test("account change during POST cannot return success or replay", async () => {
	const h = await harness();
	try {
		h.state.afterPost = true;
		await assert.rejects(h.send(), /changed/);
		await assert.rejects(h.send(), /changed/);
		assert.equal(h.state.posts, 1);
	} finally {
		await h.close();
	}
});

test("cancellation after publication retains admission and never resumes notification automatically", async () => {
	const h = await harness();
	try {
		const controller = new AbortController();
		const publish = h.ports.publish;
		h.ports.publish = async () => {
			await publish();
			controller.abort();
		};
		await assert.rejects(h.send(h.service(), controller.signal), /unknown/);
		await assert.rejects(h.send(), /unknown/);
		assert.equal(h.state.publish, 1);
		assert.equal(h.state.ready, 0);
		assert.equal(h.state.posts, 0);
	} finally {
		await h.close();
	}
});
