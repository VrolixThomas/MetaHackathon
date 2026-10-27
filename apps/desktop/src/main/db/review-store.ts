import type Database from "better-sqlite3";
import { type ReviewCache, ReviewCacheSchema } from "../../shared/contracts";

export const MAX_REVIEW_CACHE_BYTES = 16 * 1024 * 1024;
type Row = {
	pr_id: string;
	base_sha: string;
	head_sha: string;
	review_id: string;
	data_json: string;
};

/** SQLite repository connection, revision-keyed preparations and progress; root owns queue policy.
 * Informed by SuperiorSwarm db/schema.ts githubPrFileViewed's persistent PR/file identity.
 */
export class ReviewStore {
	private pending: Promise<unknown> = Promise.resolve();
	constructor(private readonly sqlite: Database.Database) {
		sqlite.exec(`
			CREATE TABLE IF NOT EXISTS review_connection (
				id INTEGER PRIMARY KEY CHECK(id=1), repository TEXT, local_path TEXT
			);
			CREATE TABLE IF NOT EXISTS review_prepared (
				pr_id TEXT NOT NULL, base_sha TEXT NOT NULL, head_sha TEXT NOT NULL,
				review_id TEXT NOT NULL UNIQUE, data_json TEXT NOT NULL,
				PRIMARY KEY(pr_id,base_sha,head_sha)
			);
			CREATE TABLE IF NOT EXISTS review_progress (
				review_id TEXT PRIMARY KEY, pr_id TEXT NOT NULL, base_sha TEXT NOT NULL,
				head_sha TEXT NOT NULL, data_json TEXT NOT NULL
			);
		`);
	}

	load(): Promise<ReviewCache> {
		return this.serialize(async () => {
			try {
				return this.sqlite.transaction(() => {
					let bytes = 0;
					for (const table of ["review_prepared", "review_progress"]) {
						const count = this.sqlite
							.prepare(
								`SELECT count(*) AS count, coalesce(sum(length(CAST(data_json AS BLOB))+length(CAST(pr_id AS BLOB))+length(CAST(base_sha AS BLOB))+length(CAST(head_sha AS BLOB))+length(CAST(review_id AS BLOB))),0) AS bytes FROM ${table}`
							)
							.get() as { count: number; bytes: number };
						bytes += count.bytes;
						if (count.count > 200 || bytes > MAX_REVIEW_CACHE_BYTES)
							throw new Error("Review cache exceeds bounds");
					}
					const connectionSize = this.sqlite
						.prepare(
							"SELECT coalesce(length(CAST(repository AS BLOB)),0)+coalesce(length(CAST(local_path AS BLOB)),0) AS bytes FROM review_connection WHERE id=1"
						)
						.get() as { bytes: number } | undefined;
					if (bytes + (connectionSize?.bytes ?? 0) > MAX_REVIEW_CACHE_BYTES)
						throw new Error("Review cache exceeds bounds");
					const connection = this.sqlite
						.prepare("SELECT repository,local_path FROM review_connection WHERE id=1")
						.get() as { repository: string | null; local_path: string | null } | undefined;
					const prepared = (
						this.sqlite.prepare("SELECT * FROM review_prepared ORDER BY rowid").all() as Row[]
					).map((row) => {
						const value = JSON.parse(row.data_json);
						if (
							value.id !== row.review_id ||
							value.pr?.id !== row.pr_id ||
							value.pr?.baseSha !== row.base_sha ||
							value.pr?.headSha !== row.head_sha
						)
							throw new Error("Prepared review key mismatch");
						return value;
					});
					const progress = (
						this.sqlite.prepare("SELECT * FROM review_progress ORDER BY rowid").all() as Row[]
					).map((row) => {
						const value = JSON.parse(row.data_json);
						if (
							value.reviewId !== row.review_id ||
							value.prId !== row.pr_id ||
							value.baseSha !== row.base_sha ||
							value.headSha !== row.head_sha
						)
							throw new Error("Review progress key mismatch");
						return value;
					});
					const cache = ReviewCacheSchema.parse({
						repository: connection?.repository ?? null,
						localPath: connection?.local_path ?? null,
						prepared,
						progress,
					});
					if (Buffer.byteLength(JSON.stringify(cache)) > MAX_REVIEW_CACHE_BYTES)
						throw new Error("Review cache exceeds bounds");
					return cache;
				})();
			} catch {
				throw new Error(
					"Stored review cache is invalid or unreadable; existing records were preserved"
				);
			}
		});
	}

	async save(input: ReviewCache): Promise<void> {
		const cache = ReviewCacheSchema.parse(input);
		const indexedBytes =
			cache.prepared.reduce(
				(size, item) =>
					size + Buffer.byteLength(item.pr.id + item.pr.baseSha + item.pr.headSha + item.id),
				0
			) +
			cache.progress.reduce(
				(size, item) =>
					size + Buffer.byteLength(item.prId + item.baseSha + item.headSha + item.reviewId),
				0
			);
		if (Buffer.byteLength(JSON.stringify(cache)) + indexedBytes > MAX_REVIEW_CACHE_BYTES)
			throw new Error("Review cache exceeds its storage limit");
		return this.serialize(async () => {
			this.sqlite.transaction(() => {
				this.sqlite.exec(
					"DELETE FROM review_progress; DELETE FROM review_prepared; DELETE FROM review_connection;"
				);
				this.sqlite
					.prepare("INSERT INTO review_connection(id,repository,local_path) VALUES(1,?,?)")
					.run(cache.repository, cache.localPath);
				const prepared = this.sqlite.prepare(
					"INSERT INTO review_prepared(pr_id,base_sha,head_sha,review_id,data_json) VALUES(?,?,?,?,?)"
				);
				for (const review of cache.prepared)
					prepared.run(
						review.pr.id,
						review.pr.baseSha,
						review.pr.headSha,
						review.id,
						JSON.stringify(review)
					);
				const progress = this.sqlite.prepare(
					"INSERT INTO review_progress(review_id,pr_id,base_sha,head_sha,data_json) VALUES(?,?,?,?,?)"
				);
				for (const item of cache.progress)
					progress.run(item.reviewId, item.prId, item.baseSha, item.headSha, JSON.stringify(item));
			})();
		});
	}

	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.pending.then(operation);
		this.pending = result.catch(() => undefined);
		return result;
	}
}
