import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type SQLite from "better-sqlite3";
import type {
	HubPersistence,
	LinearTicket,
	PreparedReview,
	ReviewCache,
} from "../../shared/contracts";
import { HubStore, MAX_HUB_REVIEW_BYTES, MAX_HUB_STATE_BYTES } from "./hub-store";
import { ReviewStore } from "./review-store";

// Real SQLite files/transactions via Bun's compatible API; no Electron or user database.
const { Database } = (await import("bun:" + "sqlite")) as {
	Database: new (path: string) => SQLite.Database;
};
const timestamp = "2026-10-28T12:00:00Z";
function ticket(): LinearTicket {
	return {
		id: "ticket-1",
		identifier: "MET-48",
		title: "Provider integration",
		description: "Actual requirements",
		url: "https://linear.app/team/issue/MET-48",
		updatedAt: timestamp,
		state: { id: "started", name: "Started", type: "started" },
		priority: 2,
		teamId: "team",
		teamName: "Team",
		projectId: "project",
		projectName: "Project",
		assigneeId: "viewer",
		assigneeName: "Viewer",
	};
}
function state(): HubPersistence {
	return {
		version: 1,
		repositories: [
			{
				id: "owner/repo",
				repository: "Owner/Repo",
				localPath: "/selected/repo",
				defaultBranch: "main",
				addedAt: timestamp,
				linearTeamIds: ["team"],
				linearProjectIds: ["project"],
			},
		],
		preferences: {
			linearTeamIds: ["team"],
			linearProjectIds: [],
			maxWorkers: 2,
			autoApplySuggestions: true,
		},
		tickets: [ticket()],
		jobs: [
			{
				id: "saved-job",
				ticket: ticket(),
				repositoryId: "owner/repo",
				repository: "Owner/Repo",
				state: "needs-input",
				branch: "muse/MET-48",
				worktreePath: "/private/worktrees/job",
				baseSha: "b".repeat(40),
				headSha: "a".repeat(40),
				brief: "Implement the ticket",
				summary: "Awaiting a decision",
				createdAt: timestamp,
				updatedAt: timestamp,
				decisions: [
					{
						id: "decision-1",
						question: "Which state?",
						reason: "Team has two states",
						createdAt: timestamp,
						answer: null,
						answeredAt: null,
					},
				],
				checks: [
					{
						id: "check-1",
						command: "bun",
						args: ["test"],
						commitSha: "a".repeat(40),
						startedAt: timestamp,
						finishedAt: timestamp,
						exitCode: 0,
						logId: "log-1",
					},
				],
				changedFiles: ["src/provider.ts"],
				pullRequest: null,
				error: null,
			},
		],
		notices: [
			{
				id: "notice-1",
				kind: "decision",
				title: "Decision needed",
				detail: "Choose a workflow state",
				jobId: "saved-job",
				prId: null,
				createdAt: timestamp,
				announcedAt: null,
				seenAt: null,
			},
		],
	};
}
function review(repository: string): PreparedReview {
	return {
		id: `${repository}-review`,
		version: 1,
		pr: {
			id: `${repository}#1`,
			repository,
			number: 1,
			title: "Actual PR",
			author: "author",
			url: `https://github.com/${repository}/pull/1`,
			baseSha: "b".repeat(40),
			headSha: "a".repeat(40),
		},
		createdAt: timestamp,
		summary: "Prepared summary",
		orderRationale: "Entry point first",
		files: [
			{
				path: "src/provider.ts",
				reason: "Reads provider data",
				summary: "Handles provider results",
				suggestedComments: [],
			},
		],
		coverage: "complete",
		evidence: "inferred-from-github",
	};
}
function cache(repository = "Owner/Repo"): ReviewCache {
	const prepared = review(repository);
	return {
		repository,
		localPath: "/selected/repo",
		prepared: [prepared],
		progress: [
			{
				reviewId: prepared.id,
				prId: prepared.pr.id,
				baseSha: prepared.pr.baseSha,
				headSha: prepared.pr.headSha,
				path: "src/provider.ts",
				visited: ["src/provider.ts"],
				paused: true,
				updatedAt: timestamp,
			},
		],
	};
}
function fixture() {
	const sqlite = new Database(":memory:");
	return { sqlite, store: new HubStore(sqlite) };
}

test("empty hub state is absent; restoring saved jobs/decisions/notices and prepared progress survives reopening SQLite", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hub-store-test-"));
	const path = join(directory, "hub.db");
	try {
		const first = new Database(path);
		try {
			const store = new HubStore(first);
			assert.equal(await store.loadState(), null);
			assert.equal(await store.loadReview("Owner/Repo"), null);
			await store.saveState(state());
			await store.saveReview("Owner/Repo", cache());
		} finally {
			first.close();
		}
		const reopened = new Database(path);
		try {
			const store = new HubStore(reopened);
			assert.deepEqual(await store.loadState(), state());
			assert.deepEqual(await store.loadReview("owner/repo"), cache());
		} finally {
			reopened.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("hub operations isolate canonical repository keys and preserve other repository and legacy review caches", async () => {
	const { sqlite, store } = fixture();
	try {
		const legacy = new ReviewStore(sqlite);
		await legacy.save(cache("Legacy/Repo"));
		await store.saveState(state());
		await store.saveReview("Owner/Repo", cache());
		await store.saveReview("Other/Repo", cache("Other/Repo"));
		const updated = cache();
		updated.localPath = "/new/path";
		await store.saveReview("OWNER/REPO", updated);
		assert.deepEqual(await store.loadReview("owner/repo"), updated);
		assert.deepEqual(await store.loadReview("Other/Repo"), cache("Other/Repo"));
		await store.removeReview("OWNER/REPO");
		assert.equal(await store.loadReview("Owner/Repo"), null);
		assert.deepEqual(await store.loadReview("Other/Repo"), cache("Other/Repo"));
		assert.deepEqual(await legacy.load(), cache("Legacy/Repo"));
		assert.deepEqual(await store.loadState(), state());
	} finally {
		sqlite.close();
	}
});

test("feedback jobs restore without invented Linear tickets and retain actual feedback identity", async () => {
	const { sqlite, store } = fixture();
	try {
		const saved = state();
		assert.ok(saved.jobs[0]);
		saved.jobs[0].ticket = null;
		saved.jobs[0].feedback = {
			id: "Owner/Repo#1:inline:42",
			prId: "Owner/Repo#1",
			author: "reviewer",
			body: "Requested change",
			url: "https://github.com/Owner/Repo/pull/1#discussion_r42",
			createdAt: timestamp,
			updatedAt: timestamp,
			kind: "inline",
			state: null,
			path: "src/provider.ts",
			line: 9,
			commitSha: "a".repeat(40),
			suggestion: "exact(value)",
		};
		await store.saveState(saved);
		assert.deepEqual(await new HubStore(sqlite).loadState(), saved);
	} finally {
		sqlite.close();
	}
});

test("save snapshots nested caller data immediately and returned state never shares mutable records", async () => {
	const { sqlite, store } = fixture();
	try {
		const input = state();
		const save = store.saveState(input);
		input.jobs[0]?.decisions.push({
			id: "new",
			question: "Changed?",
			reason: "Next state",
			createdAt: timestamp,
			answer: null,
			answeredAt: null,
		});
		await save;
		assert.deepEqual(await store.loadState(), state());
		const first = await store.loadState();
		if (first?.jobs[0]) first.jobs[0].summary = "changed in memory";
		assert.deepEqual(await store.loadState(), state());
		const reviewInput = cache();
		const saveReview = store.saveReview("Owner/Repo", reviewInput);
		reviewInput.prepared.splice(0);
		await saveReview;
		assert.deepEqual(await store.loadReview("Owner/Repo"), cache());
	} finally {
		sqlite.close();
	}
});

test("invalid state and duplicate identities reject before replacing accepted records", async () => {
	const { sqlite, store } = fixture();
	try {
		await store.saveState(state());
		const invalid = state();
		invalid.jobs.push(...invalid.jobs);
		await assert.rejects(store.saveState(invalid), /invalid.*preserved/);
		const repositories = state();
		assert.ok(repositories.repositories[0]);
		repositories.repositories.push({
			...repositories.repositories[0],
			id: "alias",
			repository: "OWNER/REPO",
		});
		await assert.rejects(store.saveState(repositories), /invalid.*preserved/);
		await assert.rejects(
			store.saveState({ ...state(), version: 2 } as unknown as HubPersistence),
			/invalid.*preserved/
		);
		assert.deepEqual(await store.loadState(), state());
	} finally {
		sqlite.close();
	}
});

test("repository mismatches, duplicate revisions and stale progress reject without touching other repositories", async () => {
	const { sqlite, store } = fixture();
	try {
		await store.saveReview("Owner/Repo", cache());
		await store.saveReview("Other/Repo", cache("Other/Repo"));
		const wrongRepo = cache();
		assert.ok(wrongRepo.prepared[0]);
		wrongRepo.prepared[0].pr.repository = "Other/Repo";
		const duplicate = cache();
		assert.ok(duplicate.prepared[0]);
		duplicate.prepared.push({ ...duplicate.prepared[0], id: "other-review" });
		const stale = cache();
		assert.ok(stale.progress[0]);
		stale.progress[0].headSha = "c".repeat(40);
		const missingFile = cache();
		assert.ok(missingFile.progress[0]);
		missingFile.progress[0].path = "not-in-plan.ts";
		for (const invalid of [cache("Other/Repo"), wrongRepo, duplicate, stale, missingFile])
			await assert.rejects(store.saveReview("Owner/Repo", invalid), /invalid.*preserved/);
		assert.deepEqual(await store.loadReview("Owner/Repo"), cache());
		assert.deepEqual(await store.loadReview("Other/Repo"), cache("Other/Repo"));
	} finally {
		sqlite.close();
	}
});

test("corrupt state/review rows reject safely and preserve exact stored bytes and other repositories", async () => {
	const { sqlite, store } = fixture();
	try {
		await store.saveState(state());
		await store.saveReview("Owner/Repo", cache());
		await store.saveReview("Other/Repo", cache("Other/Repo"));
		sqlite.prepare("UPDATE hub_state SET data_json=?").run("{bad-json-private-data");
		sqlite
			.prepare("UPDATE hub_reviews SET data_json=? WHERE repository=?")
			.run("{bad-review-private-data", "owner/repo");
		for (const result of [store.loadState(), store.loadReview("Owner/Repo")])
			await assert.rejects(
				result,
				(error: Error) =>
					/invalid.*preserved/.test(error.message) && !error.message.includes("private-data")
			);
		assert.equal(
			(sqlite.prepare("SELECT data_json FROM hub_state").get() as { data_json: string }).data_json,
			"{bad-json-private-data"
		);
		assert.equal(
			(
				sqlite
					.prepare("SELECT data_json FROM hub_reviews WHERE repository=?")
					.get("owner/repo") as { data_json: string }
			).data_json,
			"{bad-review-private-data"
		);
		assert.deepEqual(await store.loadReview("Other/Repo"), cache("Other/Repo"));
		await store.saveState(state());
		await store.saveReview("Owner/Repo", cache());
		assert.deepEqual(await store.loadState(), state());
		assert.deepEqual(await store.loadReview("Owner/Repo"), cache());
	} finally {
		sqlite.close();
	}
});

test("SQLite transaction write failure rolls back and later accepted writes recover", async () => {
	const { sqlite, store } = fixture();
	try {
		await store.saveState(state());
		await store.saveReview("Owner/Repo", cache());
		sqlite.exec(
			"CREATE TRIGGER fail_state BEFORE UPDATE ON hub_state BEGIN SELECT RAISE(ABORT,'private database failure'); END"
		);
		sqlite.exec(
			"CREATE TRIGGER fail_review BEFORE UPDATE ON hub_reviews BEGIN SELECT RAISE(ABORT,'private database failure'); END"
		);
		await assert.rejects(store.saveState({ ...state(), tickets: [] }), /invalid.*preserved/);
		await assert.rejects(
			store.saveReview("Owner/Repo", { ...cache(), localPath: "/changed" }),
			/invalid.*preserved/
		);
		assert.deepEqual(await store.loadState(), state());
		assert.deepEqual(await store.loadReview("Owner/Repo"), cache());
		sqlite.exec("DROP TRIGGER fail_state; DROP TRIGGER fail_review;");
		await store.saveState({ ...state(), tickets: [] });
		await store.saveReview("Owner/Repo", { ...cache(), localPath: "/changed" });
		assert.equal((await store.loadState())?.tickets.length, 0);
		assert.equal((await store.loadReview("Owner/Repo"))?.localPath, "/changed");
	} finally {
		sqlite.close();
	}
});

test("oversized raw input and stored JSON are rejected without deleting prior rows", async () => {
	const { sqlite, store } = fixture();
	try {
		await store.saveState(state());
		await store.saveReview("Owner/Repo", cache());
		await assert.rejects(
			store.saveState({
				...state(),
				privateExtra: "x".repeat(MAX_HUB_STATE_BYTES),
			} as HubPersistence),
			/storage limit/
		);
		await assert.rejects(
			store.saveReview("Owner/Repo", { ...cache(), localPath: "x".repeat(MAX_HUB_REVIEW_BYTES) }),
			/storage limit/
		);
		assert.deepEqual(await store.loadState(), state());
		assert.deepEqual(await store.loadReview("Owner/Repo"), cache());
		sqlite.prepare("UPDATE hub_state SET data_json=zeroblob(?)").run(MAX_HUB_STATE_BYTES + 1);
		sqlite
			.prepare("UPDATE hub_reviews SET data_json=zeroblob(?) WHERE repository=?")
			.run(MAX_HUB_REVIEW_BYTES + 1, "owner/repo");
		await assert.rejects(store.loadState(), /invalid.*preserved/);
		await assert.rejects(store.loadReview("Owner/Repo"), /invalid.*preserved/);
		assert.equal(
			(sqlite.prepare("SELECT count(*) AS count FROM hub_reviews").get() as { count: number })
				.count,
			1
		);
	} finally {
		sqlite.close();
	}
});
