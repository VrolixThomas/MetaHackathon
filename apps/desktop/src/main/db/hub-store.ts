import type Database from "better-sqlite3";
import type { z } from "zod";
import {
	GitHubRepositorySchema,
	type HubPersistence,
	HubPersistenceSchema,
	type ReviewCache,
	ReviewCacheSchema,
} from "../../shared/contracts";

export const MAX_HUB_STATE_BYTES = 32 * 1024 * 1024;
export const MAX_HUB_REVIEW_BYTES = 16 * 1024 * 1024;
const repositorySchema = GitHubRepositorySchema.max(240);
const INVALID_STORED =
	"Stored executive hub data is invalid or unreadable; existing records were preserved";
const INVALID_INPUT =
	"Executive hub data is invalid or exceeds its storage limit; existing records were preserved";

function key(repository: string): string {
	return repositorySchema.parse(repository).toLowerCase();
}
function decode<T>(text: string, schema: z.ZodType<T>, maxBytes: number): T {
	if (Buffer.byteLength(text) > maxBytes) throw new Error("Storage limit");
	return schema.parse(JSON.parse(text));
}
function encode<T>(input: T, schema: z.ZodType<T>, maxBytes: number): { value: T; json: string } {
	// Snapshot before returning the promise, including nested jobs/decisions, so callers can mutate
	// their next state without changing a queued save. Validate both raw and normalized byte sizes.
	const value = decode(JSON.stringify(input), schema, maxBytes);
	const json = JSON.stringify(value);
	if (Buffer.byteLength(json) > maxBytes) throw new Error("Storage limit");
	return { value, json };
}
function unique(values: string[]) {
	if (new Set(values).size !== values.length) throw new Error("Duplicate identity");
}
function validateState(state: HubPersistence) {
	unique(state.repositories.map((row) => row.id));
	unique(state.repositories.map((row) => key(row.repository)));
	unique(state.jobs.map((row) => row.id));
	unique((state.approvalPolicies ?? []).map((row) => row.id));
	unique(state.tickets.map((row) => row.id));
	unique(state.notices.map((row) => row.id));
	unique((state.attentionRecords ?? []).map((row) => row.key));
	for (const job of state.jobs) {
		unique(job.decisions.map((row) => row.id));
		unique(job.checks.map((row) => row.id));
	}
}
function validateReview(repository: string, cache: ReviewCache) {
	if (cache.repository === null || key(cache.repository) !== repository)
		throw new Error("Repository cache key mismatch");
	unique(cache.prepared.map((row) => row.id));
	unique(cache.prepared.map((row) => JSON.stringify([row.pr.id, row.pr.baseSha, row.pr.headSha])));
	unique(cache.progress.map((row) => row.reviewId));
	const prepared = new Map(cache.prepared.map((row) => [row.id, row]));
	for (const review of cache.prepared) {
		if (key(review.pr.repository) !== repository)
			throw new Error("Prepared review repository mismatch");
	}
	for (const progress of cache.progress) {
		const review = prepared.get(progress.reviewId);
		if (
			!review ||
			review.pr.id !== progress.prId ||
			review.pr.baseSha !== progress.baseSha ||
			review.pr.headSha !== progress.headSha
		)
			throw new Error("Review progress revision mismatch");
		const files = new Set(review.files.map((file) => file.path));
		if (
			(progress.path !== null && !files.has(progress.path)) ||
			progress.visited.some((path) => !files.has(path))
		)
			throw new Error("Review progress file mismatch");
	}
}

/** Independent hub tables on root's existing SQLite connection; legacy review_* is never touched.
 * Follows ReviewStore's transactional, schema-validated JSON persistence pattern.
 */
export class HubStore {
	constructor(private readonly sqlite: Database.Database) {
		sqlite.exec(`
			CREATE TABLE IF NOT EXISTS hub_state (
				id INTEGER PRIMARY KEY CHECK(id=1), data_json TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS hub_reviews (
				repository TEXT PRIMARY KEY, data_json TEXT NOT NULL
			);
		`);
	}
	async loadState(): Promise<HubPersistence | null> {
		try {
			return this.sqlite.transaction(() => {
				const size = this.sqlite
					.prepare("SELECT length(CAST(data_json AS BLOB)) AS bytes FROM hub_state WHERE id=1")
					.get() as { bytes: number } | undefined;
				if (!size) return null;
				if (size.bytes > MAX_HUB_STATE_BYTES) throw new Error("Storage limit");
				const row = this.sqlite.prepare("SELECT data_json FROM hub_state WHERE id=1").get() as {
					data_json: string;
				};
				const value = decode(row.data_json, HubPersistenceSchema, MAX_HUB_STATE_BYTES);
				validateState(value);
				return value;
			})();
		} catch {
			throw new Error(INVALID_STORED);
		}
	}
	async saveState(state: HubPersistence): Promise<void> {
		try {
			const { value, json } = encode(state, HubPersistenceSchema, MAX_HUB_STATE_BYTES);
			validateState(value);
			this.sqlite.transaction(() => {
				this.sqlite
					.prepare(
						"INSERT INTO hub_state(id,data_json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json"
					)
					.run(json);
			})();
		} catch {
			throw new Error(INVALID_INPUT);
		}
	}
	async loadReview(repositoryInput: string): Promise<ReviewCache | null> {
		const repository = key(repositoryInput);
		try {
			return this.sqlite.transaction(() => {
				const size = this.sqlite
					.prepare(
						"SELECT length(CAST(data_json AS BLOB)) AS bytes FROM hub_reviews WHERE repository=?"
					)
					.get(repository) as { bytes: number } | undefined;
				if (!size) return null;
				if (size.bytes > MAX_HUB_REVIEW_BYTES) throw new Error("Storage limit");
				const row = this.sqlite
					.prepare("SELECT data_json FROM hub_reviews WHERE repository=?")
					.get(repository) as { data_json: string };
				const value = decode(row.data_json, ReviewCacheSchema, MAX_HUB_REVIEW_BYTES);
				validateReview(repository, value);
				return value;
			})();
		} catch {
			throw new Error(INVALID_STORED);
		}
	}
	async saveReview(repositoryInput: string, cache: ReviewCache): Promise<void> {
		try {
			const repository = key(repositoryInput);
			const { value, json } = encode(cache, ReviewCacheSchema, MAX_HUB_REVIEW_BYTES);
			validateReview(repository, value);
			this.sqlite.transaction(() => {
				this.sqlite
					.prepare(
						"INSERT INTO hub_reviews(repository,data_json) VALUES(?,?) ON CONFLICT(repository) DO UPDATE SET data_json=excluded.data_json"
					)
					.run(repository, json);
			})();
		} catch {
			throw new Error(INVALID_INPUT);
		}
	}
	async removeReview(repository: string): Promise<void> {
		const repositoryKey = key(repository);
		try {
			this.sqlite.transaction(() => {
				this.sqlite.prepare("DELETE FROM hub_reviews WHERE repository=?").run(repositoryKey);
			})();
		} catch {
			throw new Error(INVALID_STORED);
		}
	}
}
