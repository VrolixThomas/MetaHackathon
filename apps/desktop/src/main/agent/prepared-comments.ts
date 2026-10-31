import { createHash } from "node:crypto";
import { z } from "zod";
import {
	type CodeLocation,
	ConfirmCommentInputSchema,
	type DraftedComment,
	GitHubRepositorySchema,
	IdSchema,
	PRCommentCreateInputSchema,
	PRCommentEditInputSchema,
	type PullRequest,
	PullRequestSchema,
	type ReviewDetail,
	ReviewDetailSchema,
	type ReviewFile,
	type ReviewFileRequestSchema,
	ReviewFileSchema,
} from "../../shared/contracts";
import { abortable } from "./cancellation";
import { CommentDrafts } from "./comments";

type FileRequest = z.infer<typeof ReviewFileRequestSchema>;
type Identity = { prId: string; reviewId: string; headSha: string };
type Operation = { epoch: number; generation: number; abort: AbortController };
type Attempt = {
	fingerprint: string;
	operation: Operation;
	result: Promise<{ url: string }>;
	postEntered: boolean;
	retryable: boolean;
};
type Record = {
	core: CommentDrafts;
	draftId: string;
	pr: PullRequest;
	reviewId: string;
	epoch: number;
	requestId?: string;
};

export interface PreparedCommentsPorts {
	getReview(prId: string, signal: AbortSignal): Promise<ReviewDetail>;
	readFile(input: FileRequest, signal: AbortSignal): Promise<ReviewFile>;
	readPR(prId: string, signal: AbortSignal): Promise<PullRequest>;
	/** Root must use the durable GitHub ledger, atomically reserving this key and checking head. */
	post(
		draft: DraftedComment,
		input: { idempotencyKey: string; expectedHeadSha: string },
		signal: AbortSignal
	): Promise<{ url: string }>;
	getEpoch(): number;
}

class CommentError extends Error {}
function fail(message: string): never {
	throw new CommentError(message);
}
function sanitized(error: unknown, message: string) {
	return error instanceof CommentError ? error : new CommentError(message);
}
function samePR(a: PullRequest, b: PullRequest) {
	return (
		a.id === b.id &&
		a.repository === b.repository &&
		a.number === b.number &&
		a.baseSha === b.baseSha &&
		a.headSha === b.headSha &&
		a.url === b.url
	);
}
function prURL(pr: PullRequest) {
	GitHubRepositorySchema.parse(pr.repository);
	const url = new URL(pr.url);
	if (
		url.protocol !== "https:" ||
		url.hostname !== "github.com" ||
		url.port ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== `/${pr.repository}/pull/${pr.number}`
	)
		fail("Review does not identify a GitHub pull request");
	return url;
}

/** Count complete unified hunks; only one exact RIGHT-side source line may be anchored. */
function rightDiffLine(file: ReviewFile, line: number) {
	if (file.head.status !== "available" || file.head.content === null || !file.patch) return false;
	const source = file.head.content ? file.head.content.replace(/\n$/, "").split("\n") : [];
	if (line > source.length) return false;
	let head = 0;
	let before = 0;
	let after = 0;
	let hunk = false;
	let matches = 0;
	for (const row of file.patch.split("\n")) {
		const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(row);
		if (header) {
			if (before || after) return false;
			head = Number(header[3]);
			before = Number(header[2] ?? 1);
			after = Number(header[4] ?? 1);
			hunk = true;
		} else if (hunk && (row.startsWith("+") || row.startsWith(" "))) {
			if (after <= 0 || (row.startsWith(" ") && before <= 0)) return false;
			if (head === line && row.slice(1) === source[line - 1]) matches++;
			head++;
			after--;
			if (row.startsWith(" ")) before--;
		} else if (hunk && row.startsWith("-")) {
			if (before <= 0) return false;
			before--;
		} else if (hunk && row && row !== "\\ No newline at end of file") return false;
	}
	return matches === 1 && before === 0 && after === 0;
}

/** Real prepared-review comments, independent of the legacy agent preparation catalog. */
export class PreparedComments {
	private readonly records = new Map<string, Record>();
	private readonly creates = new Map<
		string,
		{ fingerprint: string; result: Promise<DraftedComment> }
	>();
	private readonly attempts = new Map<string, Attempt>();
	private readonly cancelled = new Set<string>();
	private readonly operations = new Set<Operation>();
	private generation = 0;
	private disposed = false;
	private cancellationFull = false;
	private epoch: number | undefined;

	constructor(
		private readonly ports: PreparedCommentsPorts,
		private readonly capacity = 256
	) {
		if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 4096)
			fail("Invalid comment session capacity");
	}

	private accountEpoch() {
		let epoch: number;
		try {
			epoch = this.ports.getEpoch();
			if (!Number.isSafeInteger(epoch)) fail("Comment account is unavailable");
		} catch {
			fail("Comment account is unavailable");
		}
		if (this.epoch !== undefined && this.epoch !== epoch) this.invalidate();
		this.epoch = epoch;
		return epoch;
	}
	private check(operation: Operation) {
		if (this.disposed || operation.abort.signal.aborted || operation.generation !== this.generation)
			fail("Comment operation cancelled");
		if (this.accountEpoch() !== operation.epoch) {
			fail("Comment account changed; prepare a new draft");
		}
	}
	private begin(epoch = this.accountEpoch()) {
		if (this.disposed) fail("Comment service is closed");
		if (this.operations.size >= this.capacity) fail("Comment session capacity reached");
		const operation = { epoch, generation: this.generation, abort: new AbortController() };
		this.check(operation);
		this.operations.add(operation);
		return operation;
	}
	private async wait<T>(operation: Operation, work: () => Promise<T>): Promise<T> {
		this.check(operation);
		const result = await abortable(
			Promise.resolve().then(() => {
				this.check(operation);
				return work();
			}),
			operation.abort.signal
		);
		this.check(operation);
		return result;
	}
	private record(id: string) {
		if (this.disposed) fail("Comment service is closed");
		const record = this.records.get(id);
		if (!record) fail("Comment draft is unavailable; prepare a new draft");
		if (record.epoch !== this.accountEpoch()) {
			fail("Comment account changed; prepare a new draft");
		}
		return record;
	}
	private async validate(
		operation: Operation,
		identity: Identity,
		location?: CodeLocation,
		pinned?: PullRequest
	) {
		const signal = operation.abort.signal;
		const detail = ReviewDetailSchema.parse(
			await this.wait(operation, () => this.ports.getReview(identity.prId, signal))
		);
		const plan = detail.prepared;
		if (
			detail.status !== "ready" ||
			!plan ||
			plan.id !== identity.reviewId ||
			detail.pr.id !== identity.prId ||
			detail.pr.headSha !== identity.headSha ||
			!samePR(plan.pr, detail.pr) ||
			(pinned && !samePR(pinned, detail.pr))
		)
			fail("Prepared review changed; prepare a new draft");
		prURL(detail.pr);
		if (location) {
			if (
				location.repository !== detail.pr.repository ||
				location.revision !== "head" ||
				location.commitSha !== detail.pr.headSha ||
				location.startLine !== location.endLine ||
				!plan.files.some((entry) => entry.path === location.path)
			)
				fail("Inline comment must identify one RIGHT-side prepared diff line");
			const file = ReviewFileSchema.parse(
				await this.wait(operation, () =>
					this.ports.readFile(
						{ prId: detail.pr.id, reviewId: plan.id, path: location.path },
						signal
					)
				)
			);
			if (
				file.prId !== detail.pr.id ||
				file.path !== location.path ||
				file.head.path !== location.path ||
				(file.status !== "renamed" && file.base.path !== location.path) ||
				file.base.commitSha !== detail.pr.baseSha ||
				file.head.commitSha !== detail.pr.headSha ||
				!rightDiffLine(file, location.endLine)
			)
				fail("Inline comment source or diff line changed");
		}
		const fresh = PullRequestSchema.parse(
			await this.wait(operation, () => this.ports.readPR(detail.pr.id, signal))
		);
		prURL(fresh);
		if (!samePR(detail.pr, fresh)) fail("Pull request changed; prepare a new draft");
		return detail.pr;
	}

	create(raw: unknown): Promise<DraftedComment> {
		try {
			const input = PRCommentCreateInputSchema.parse(raw);
			IdSchema.max(200).parse(input.requestId);
			const operation = this.begin();
			const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
			const previous = this.creates.get(input.requestId);
			if (previous) {
				this.operations.delete(operation);
				if (previous.fingerprint !== fingerprint)
					fail("Comment request ID reused with different data");
				return previous.result.then((draft) => {
					this.record(draft.id);
					return structuredClone(draft);
				});
			}
			if (this.creates.size >= this.capacity || this.records.size >= this.capacity) {
				this.operations.delete(operation);
				fail("Comment session capacity reached");
			}
			const result = this.createDraft(input, operation)
				.catch((error) => {
					throw sanitized(error, "Could not prepare this exact PR comment");
				})
				.finally(() => this.operations.delete(operation));
			this.creates.set(input.requestId, { fingerprint, result });
			return result.then((draft) => structuredClone(draft));
		} catch (error) {
			return Promise.reject(sanitized(error, "Invalid PR comment request"));
		}
	}
	private async createDraft(
		input: z.infer<typeof PRCommentCreateInputSchema>,
		operation: Operation
	) {
		const pr = await this.validate(operation, input, input.location);
		this.check(operation);
		if (this.records.size >= this.capacity) fail("Comment session capacity reached");
		const record: Record = {
			pr,
			draftId: "",
			reviewId: input.reviewId,
			epoch: operation.epoch,
			core: new CommentDrafts({
				getPullRequest: async (_prId, signal) => {
					const attempt = this.activeAttempt(record, signal);
					const draft = record.core.get(record.draftId);
					return this.validate(
						attempt.operation,
						{ prId: draft.prId, reviewId: record.reviewId, headSha: draft.headSha },
						draft.location,
						record.pr
					);
				},
				postConfirmedComment: async ({ draft, idempotencyKey, expectedHeadSha }, signal) => {
					const attempt = this.activeAttempt(record, signal);
					attempt.postEntered = true;
					const result = await this.wait(attempt.operation, () => {
						this.check(attempt.operation);
						return this.ports.post(
							structuredClone(draft),
							{ idempotencyKey, expectedHeadSha },
							signal
						);
					});
					const receipt = z.object({ url: z.url() }).parse(result);
					const url = new URL(receipt.url);
					const target = prURL(record.pr);
					if (
						url.origin !== target.origin ||
						url.pathname !== target.pathname ||
						url.username ||
						url.password ||
						url.search ||
						!/^#(?:issuecomment-\d+|discussion_r\d+)$/.test(url.hash)
					)
						fail("GitHub did not return a receipt for this PR comment");
					return { url: url.href };
				},
			}),
		};
		const path = input.location?.path.split("/").map(encodeURIComponent).join("/");
		const draft = record.core.create({
			prId: pr.id,
			headSha: pr.headSha,
			originalWords: input.body,
			body: input.body,
			...(input.location ? { location: input.location } : {}),
			evidence: {
				kind: "source",
				url: path
					? `https://github.com/${pr.repository}/blob/${pr.headSha}/${path}#L${input.location?.endLine}`
					: pr.url,
				retrievedAt: new Date().toISOString(),
			},
		});
		record.draftId = draft.id;
		this.records.set(draft.id, record);
		return draft;
	}
	private activeAttempt(record: Record, signal: AbortSignal) {
		const attempt = record.requestId ? this.attempts.get(record.requestId) : undefined;
		if (!attempt || attempt.operation.abort.signal !== signal)
			fail("Comment confirmation is unavailable");
		this.check(attempt.operation);
		return attempt;
	}

	async edit(raw: unknown): Promise<DraftedComment> {
		let operation: Operation | undefined;
		try {
			const input = PRCommentEditInputSchema.parse(raw);
			const record = this.record(input.draftId);
			if (record.requestId)
				fail("Submitted comments cannot be edited; reconcile the original request");
			operation = this.begin(record.epoch);
			const draft = record.core.get(input.draftId);
			await this.validate(
				operation,
				{ prId: draft.prId, reviewId: record.reviewId, headSha: draft.headSha },
				draft.location,
				record.pr
			);
			this.check(operation);
			if (record.requestId || record.core.get(input.draftId).revision !== draft.revision)
				fail("Comment draft changed; review its current revision");
			return record.core.edit(input.draftId, input.body);
		} catch (error) {
			throw sanitized(error, "Could not edit this exact PR comment");
		} finally {
			if (operation) this.operations.delete(operation);
		}
	}

	confirm(raw: unknown): Promise<{ url: string }> {
		try {
			const input = ConfirmCommentInputSchema.parse(raw);
			IdSchema.max(200).parse(input.requestId);
			const record = this.record(input.draftId);
			const draft = record.core.get(input.draftId);
			if (
				input.draftRevision !== draft.revision ||
				input.body !== draft.body ||
				input.headSha !== draft.headSha
			)
				fail("Confirmation is stale; review the current draft");
			const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
			const previous = this.attempts.get(input.requestId);
			if (previous && previous.fingerprint !== fingerprint)
				fail("Confirmation request ID reused with different data");
			if (previous && !previous.retryable)
				return previous.result.then((receipt) => {
					this.record(input.draftId);
					return { ...receipt };
				});
			if (this.cancellationFull || this.cancelled.has(input.requestId))
				fail("Comment operation cancelled");
			if (record.requestId && record.requestId !== input.requestId)
				fail("Reconcile the original confirmation request");
			if (!previous && this.attempts.size >= this.capacity)
				fail("Comment session capacity reached");
			const operation = this.begin(record.epoch);
			const attempt: Attempt = {
				fingerprint,
				operation,
				postEntered: false,
				retryable: false,
				result: Promise.resolve().then(async () => {
					this.check(operation);
					return record.core.confirmAndPost(input, operation.abort.signal);
				}),
			};
			record.requestId = input.requestId;
			this.attempts.set(input.requestId, attempt);
			attempt.result = attempt.result
				.then((result) => {
					this.check(operation);
					return result;
				})
				.catch((error) => {
					attempt.retryable = !attempt.postEntered && !operation.abort.signal.aborted;
					throw sanitized(error, "Posting was not confirmed; reconcile the original request");
				})
				.finally(() => this.operations.delete(operation));
			return attempt.result.then((receipt) => ({ ...receipt }));
		} catch (error) {
			return Promise.reject(sanitized(error, "Invalid PR comment confirmation"));
		}
	}

	cancel(requestId: string) {
		try {
			const id = IdSchema.max(200).parse(requestId);
			// Retain before looking up work: cancellation can arrive before confirmation dispatch.
			if (this.cancelled.size < this.capacity) this.cancelled.add(id);
			else if (!this.cancelled.has(id)) {
				this.cancellationFull = true;
				for (const attempt of this.attempts.values()) attempt.operation.abort.abort();
			}
			this.attempts.get(id)?.operation.abort.abort();
		} catch (error) {
			throw sanitized(error, "Invalid comment cancellation");
		}
	}
	invalidate() {
		this.generation++;
		for (const operation of this.operations) operation.abort.abort();
		this.operations.clear();
		this.records.clear();
		this.creates.clear();
		this.attempts.clear();
		// Cancellation tombstones remain fail-closed for this service's lifetime.
	}
	dispose() {
		this.disposed = true;
		this.invalidate();
	}
}
