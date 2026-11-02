import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, parse, resolve } from "node:path";
import { z } from "zod";
import { CodingProviderSettingsSchema } from "../../../shared/contracts/coding-provider";
import { CommentFixRecordSchema, CommentFixSourceSchema } from "../../agent/pr-comment-fixes";

import { CodingModelSchema } from "../../agent/coding-model";

export const hash = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function identity(owner: string, id: string) {
	const requestId = hash({ owner, id });
	const key = hash(requestId).slice(0, 32);
	return { requestId, jobId: `comment-fix-${key}`, branch: `muse/comment-fix-${key}` };
}
export const EntrySchema = z.strictObject({
	id: z.string().min(1).max(200),
	codingProvider: CodingProviderSettingsSchema.optional(),
	codingModel: CodingModelSchema.optional(),
	jobId: z.string().min(1).max(200),
	source: CommentFixSourceSchema,
	fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
	record: CommentFixRecordSchema.nullable(),
	issue: z.enum(["failed", "interrupted", "review"]).nullable(),
	reviewedHeadSha: z
		.string()
		.regex(/^[a-f0-9]{40}$/)
		.nullable(),
	reviewedAt: z.iso.datetime().nullable(),
	logs: z.array(z.string().max(2000)).max(40),
});
export type Entry = z.infer<typeof EntrySchema>;
const StoreSchema = z.strictObject({
	version: z.literal(1),
	owner: z.string().min(1).max(200),
	entries: z.array(EntrySchema).max(100),
	requests: z
		.array(
			z.strictObject({
				requestId: z.string().min(1).max(200),
				fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
				id: z.string().min(1).max(200),
			})
		)
		.max(1000),
});
export type Store = z.infer<typeof StoreSchema>;

function recordMatches(entry: Entry, owner: string): boolean {
	const record = entry.record;
	const expected = identity(owner, entry.id);
	if (entry.jobId !== expected.jobId) return false;
	if (!record) return true;
	const { pr, feedback, repository } = record.request;
	return (
		record.request.requestId === expected.requestId &&
		record.bindingDigest === hash(record.request) &&
		hash(CommentFixSourceSchema.parse({ pr, feedback, repository })) === entry.fingerprint &&
		record.job.id === expected.jobId &&
		record.job.branch === expected.branch &&
		record.job.repositoryId === entry.source.repository.id &&
		record.job.repository === entry.source.pr.repository &&
		record.job.baseSha === entry.source.pr.headSha &&
		hash(record.job.feedback) === hash(entry.source.feedback) &&
		hash(record.job.pullRequest) === hash(entry.source.pr) &&
		record.job.ticket === null &&
		!record.job.internal &&
		!record.job.reviewedAt &&
		!record.job.publishedHeadSha &&
		!record.job.feedbackAppliedAt &&
		(record.phase === "settled") === (record.outcome !== null)
	);
}

const locks = new Map<string, Promise<unknown>>();
/** Process-wide owner/record locks are shared by every service instance in this main process. */
export async function exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
	const previous = locks.get(key) ?? Promise.resolve();
	const pending = previous.catch(() => {}).then(operation);
	locks.set(key, pending);
	try {
		return await pending;
	} finally {
		if (locks.get(key) === pending) locks.delete(key);
	}
}

/** Reject symlink traversal before creating or opening any private state. */
async function directory(path: string): Promise<void> {
	let current = parse(path).root;
	for (const part of path.slice(current.length).split("/").filter(Boolean)) {
		current = join(current, part);
		await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "EEXIST") throw error;
		});
		const stat = await lstat(current);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe private directory");
	}
	await chmod(path, 0o700);
}

/** Atomic private state, never a regular WorkJobCoordinator store or a replay queue. */
export class FixStore {
	readonly root: string;
	constructor(directory: string) {
		if (
			!isAbsolute(directory) ||
			resolve(directory) !== directory ||
			directory.includes("\0") ||
			parse(directory).root === directory
		)
			throw new Error("An absolute private PR-fix directory is required");
		this.root = directory;
	}
	scope(owner: string): string {
		return join(this.root, hash(owner));
	}
	private async ensure(owner: string): Promise<string> {
		await directory(this.root);
		const path = this.scope(owner);
		await directory(path);
		return path;
	}
	async read(owner: string): Promise<Store> {
		const path = await this.ensure(owner);
		let file: Awaited<ReturnType<typeof open>> | undefined;
		try {
			file = await open(join(path, "fixes.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
			const stat = await file.stat();
			if (!stat.isFile() || stat.nlink !== 1 || stat.size > 32_000_000 || (stat.mode & 0o077) !== 0)
				throw new Error("Invalid private state");
			const state = StoreSchema.parse(JSON.parse(await file.readFile("utf8")));
			if (
				state.owner !== owner ||
				new Set(state.entries.map((e) => e.id)).size !== state.entries.length ||
				new Set(state.requests.map((r) => r.requestId)).size !== state.requests.length ||
				state.entries.some((e) => e.fingerprint !== hash(e.source) || !recordMatches(e, owner)) ||
				state.requests.some(
					(r) => !state.entries.some((e) => e.id === r.id && e.fingerprint === r.fingerprint)
				)
			)
				throw new Error("Invalid private state binding");
			return state;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				return { version: 1, owner, entries: [], requests: [] };
			throw error;
		} finally {
			await file?.close();
		}
	}
	async write(state: Store, beforeCommit: () => void): Promise<void> {
		const path = await this.ensure(state.owner);
		const text = JSON.stringify(StoreSchema.parse(state));
		if (Buffer.byteLength(text) > 32_000_000) throw new Error("Private state limit reached");
		const temporary = join(path, `${randomUUID()}.tmp`);
		let file: Awaited<ReturnType<typeof open>> | undefined;
		try {
			file = await open(temporary, "wx", 0o600);
			await file.writeFile(text);
			await file.sync();
			await file.close();
			file = undefined;
			beforeCommit();
			await rename(temporary, join(path, "fixes.json"));
			const parent = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
			try {
				await parent.sync();
			} finally {
				await parent.close();
			}
		} finally {
			await file?.close();
			await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
		}
	}
}
