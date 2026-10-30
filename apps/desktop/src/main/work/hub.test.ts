import assert from "node:assert/strict";
import { type TestContext, it } from "node:test";
import {
	type HubPersistence,
	HubPersistenceSchema,
	type LinearTicket,
	type ReviewCache,
	type ReviewQueueItem,
} from "../../shared/contracts";
import { CommandCenterService, HubFailure } from "./hub";

const ticket = (
	id: string,
	teamId: string,
	projectId: string | null,
	assigneeId = "me"
): LinearTicket => ({
	id,
	identifier: `TEST-${id}`,
	title: `Controlled ticket ${id}`,
	description: "Controlled test source only",
	url: `https://linear.app/test/issue/${id}`,
	updatedAt: "2026-10-29T00:00:00Z",
	state: { id: "todo", name: "Todo", type: "unstarted" },
	priority: 2,
	teamId,
	teamName: teamId,
	projectId,
	projectName: projectId,
	assigneeId,
	assigneeName: assigneeId,
});
const review = (repository = "test/repo"): ReviewQueueItem => ({
	repositoryId: repository,
	kind: "incoming",
	baseBranch: "main",
	headBranch: "change",
	draft: false,
	updatedAt: "2026-10-29T00:00:00Z",
	reviewState: "requested",
	feedbackCount: 0,
	lastFeedbackAt: null,
	pr: {
		id: `${repository}#1`,
		repository,
		number: 1,
		title: "Controlled PR",
		url: `https://github.com/${repository}/pull/1`,
		author: "other",
		baseSha: "a".repeat(40),
		headSha: "b".repeat(40),
	},
});
function harness(
	t: TestContext,
	legacy: ReviewCache = { repository: null, localPath: null, prepared: [], progress: [] }
) {
	let saved: HubPersistence | null = null;
	const caches = new Map<string, ReviewCache>();
	let failing = false;
	const controls = {
		account: async () => ({ login: "me" }),
		viewer: async () => ({ id: "me", name: "Me" }),
		tickets: async () => [
			ticket("1", "team-a", null),
			ticket("2", "team-b", "project-b"),
			ticket("3", "team-a", null, "someone-else"),
		],
	};
	const hub = new CommandCenterService({
		store: {
			loadState: async () => saved,
			saveState: async (value) => {
				saved = structuredClone(value);
			},
			loadReview: async (name) => caches.get(name) ?? null,
			saveReview: async (name, value) => {
				caches.set(name, structuredClone(value));
			},
		},
		registry: {
			register: () => {},
			ensure: async () => {
				throw Error("Preparation is outside this controlled unit");
			},
			remove: async () => {},
		},
		connections: async () => ({ github: true, linear: true, model: true }),
		legacyCache: async () => legacy,
		github: {
			account: () => controls.account(),
			repository: async (repository) => ({ repository, defaultBranch: "main", private: false }),
			repositories: async () => [],
			reviews: async (repository) => {
				if (failing) throw Error("PRIVATE_UPSTREAM_TEXT");
				return [review(repository)];
			},
			feedback: async () => [],
			source: async (input) => ({
				path: input.path,
				commitSha: input.commitSha,
				status: "available",
				content: "one\r\ntwo\r\nthree\r\nfour\r\n",
			}),
		},
		linear: {
			viewer: () => controls.viewer(),
			tickets: () => controls.tickets(),
			ticket: async () => ticket("1", "team-a", null),
			scopes: async () => [],
		},
	});
	t.after(() => hub.dispose());
	return {
		hub,
		controls,
		caches,
		saved: () => saved,
		fail: () => {
			failing = true;
		},
	};
}
it("imports only the real existing repository and keeps branch metadata unknown until fetched", async (t) => {
	const legacy = { repository: "test/repo", localPath: null, prepared: [], progress: [] };
	const h = harness(t, legacy);
	const snapshot = await h.hub.snapshot();
	assert.equal(snapshot.repositories.length, 1);
	assert.equal(snapshot.repositories[0]?.defaultBranch, null);
	assert.equal(snapshot.refreshedAt, null);
	assert.deepEqual(snapshot.jobs, []);
	assert.deepEqual(h.caches.get("test/repo"), legacy);
	await h.hub.refresh();
	assert.equal((await h.hub.snapshot()).repositories[0]?.defaultBranch, "main");
});
it("selected teams and projects form a union and never admit another viewer's assigned work", async (t) => {
	const h = harness(t);
	await h.hub.operate(
		{
			kind: "preferences",
			preferences: {
				linearTeamIds: ["team-a"],
				linearProjectIds: ["project-b"],
				maxWorkers: 2,
				autoApplySuggestions: false,
			},
		},
		"scopes"
	);
	assert.deepEqual(
		(await h.hub.snapshot()).tickets.map((item) => item.id),
		["1", "2"]
	);
	assert.equal(h.saved()?.tickets.length, 2);
});
it("provider failure preserves previously observed queues and reflects no raw upstream text", async (t) => {
	const h = harness(t, { repository: "test/repo", localPath: null, prepared: [], progress: [] });
	await h.hub.refresh();
	const first = await h.hub.snapshot();
	assert.equal(first.reviews.length, 1);
	h.fail();
	await h.hub.refresh();
	const next = await h.hub.snapshot();
	assert.deepEqual(next.reviews, first.reviews);
	assert.equal(next.errors[0]?.source, "github");
	assert.ok(!JSON.stringify(next.errors).includes("PRIVATE_UPSTREAM_TEXT"));
});
it("pinned non-PR source preserves exact lines and admits no model-supplied source text", async (t) => {
	const h = harness(t, { repository: "test/repo", localPath: null, prepared: [], progress: [] });
	const source = await h.hub.source({
		repository: "test/repo",
		commitSha: "b".repeat(40),
		path: "unchanged/payment.ts",
		startLine: 2,
		endLine: 3,
	});
	assert.equal(source.text, "two\r\nthree\r\n");
	assert.equal(source.location.startLine, 2);
	assert.equal(source.location.endLine, 3);
	assert.equal(source.truncated, false);
	await assert.rejects(
		h.hub.source({ repository: "other/repo", commitSha: "b".repeat(40), path: "payment.ts" }),
		HubFailure
	);
	assert.ok(HubPersistenceSchema.safeParse(h.saved()).success);
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function eventually(check: () => Promise<boolean>) {
	for (let i = 0; i < 100; i++) {
		if (await check()) return;
		await new Promise<void>((r) => setImmediate(r));
	}
	assert.fail("Expected refreshed account");
}
it("a changed GitHub login clears fetched queues and ignores a late old-account profile", async (t) => {
	const h = harness(t, { repository: "test/repo", localPath: null, prepared: [], progress: [] });
	await h.hub.refresh();
	const profile = deferred<{ login: string }>();
	const entered = deferred<void>();
	h.controls.account = async () => {
		entered.resolve();
		return profile.promise;
	};
	const old = h.hub.refresh();
	await entered.promise;
	await h.hub.connectionChanged("github");
	assert.equal((await h.hub.snapshot()).viewer.githubLogin, null);
	assert.deepEqual((await h.hub.snapshot()).reviews, []);
	h.controls.account = async () => ({ login: "new-viewer" });
	profile.resolve({ login: "old-viewer" });
	await old;
	await eventually(async () => (await h.hub.snapshot()).viewer.githubLogin === "new-viewer");
	assert.equal(
		(await h.hub.snapshot()).repositories.length,
		1,
		"User-selected repositories stay registered"
	);
});
it("a changed Linear account cannot restore held tickets from the previous workspace", async (t) => {
	const h = harness(t);
	await h.hub.refresh();
	const held = deferred<LinearTicket[]>();
	const entered = deferred<void>();
	h.controls.tickets = async () => {
		entered.resolve();
		return held.promise;
	};
	const old = h.hub.refresh();
	await entered.promise;
	await h.hub.connectionChanged("linear");
	assert.deepEqual((await h.hub.snapshot()).tickets, []);
	h.controls.viewer = async () => ({ id: "new", name: "New account" });
	h.controls.tickets = async () => [ticket("new", "team-a", null, "new")];
	held.resolve([ticket("old", "team-a", null)]);
	await old;
	await eventually(async () => (await h.hub.snapshot()).tickets.some((t) => t.id === "new"));
	assert.deepEqual(
		(await h.hub.snapshot()).tickets.map((t) => t.id),
		["new"]
	);
});
