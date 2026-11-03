import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { WorkReview } from "../../shared/contracts";
import type { ConversationTurnInput, WorkspaceSnapshot } from "../../shared/contracts";
import { ConversationReviewRequestTools } from "../agent/review-request-tools";
import type { ReviewRequestIntent } from "../work/review-requests";
import { ReviewRequestComposition } from "./review-request";
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
	const workspace: WorkspaceSnapshot = {
		sequence: 1,
		contentSequence: 1,
		canvases: [
			{
				id: "selected",
				title: "Work",
				revision: 1,
				kind: "center",
				section: "completed",
				selectedId: "job",
			},
		],
		primaryId: "selected",
		secondaryId: null,
		codeView: "diff",
		browser: null,
		review: { mode: "conversation", sequence: 0, prId: null },
	};
	let observed: WorkspaceSnapshot | null = workspace;
	let epoch = 1;
	const ports = {
		epoch: () => epoch,
		observe: async (_session: string, _signal: AbortSignal) => observed,
		review: async () => structuredClone(review),
		account: async () => ({ accountKey: state.account, login: "author" }),
		token: async () => "controlled-token",
		publish: async () => {
			state.publish++;
			review.job.pullRequest = pr;
			review.job.publishedHeadSha = pr.headSha;
		},
		transport,
	};
	const composition = new ReviewRequestComposition(ports, directory);
	const turn: ConversationTurnInput = {
		requestId: "request",
		sessionId: "session",
		turnId: "turn",
		generation: 1,
		text: intent.text,
		workspace: structuredClone(workspace),
	};
	const send = (input = turn, signal = new AbortController().signal) =>
		new ConversationReviewRequestTools(composition.tools, input, signal).execute(
			"send_work_for_review",
			JSON.stringify({ jobId: "job", reviewerLogins: ["alice"] })
		);
	return {
		composition,
		ports,
		turn,
		workspace,
		state,
		review,
		send,
		hide: () => {
			observed = null;
		},
		changeAccount: () => {
			epoch++;
			composition.clear();
		},
		close: async () => {
			composition.clear();
			await rm(directory, { recursive: true, force: true });
		},
	};
}
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
test("tool awaits real ingress capture, publishes once and sends only actual named recipients", async () => {
	const h = await harness();
	try {
		const gate = deferred();
		const read = h.ports.review;
		h.ports.review = async () => {
			await gate.promise;
			return read();
		};
		h.composition.capture(h.turn);
		const sending = h.send();
		await Promise.resolve();
		assert.equal(h.state.posts, 0);
		gate.resolve();
		const receipt = await sending;
		assert.deepEqual(receipt.reviewers, ["alice"]);
		assert.equal(h.state.posts, 1);
		assert.equal(h.state.publish, 1);
		await assert.rejects(h.send(), /denied/);
	} finally {
		await h.close();
	}
});
for (const condition of [
	"hidden",
	"modal",
	"target",
	"head",
	"account",
	"epoch",
	"session",
	"text",
	"request",
	"generation",
	"cancel",
	"self",
	"permission",
	"not ready",
	"checks",
]) {
	test(`fails closed on ${condition}`, async () => {
		const h = await harness();
		try {
			h.composition.capture(h.turn);
			assert.ok(await h.composition.tools.intent(h.turn));
			const input = structuredClone(h.turn);
			const controller = new AbortController();
			if (condition === "hidden" || condition === "modal") h.hide();
			if (condition === "target") h.workspace.contentSequence = 2;
			if (condition === "head") h.review.job.headSha = "c".repeat(40);
			if (condition === "account") h.state.account = "other";
			if (condition === "epoch") h.changeAccount();
			if (condition === "session") input.sessionId = "other";
			if (condition === "text") input.text = "Send this work to bob for review";
			if (condition === "request") input.requestId = "other";
			if (condition === "generation") input.generation++;
			if (condition === "cancel") controller.abort();
			if (condition === "self") {
				input.requestId = "self";
				input.text = "Send this work to author for review";
				h.composition.capture(input);
			}
			if (condition === "permission") h.state.permission = "read";
			if (condition === "not ready") h.review.job.state = "running";
			if (condition === "checks") h.review.job.checks = [];
			await assert.rejects(h.send(input, controller.signal), /review-request-/);
			assert.equal(h.state.posts, 0);
			assert.equal(h.state.publish, 0);
		} finally {
			await h.close();
		}
	});
}
for (const lifecycle of ["release", "account", "new turn", "abort"]) {
	test(`pending capture cannot revive after ${lifecycle}`, async () => {
		const h = await harness();
		const gate = deferred();
		try {
			const read = h.ports.review;
			h.ports.review = async () => {
				await gate.promise;
				return read();
			};
			const controller = new AbortController();
			h.composition.capture(h.turn, controller.signal);
			const capture = h.composition.tools.intent(h.turn);
			if (lifecycle === "release") h.composition.clear(h.turn.sessionId);
			if (lifecycle === "account") h.changeAccount();
			if (lifecycle === "new turn")
				h.composition.capture({ ...h.turn, requestId: "next", text: "Explain this" });
			if (lifecycle === "abort") controller.abort();
			gate.resolve();
			assert.equal(await capture, null);
			h.composition.capture(h.turn);
			assert.equal(await h.composition.tools.intent(h.turn), null);
			await assert.rejects(h.send(), /denied/);
		} finally {
			gate.resolve();
			await h.close();
		}
	});
}
test("unknown delivery is durable across fresh ingress and cannot replay", async () => {
	const h = await harness();
	try {
		h.state.lose = true;
		h.composition.capture(h.turn);
		await assert.rejects(h.send(), /unknown/);
		h.changeAccount(); // Same account reconnect: epoch changes, durable ledger identity does not.
		const next = { ...h.turn, requestId: "next", turnId: "next" };
		h.composition.capture(next);
		await assert.rejects(h.send(next), /unknown/);
		assert.equal(h.state.posts, 1);
	} finally {
		await h.close();
	}
});
test("one shared send slot rejects concurrent sessions and conflicting requests", async () => {
	const h = await harness();
	const gate = deferred();
	try {
		const publish = h.ports.publish;
		const entered = deferred();
		h.ports.publish = async () => {
			entered.resolve();
			await gate.promise;
			return publish();
		};
		h.composition.capture(h.turn);
		const first = h.send();
		await entered.promise;
		const other = { ...h.turn, sessionId: "other", requestId: "other" };
		h.composition.capture(other);
		await assert.rejects(h.send(other), /busy/);
		h.composition.clear(h.turn.sessionId);
		gate.resolve();
		await assert.rejects(first, /review-request-/);
		await assert.rejects(h.send(other), /unknown/);
		assert.equal(h.state.posts, 0);
	} finally {
		gate.resolve();
		await h.close();
	}
});
test("credential changes during token acquisition fence the provider before HTTP", async () => {
	const h = await harness();
	try {
		h.ports.token = async () => {
			h.changeAccount();
			return "old-token";
		};
		h.composition.capture(h.turn);
		await assert.rejects(h.send(), /review-request-/);
		assert.equal(h.state.publish, 0);
		assert.equal(h.state.posts, 0);
	} finally {
		await h.close();
	}
});

test("tool cancellation retires capture even while the actual read is pending", async () => {
	const h = await harness();
	const gate = deferred();
	try {
		const read = h.ports.review;
		h.ports.review = async () => {
			await gate.promise;
			return read();
		};
		h.composition.capture(h.turn);
		const controller = new AbortController();
		const result = h.send(h.turn, controller.signal);
		controller.abort();
		gate.resolve();
		await assert.rejects(result, /review-request-/);
		assert.equal(await h.composition.tools.intent(h.turn), null);
		h.composition.capture(h.turn);
		assert.equal(await h.composition.tools.intent(h.turn), null);
		assert.equal(h.state.posts, 0);
	} finally {
		gate.resolve();
		await h.close();
	}
});
for (const condition of [
	"unselected",
	"wrong pane",
	"changed before capture",
	"unrequested",
	"forged intent",
]) {
	test(`does not authorize ${condition}`, async () => {
		const h = await harness();
		try {
			if (condition === "unselected") h.turn.workspace = undefined;
			if (condition === "wrong pane" && h.turn.workspace) h.turn.workspace.primaryId = "hidden";
			if (condition === "changed before capture") h.workspace.contentSequence = 2;
			if (condition === "unrequested") h.turn.text = "Explain this work";
			h.composition.capture(h.turn);
			const captured = await h.composition.tools.intent(h.turn);
			if (condition === "forged intent") {
				assert.ok(captured);
				await assert.rejects(
					h.composition.tools.send({ ...captured }, ["alice"], new AbortController().signal),
					/denied/
				);
			} else assert.equal(captured, null);
			assert.equal(h.state.publish, 0);
			assert.equal(h.state.posts, 0);
		} finally {
			await h.close();
		}
	});
}
test("capture concurrency remains bounded even if a read ignores cancellation", async () => {
	const h = await harness();
	const gate = deferred();
	try {
		let reads = 0;
		const read = h.ports.review;
		h.ports.review = async () => {
			reads++;
			await gate.promise;
			return read();
		};
		for (let i = 0; i < 20; i++)
			h.composition.capture({ ...h.turn, sessionId: `session-${i}`, requestId: `request-${i}` });
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(reads, 16);
		assert.equal(
			await h.composition.tools.intent({
				...h.turn,
				sessionId: "session-19",
				requestId: "request-19",
			}),
			null
		);
		h.composition.clear();
		gate.resolve();
	} finally {
		gate.resolve();
		await h.close();
	}
});

test("late cancellation cannot retire a newer ingress in the same session", async () => {
	const h = await harness();
	try {
		h.composition.capture(h.turn);
		const next = { ...h.turn, turnId: "new", requestId: "new", generation: 2 };
		h.composition.capture(next);
		h.composition.cancel(h.turn);
		assert.ok(await h.composition.tools.intent(next));
		h.composition.cancel(next);
		assert.equal(await h.composition.tools.intent(next), null);
	} finally {
		await h.close();
	}
});
