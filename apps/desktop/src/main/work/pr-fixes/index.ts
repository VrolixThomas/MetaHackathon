import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { CodingProviderSettings } from "../../../shared/contracts/coding-provider";
import { WorkReviewSchema } from "../../../shared/contracts/command-center";
import {
	type PRFixDetail,
	PRFixDetailSchema,
	type PRFixReviewInput,
	PRFixReviewInputSchema,
	type PRFixStartInput,
	PRFixStartInputSchema,
	type PRFixSummary,
	PRFixSummarySchema,
} from "../../../shared/contracts/pr-work";
import { abortable } from "../../agent/cancellation";
import { NEW_CODING_MODEL } from "../../agent/coding-model";
import {
	type CodingTaskInput,
	type CodingTaskResult,
	CodingTaskResultSchema,
} from "../../agent/coding-worker";
import { redactCodingText } from "../../agent/coding-worker-safety";
import {
	type CommentFixSource,
	CommentFixSourceSchema,
	PrCommentFixes,
} from "../../agent/pr-comment-fixes";
import type { WorkJobRuntime } from "../../runtime/work-job-runtime";
import { runPRFixChild } from "./child";
import { type Entry, FixStore, type Store, exclusive, hash, identity } from "./store";

const MAX_RUNNING = 2;
const MAX_DURATION = 20 * 60_000;
const messages = {
	account: "Connect the GitHub account that owns this local work.",
	changed: "The account or connection changed. Refresh before continuing.",
	disposed: "Fix preparation is stopped.",
	storage: "Local fix state could not be read or saved. Existing work was retained.",
	source: "The requested feedback source could not be verified. Refresh it before starting.",
	capacity: "The local fix queue is full. Existing work was retained.",
	missing: "This local fix is unavailable for the current account.",
	request: "This request ID belongs to a different feedback revision. Start a new request.",
	review: "The exact local candidate could not be inspected. Its files were retained.",
	failed: "Fix preparation failed before a confirmed result. Start a new attempt to continue.",
	interrupted:
		"Fix preparation was interrupted. Start a new attempt; retained work was not replayed.",
} as const;
export class PRFixError extends Error {
	constructor(readonly code: keyof typeof messages) {
		super(messages[code]);
	}
}
export interface PRFixServiceOptions {
	directory: string;
	runtime: Pick<WorkJobRuntime, "prepare" | "bootstrap" | "finalize" | "review">;
	workerEntry: string;
	envPath: string;
	codingSettings?: () => Promise<CodingProviderSettings>;
	readSource(
		input: { prId: string; feedbackId: string },
		signal: AbortSignal
	): Promise<CommentFixSource>;
	getAccount(): Promise<string | null>;
	getEpoch(): string | number;
	redact?: (text: string) => string;
	onChanged?: () => void | Promise<void>;
	/** Controlled probes only; production uses the existing app-owned coding-worker child. */
	runWorker?: (input: CodingTaskInput, signal: AbortSignal) => Promise<CodingTaskResult>;
}
type Context = {
	owner: string;
	epoch: string | number;
	generation: number;
	controller: AbortController;
};
type Run = {
	id: string;
	scope: string;
	context: Context;
	execute: () => Promise<void>;
	logs: string[];
	done: Promise<void>;
	finish: () => void;
};
type Queue = { pending: Run[]; active: number; scheduled: boolean };
const leases = new Map<string, Run>();
const queues = new Map<string, Queue>();
const leaseKey = (scope: string, id: string) => `${scope}:${id}`;
function kick(scope: string): void {
	const queue = queues.get(scope);
	if (!queue || queue.scheduled) return;
	queue.scheduled = true;
	setImmediate(() => {
		queue.scheduled = false;
		while (queue.active < MAX_RUNNING && queue.pending.length) {
			const run = queue.pending.shift();
			if (!run) break;
			queue.active++;
			void run
				.execute()
				.catch(() => {})
				.finally(() => {
					leases.delete(leaseKey(scope, run.id));
					queue.active--;
					run.finish();
					kick(scope);
				});
		}
		if (!queue.active && !queue.pending.length) queues.delete(scope);
	});
}
function overlaps(parent: string, child: string): boolean {
	const part = relative(parent, child);
	return !part || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`));
}

/** Local proposed changes only. No publication, author approval or regular worker-queue admission. */
export class PRFixService {
	private readonly store: FixStore;
	private readonly contexts = new Set<Context>();
	private readonly runs = new Set<Run>();
	private generation = 0;
	private disposed = false;
	constructor(private readonly options: PRFixServiceOptions) {
		this.store = new FixStore(options.directory);
		for (const path of [options.workerEntry, options.envPath])
			if (!isAbsolute(path) || resolve(path) !== path || path.includes("\0"))
				throw new Error("Absolute main-owned worker and configuration paths are required");
	}

	async start(raw: PRFixStartInput): Promise<PRFixSummary> {
		const input = PRFixStartInputSchema.parse(raw);
		const codingProvider = (await this.options.codingSettings?.()) ?? {
			provider: "meta-api" as const,
			musePath: null,
		};
		const context = await this.begin();
		let run: Run | undefined;
		try {
			const source = await this.readSource(context, input);
			const fingerprint = hash(source);
			const result = await this.transaction(context, async (state) => {
				const prior = state.requests.find((r) => r.requestId === input.requestId);
				if (prior && prior.fingerprint !== fingerprint) throw new PRFixError("request");
				let entry = prior
					? state.entries.find((e) => e.id === prior.id)
					: state.entries.find(
							(e) =>
								e.fingerprint === fingerprint &&
								e.issue !== "interrupted" &&
								e.issue !== "failed" &&
								e.record?.job.state !== "failed"
						);
				if (!prior && state.requests.length >= 1000) throw new PRFixError("capacity");
				if (!entry) {
					if (state.entries.length >= 100) throw new PRFixError("capacity");
					const now = new Date().toISOString();
					entry = {
						id: input.requestId,
						codingProvider,
						...(codingProvider.provider === "meta-api" ? { codingModel: NEW_CODING_MODEL } : {}),
						jobId: identity(context.owner, input.requestId).jobId,
						source,
						fingerprint,
						createdAt: now,
						updatedAt: now,
						record: null,
						issue: null,
						reviewedAt: null,
						reviewedHeadSha: null,
						logs: [],
					};
					state.entries.push(entry);
				}
				if (!prior) state.requests.push({ requestId: input.requestId, fingerprint, id: entry.id });
				await this.write(context, state);
				if (!prior && entry.record === null && !leases.has(leaseKey(this.scope(context), entry.id)))
					run = this.reserve(context, entry.id);
				return this.summary(entry);
			});
			this.notify(context);
			if (run) kick(run.scope);
			return result;
		} catch (error) {
			if (run) {
				context.controller.abort();
				kick(run.scope);
			}
			throw this.safeError(error);
		} finally {
			if (!run) this.contexts.delete(context);
		}
	}

	async list(): Promise<PRFixSummary[]> {
		return this.api(async (context) =>
			this.transaction(context, async (state) =>
				state.entries
					.map((entry) => this.summary(entry))
					.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
			)
		);
	}

	async detail(id: string): Promise<PRFixDetail> {
		return this.api(async (context) => {
			const entry = await this.entry(context, id);
			await this.currentSource(context, entry);
			if (!entry.record?.job.headSha || entry.record.phase !== "settled")
				return PRFixDetailSchema.parse({ fix: this.summary(entry), review: null });
			try {
				const review = await this.review(context, entry);
				await this.currentSource(context, entry);
				if (entry.issue === "review") {
					await this.transaction(context, async (state) => {
						const current = this.find(state, id);
						current.issue = null;
						await this.write(context, state);
					});
					entry.issue = null;
				}
				return PRFixDetailSchema.parse({ fix: this.summary(entry), review });
			} catch (error) {
				await this.guard(context);
				if (error instanceof PRFixError && error.code !== "review") throw error;
				const failed = await this.transaction(context, async (state) => {
					const current = this.find(state, id);
					current.issue = "review";
					await this.write(context, state);
					return this.summary(current);
				});
				return { fix: failed, review: null };
			}
		});
	}

	async markReviewed(raw: PRFixReviewInput): Promise<PRFixSummary> {
		const input = PRFixReviewInputSchema.parse(raw);
		return this.api(async (context) => {
			const entry = await this.entry(context, input.id);
			if (
				entry.issue === "interrupted" ||
				entry.record?.phase !== "settled" ||
				entry.record.job.headSha !== input.headSha
			)
				throw new PRFixError("review");
			await this.currentSource(context, entry);
			await this.review(context, entry);
			await this.currentSource(context, entry);
			const result = await this.transaction(context, async (state) => {
				const current = this.find(state, input.id);
				if (current.record?.job.headSha !== input.headSha || current.issue === "interrupted")
					throw new PRFixError("review");
				current.reviewedHeadSha = input.headSha;
				current.reviewedAt ??= new Date().toISOString();
				if (current.issue === "review") current.issue = null;
				await this.write(context, state);
				return this.summary(current);
			});
			this.notify(context);
			return result;
		});
	}

	async cancel(id: string): Promise<PRFixSummary> {
		return this.api(async (context) => {
			const result = await this.transaction(context, async (state) => {
				const entry = this.find(state, id);
				if (entry.record?.phase !== "settled") {
					leases.get(leaseKey(this.scope(context), id))?.context.controller.abort();
					entry.issue = "interrupted";
					entry.updatedAt = new Date().toISOString();
					await this.write(context, state);
				}
				return this.summary(entry);
			});
			this.notify(context);
			return result;
		});
	}

	/** Root calls for account changes and sleep. Foreground speech never owns these controllers. */
	invalidate(): void {
		this.generation++;
		for (const context of this.contexts) context.controller.abort();
	}
	async dispose(): Promise<void> {
		this.disposed = true;
		this.invalidate();
		await Promise.allSettled([...this.runs].map((run) => run.done));
	}

	/** Scheduler entry; all failures are observed, safely recorded where the owner is still current. */
	private async runBackground(run: Run): Promise<void> {
		const context = run.context;
		const timer = setTimeout(() => context.controller.abort(), MAX_DURATION);
		timer.unref?.();
		const drains: Promise<unknown>[] = [];
		try {
			await this.guard(context);
			const entry = await this.entry(context, run.id);
			if (entry.issue) return;
			const internalId = identity(context.owner, entry.id).requestId;
			const fixes = new PrCommentFixes({
				withLock: (_id, operation) =>
					exclusive(`${run.scope}:record:${run.id}`, async () => {
						await this.guard(context);
						const value = await operation();
						await this.guard(context);
						return value;
					}),
				load: () => this.entry(context, run.id).then((current) => current.record),
				save: async (_id, record) => {
					await this.transaction(context, async (state) => {
						const current = this.find(state, run.id);
						if (current.issue) throw new PRFixError("interrupted");
						current.record = record;
						current.updatedAt = new Date().toISOString();
						current.logs = [...run.logs];
						await this.write(context, state);
					});
					this.notify(context);
				},
				readCurrentSource: () =>
					this.readSource(context, {
						prId: entry.source.pr.id,
						feedbackId: entry.source.feedback.id,
					}),
				runtime: {
					prepare: (...args) => this.call(context, () => this.options.runtime.prepare(...args)),
					finalize: (...args) => this.call(context, () => this.options.runtime.finalize(...args)),
				},
				checkpointPath: (jobId) => join(run.scope, `${jobId}.checkpoint.json`),
				runWorker: async (raw, signal) => {
					const input = {
						...raw,
						...(entry.codingModel ? { codingModel: entry.codingModel } : {}),
					};
					await this.guard(context);
					const saved = (await this.entry(context, run.id)).record;
					if (
						!saved ||
						saved.phase !== "executing" ||
						saved.job.id !== input.jobId ||
						saved.job.worktreePath !== input.worktreePath ||
						saved.job.repository !== input.repository
					)
						throw new PRFixError("source");
					await this.call(context, () => this.options.runtime.bootstrap(saved.job, signal));
					await this.guard(context);
					this.assertLive(context);
					const operation = this.options.runWorker
						? this.options.runWorker(input, signal)
						: runPRFixChild(
								{
									workerEntry: this.options.workerEntry,
									envPath: this.options.envPath,
									providerSettings: entry.codingProvider ?? {
										provider: "meta-api",
										musePath: null,
									},
									assertLive: () => this.assertLive(context),
									log: (text) => {
										for (const line of this.redact(text).split(/\r?\n/).slice(-40))
											run.logs.push(line.slice(0, 2000));
										run.logs = run.logs.slice(-40);
									},
								},
								input,
								signal
							);
					// Real child retirement remains a capacity lease until its process exits.
					if (!this.options.runWorker) drains.push(operation);
					void operation.catch(() => {});
					const result = CodingTaskResultSchema.parse(await this.call(context, () => operation));
					return {
						...result,
						summary: this.redact(result.summary),
						...(result.question ? { question: this.redact(result.question) } : {}),
						...(result.reason ? { reason: this.redact(result.reason) } : {}),
					};
				},
			});
			const prepared = await fixes.prepare(
				{ ...entry.source, requestId: internalId },
				context.controller.signal
			);
			await this.guard(context);
			await fixes.execute(
				{ requestId: internalId, bindingDigest: prepared.bindingDigest },
				context.controller.signal
			);
		} catch {
			try {
				// Stale owners never write cleanup into a new account's scope. Recovery is read-time only.
				this.assertLive(context);
				await this.transaction(context, async (state) => {
					const current = this.find(state, run.id);
					current.issue ??= current.record?.phase === "executing" ? "interrupted" : "failed";
					current.logs = [...run.logs];
					current.updatedAt = new Date().toISOString();
					await this.write(context, state);
				});
			} catch {
				/* Admission remains durable; the next authorized read marks it interrupted. */
			}
		} finally {
			if (this.options.onChanged) {
				try {
					await this.call(context, async () => {
						await this.options.onChanged?.();
					});
				} catch {}
			}
			context.controller.abort();
			await Promise.allSettled(drains);
			clearTimeout(timer);
			this.notify(context);
			this.contexts.delete(context);
			this.runs.delete(run);
		}
	}

	private reserve(context: Context, id: string): Run {
		const scope = this.scope(context);
		let finish = () => {};
		const done = new Promise<void>((resolveDone) => {
			finish = resolveDone;
		});
		const run: Run = {
			id,
			scope,
			context,
			execute: () => this.runBackground(run),
			logs: [],
			done,
			finish,
		};
		leases.set(leaseKey(scope, id), run);
		this.runs.add(run);
		const queue = queues.get(scope) ?? { pending: [], active: 0, scheduled: false };
		queue.pending.push(run);
		queues.set(scope, queue);
		return run;
	}
	private scope(context: Context): string {
		return this.store.scope(context.owner);
	}
	private assertLive(context: Context): void {
		if (this.disposed) throw new PRFixError("disposed");
		if (
			context.generation !== this.generation ||
			context.epoch !== this.options.getEpoch() ||
			context.controller.signal.aborted
		) {
			context.controller.abort();
			throw new PRFixError("changed");
		}
	}
	private async guard(context: Context): Promise<void> {
		this.assertLive(context);
		let owner: string | null;
		try {
			owner = await abortable(this.options.getAccount(), context.controller.signal);
		} catch {
			throw new PRFixError("account");
		}
		this.assertLive(context);
		if (!owner || owner.toLowerCase() !== context.owner) {
			context.controller.abort();
			throw new PRFixError("changed");
		}
	}
	private async begin(): Promise<Context> {
		const context: Context = {
			owner: "",
			epoch: this.options.getEpoch(),
			generation: this.generation,
			controller: new AbortController(),
		};
		this.contexts.add(context);
		try {
			this.assertLive(context);
			let account: string | null;
			try {
				account = await abortable(this.options.getAccount(), context.controller.signal);
			} catch {
				throw new PRFixError("account");
			}
			this.assertLive(context);
			if (!account || !z.string().min(1).max(200).safeParse(account).success)
				throw new PRFixError("account");
			context.owner = account.toLowerCase();
			return context;
		} catch (error) {
			this.contexts.delete(context);
			throw this.safeError(error);
		}
	}
	private async api<T>(operation: (context: Context) => Promise<T>): Promise<T> {
		const context = await this.begin();
		try {
			const result = await operation(context);
			await this.guard(context);
			return result;
		} catch (error) {
			throw this.safeError(error);
		} finally {
			this.contexts.delete(context);
		}
	}
	private async call<T>(context: Context, operation: () => Promise<T>): Promise<T> {
		await this.guard(context);
		const value = await abortable(operation(), context.controller.signal);
		await this.guard(context);
		return value;
	}
	private async readSource(
		context: Context,
		identity: { prId: string; feedbackId: string }
	): Promise<CommentFixSource> {
		try {
			const source = CommentFixSourceSchema.parse(
				await this.call(context, () => this.options.readSource(identity, context.controller.signal))
			);
			if (
				source.pr.id !== identity.prId ||
				source.feedback.id !== identity.feedbackId ||
				source.feedback.prId !== source.pr.id ||
				source.repository.repository !== source.pr.repository
			)
				throw new PRFixError("source");
			const original = source.repository.localPath;
			if (original && (overlaps(original, this.store.root) || overlaps(this.store.root, original)))
				throw new PRFixError("source");
			return source;
		} catch (error) {
			await this.guard(context);
			if (error instanceof PRFixError) throw error;
			throw new PRFixError("source");
		}
	}
	private async currentSource(context: Context, entry: Entry): Promise<void> {
		const source = await this.readSource(context, {
			prId: entry.source.pr.id,
			feedbackId: entry.source.feedback.id,
		});
		if (hash(source) !== entry.fingerprint) throw new PRFixError("source");
	}
	private async transaction<T>(
		context: Context,
		operation: (state: Store) => Promise<T>
	): Promise<T> {
		await this.guard(context);
		const result = await exclusive(this.scope(context), async () => {
			const state = await this.call(context, () => this.store.read(context.owner));
			let recovered = false;
			for (const entry of state.entries) {
				const lease = leases.get(leaseKey(this.scope(context), entry.id));
				if (
					!entry.issue &&
					entry.record?.phase !== "settled" &&
					(!lease || lease.context.controller.signal.aborted)
				) {
					entry.issue = "interrupted";
					entry.updatedAt = new Date().toISOString();
					recovered = true;
				}
			}
			if (recovered) await this.write(context, state);
			await this.guard(context);
			return operation(state);
		});
		await this.guard(context);
		return result;
	}
	private async write(context: Context, state: Store): Promise<void> {
		await this.guard(context);
		// Never race an atomic durability write against cancellation.
		await this.store.write(state, () => this.assertLive(context));
		await this.guard(context);
	}
	private find(state: Store, id: string): Entry {
		const entry = state.entries.find((entry) => entry.id === id);
		if (!entry) throw new PRFixError("missing");
		return entry;
	}
	private entry(context: Context, id: string): Promise<Entry> {
		return this.transaction(context, async (state) => structuredClone(this.find(state, id)));
	}
	private summary(entry: Entry): PRFixSummary {
		const record = entry.record;
		const job = record?.job;
		const phase =
			entry.issue === "interrupted"
				? "interrupted"
				: entry.issue
					? "failed"
					: record?.phase === "settled"
						? job?.state === "ready"
							? "ready"
							: job?.state === "needs-input"
								? "needs-input"
								: "failed"
						: (record?.phase ?? "preparing");
		return PRFixSummarySchema.parse({
			id: entry.id,
			jobId: entry.jobId,
			pr: entry.source.pr,
			feedback: entry.source.feedback,
			phase,
			summary: entry.issue ? messages[entry.issue] : (job?.summary ?? ""),
			question: record?.outcome?.worker.question ?? null,
			baseSha: entry.source.pr.headSha,
			headSha: job?.headSha ?? null,
			checks: job?.checks ?? [],
			changedFiles: job?.changedFiles ?? [],
			createdAt: entry.createdAt,
			updatedAt: entry.updatedAt,
			reviewedAt: entry.reviewedHeadSha === job?.headSha ? entry.reviewedAt : null,
			error: entry.issue
				? messages[entry.issue]
				: job?.state === "failed"
					? "One or more local checks failed. Inspect the actual candidate and check results."
					: null,
			publication: "not-published",
		});
	}
	private async review(context: Context, entry: Entry) {
		if (!entry.record?.job.headSha) throw new PRFixError("review");
		try {
			const job = entry.record.job;
			const review = WorkReviewSchema.parse(
				await this.call(context, () =>
					exclusive(`${this.scope(context)}:runtime-review:${job.id}`, async () => {
						await this.guard(context);
						return this.options.runtime.review(structuredClone(job), context.controller.signal);
					})
				)
			);
			if (
				!isDeepStrictEqual(review.job, job) ||
				!isDeepStrictEqual(review.files.map((f) => f.path).sort(), [...job.changedFiles].sort()) ||
				review.files.some(
					(f) => f.base.commitSha !== job.baseSha || f.head.commitSha !== job.headSha
				)
			)
				throw new PRFixError("review");
			return review;
		} catch (error) {
			if (error instanceof PRFixError) throw error;
			throw new PRFixError("review");
		}
	}
	private redact(text: string): string {
		return redactCodingText(this.options.redact?.(text) ?? text);
	}
	private safeError(error: unknown): PRFixError {
		return error instanceof PRFixError ? error : new PRFixError("storage");
	}
	private notify(context: Context): void {
		if (this.options.onChanged)
			void this.call(context, async () => {
				this.assertLive(context);
				await this.options.onChanged?.();
			}).catch(() => {});
	}
}
