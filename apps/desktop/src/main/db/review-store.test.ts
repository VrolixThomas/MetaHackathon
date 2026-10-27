import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type SQLite from "better-sqlite3";
import type { PreparedReview, ReviewCache } from "../../shared/contracts";
import { MAX_REVIEW_CACHE_BYTES, ReviewStore } from "./review-store";

// Actual in-memory SQLite through Bun's compatible port; no Electron/native app or user DB.
const { Database } = (await import("bun:" + "sqlite")) as {
	Database: new (path: string) => SQLite.Database;
};
function cache(repository: string | null = null): ReviewCache {
	return {
		repository,
		localPath: repository ? "/selected/local/repo" : null,
		prepared: [],
		progress: [],
	};
}
function review(id = "review-1"): PreparedReview {
	return {
		id,
		version: 1,
		pr: {
			id: "owner/repo#1",
			repository: "owner/repo",
			number: 1,
			title: "Title",
			author: "author",
			url: "https://github.com/owner/repo/pull/1",
			baseSha: "b".repeat(40),
			headSha: "a".repeat(40),
		},
		createdAt: "2026-10-27T10:00:00Z",
		summary: "Summary",
		orderRationale: "Rationale",
		files: [],
		coverage: "complete",
		evidence: "inferred-from-github",
	};
}
function fixture() {
	const sqlite = new Database(":memory:");
	return { sqlite, store: new ReviewStore(sqlite) };
}

test("review records survive closing and reopening a temporary SQLite database", async () => {
	const root = await mkdtemp(join(tmpdir(), "review-sqlite-test-"));
	const path = join(root, "test.db");
	try {
		const saved = { ...cache("owner/repo"), prepared: [review()] };
		const first = new Database(path);
		try {
			await new ReviewStore(first).save(saved);
		} finally {
			first.close();
		}
		const reopened = new Database(path);
		try {
			assert.deepEqual(await new ReviewStore(reopened).load(), saved);
		} finally {
			reopened.close();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("SQLite store serializes snapshots and persists repository/local path/preparation/progress records", async () => {
	const { sqlite, store } = fixture();
	try {
		assert.deepEqual(await store.load(), cache());
		const first = cache("owner/first");
		const saved = store.save(first);
		first.repository = "owner/mutated";
		const firstRead = store.load();
		const second = cache("owner/repo");
		const prepared = review();
		second.prepared = [prepared];
		second.progress = [
			{
				reviewId: prepared.id,
				prId: prepared.pr.id,
				baseSha: prepared.pr.baseSha,
				headSha: prepared.pr.headSha,
				path: null,
				visited: [],
				paused: false,
				updatedAt: prepared.createdAt,
			},
		];
		const secondSave = store.save(second);
		const secondRead = store.load();
		await Promise.all([saved, secondSave]);
		assert.deepEqual(await firstRead, cache("owner/first"));
		assert.deepEqual(await secondRead, second);
		assert.deepEqual(await new ReviewStore(sqlite).load(), second);
		assert.equal(
			(sqlite.prepare("SELECT count(*) AS count FROM review_prepared").get() as { count: number })
				.count,
			1
		);
	} finally {
		sqlite.close();
	}
});

test("SQLite transaction failure preserves prior cache and later writes recover", async () => {
	const { sqlite, store } = fixture();
	try {
		const original = cache("owner/saved");
		await store.save(original);
		await assert.rejects(
			store.save({ ...cache("owner/next"), prepared: [review(), review("same-revision")] })
		);
		assert.deepEqual(await store.load(), original);
		await store.save(cache("owner/recovered"));
		assert.deepEqual(await store.load(), cache("owner/recovered"));
	} finally {
		sqlite.close();
	}
});

test("corrupt or mismatched relational records reject without resetting storage", async () => {
	const { sqlite, store } = fixture();
	try {
		await store.save({ ...cache("owner/repo"), prepared: [review()] });
		sqlite.prepare("UPDATE review_prepared SET data_json=?").run("{bad-json");
		await assert.rejects(store.load(), /invalid.*preserved/);
		assert.equal(
			(sqlite.prepare("SELECT data_json FROM review_prepared").get() as { data_json: string })
				.data_json,
			"{bad-json"
		);
		await store.save({ ...cache("owner/repo"), prepared: [review()] });
		sqlite.prepare("UPDATE review_prepared SET head_sha=?").run("c".repeat(40));
		await assert.rejects(store.load(), /invalid.*preserved/);
	} finally {
		sqlite.close();
	}
});

test("SQLite store rejects oversized/invalid snapshots before touching accepted records", async () => {
	const { sqlite, store } = fixture();
	try {
		const original = cache("owner/saved");
		await store.save(original);
		await assert.rejects(store.save(cache("invalid")));
		await assert.rejects(
			store.save(cache(`${"a".repeat(MAX_REVIEW_CACHE_BYTES)}/repo`)),
			/storage limit/
		);
		assert.deepEqual(await store.load(), original);
		sqlite
			.prepare(
				"INSERT INTO review_prepared(pr_id,base_sha,head_sha,review_id,data_json) VALUES(?,?,?,?,?)"
			)
			.run(
				"owner/repo#1",
				"b".repeat(40),
				"a".repeat(40),
				"oversized",
				"x".repeat(MAX_REVIEW_CACHE_BYTES + 1)
			);
		await assert.rejects(store.load(), /invalid.*preserved/);
	} finally {
		sqlite.close();
	}
});
