import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
	ConversationActionReceiptSchema,
	type ConversationPRContext,
	ConversationPRContextSchema,
	GitHubRepositorySchema,
	IdSchema,
	type PinnedReviewFileRequest,
	type PreparedReview,
	PreparedReviewSchema,
	type PullRequest,
	PullRequestSchema,
	RepositoryPathSchema,
	type ReviewCache,
	ReviewCacheSchema,
	type ReviewDetail,
	ReviewDetailSchema,
	type ReviewFile,
	ReviewFileRequestSchema,
	ReviewFileSchema,
	type ReviewInbox,
	ReviewInboxSchema,
	type ReviewNavigation,
	ReviewNavigationSchema,
	type ReviewProgress,
	ReviewProgressSchema,
	type ReviewScreen,
	ReviewScreenSchema,
} from "../../shared/contracts";

export const ConnectReviewSchema = z.strictObject({
	repository: GitHubRepositorySchema,
	localPath: z
		.string()
		.trim()
		.min(1)
		.max(4096)
		.refine((path) => !path.includes("\0"))
		.nullable()
		.optional(),
});
export const ReviewProgressInputSchema = ReviewFileRequestSchema.extend({
	path: RepositoryPathSchema.nullable(),
	paused: z.boolean(),
});
export const UpdateReviewScreenSchema = z.strictObject({
	sessionId: IdSchema,
	screen: ReviewScreenSchema,
});
const ReadReviewSnapshotSchema = UpdateReviewScreenSchema.extend({
	prId: IdSchema,
	includeSource: z.boolean(),
});
const NavigateSchema = z.strictObject({
	direction: z.enum(["start", "next", "previous", "resume", "pause"]).optional(),
	path: RepositoryPathSchema.optional(),
	line: z.int().positive().optional(),
	side: z.enum(["base", "head"]).optional(),
});
export interface ReviewCoordinatorPorts {
	loadCache(): ReviewCache | Promise<ReviewCache>;
	saveCache(cache: ReviewCache): void | Promise<void>;
	listOpen(repository: string, signal: AbortSignal): Promise<PullRequest[]>;
	readPR(prId: string, signal: AbortSignal): Promise<PullRequest>;
	getContext(prId: string, signal: AbortSignal): Promise<ConversationPRContext>;
	readFile(
		input: PinnedReviewFileRequest,
		localPath: string | null,
		signal: AbortSignal
	): Promise<ReviewFile>;
	prepare(context: ConversationPRContext, signal: AbortSignal): Promise<PreparedReview>;
	beforeRetry?(prId: string, signal: AbortSignal): Promise<void>;
	validateLocal?(path: string, repository: string, signal: AbortSignal): Promise<string>;
	pollIntervalMs?: number;
}
type Entry = ReviewDetail & { abort: AbortController };
type Receipt = z.infer<typeof ConversationActionReceiptSchema>;
class ReviewError extends Error {}
const samePR = (a: PullRequest, b: PullRequest) =>
	a.id === b.id &&
	a.repository.toLowerCase() === b.repository.toLowerCase() &&
	a.number === b.number;
const sameRevision = (a: PullRequest, b: PullRequest) =>
	samePR(a, b) && a.baseSha === b.baseSha && a.headSha === b.headSha;
const emptyScreen = (): ReviewScreen => ({ sequence: 0, mode: "conversation", prId: null });
const clone = <T>(value: T): T => structuredClone(value);
function fail(message: string): never {
	throw new ReviewError(message);
}

/** One connected repository, one preparation worker. Ports own GitHub, immutable Git reads and SQLite. */
export class ReviewCoordinator {
	private repository: string | null = null;
	private localPath: string | null = null;
	private entries = new Map<string, Entry>();
	private screens = new Map<string, ReviewScreen>();
	private lifetime = new AbortController();
	private connection = new AbortController();
	private candidate?: AbortController;
	private initialized?: Promise<void>;
	private worker?: Promise<void>;
	private refreshing?: Promise<ReviewInbox>;
	private timer?: ReturnType<typeof setInterval>;
	private connected = false;
	private revision = 0;
	private lastRefreshedAt: string | null = null;
	private error?: string;
	private storage: Promise<unknown> = Promise.resolve();
	private jobs = new Set<Promise<unknown>>();
	private callbacks = new Set<Promise<unknown>>();
	private disposal?: Promise<void>;
	constructor(private readonly ports: ReviewCoordinatorPorts) {}

	private live(signal?: AbortSignal) {
		if (this.lifetime.signal.aborted || signal?.aborted) fail("Review operation was cancelled.");
	}
	private track<T>(job: Promise<T>): Promise<T> {
		this.jobs.add(job);
		void job.finally(() => this.jobs.delete(job)).catch(() => {});
		return job;
	}
	private request<T>(work: (signal: AbortSignal) => Promise<T>, caller?: AbortSignal): Promise<T> {
		if (this.jobs.size >= 256)
			return Promise.reject(
				new ReviewError("Too many pending review requests. Try again shortly.")
			);
		const signal = AbortSignal.any([this.lifetime.signal, ...(caller ? [caller] : [])]);
		return this.track(
			(async () => {
				try {
					this.live(signal);
					await this.initialize();
					this.live(signal);
					return await work(signal);
				} catch (error) {
					throw error instanceof ReviewError
						? error
						: new ReviewError("Review request failed. Refresh the repository and try again.");
				}
			})()
		);
	}
	/** Bound port waits even if an implementation ignores cancellation; late callbacks only settle this wrapper. */
	private call<T>(
		signal: AbortSignal,
		work: (signal: AbortSignal) => Promise<T>,
		message: string,
		timeout = 30_000
	): Promise<T> {
		this.live(signal);
		if (this.callbacks.size >= 256)
			return Promise.reject(
				new ReviewError("Review providers are not responding. Reconnect after they recover.")
			);
		const bounded = AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(timeout)]);
		const underlying = Promise.resolve().then(() => {
			this.live(bounded);
			return work(bounded);
		});
		this.callbacks.add(underlying);
		void underlying.finally(() => this.callbacks.delete(underlying)).catch(() => {});
		return new Promise<T>((resolve, reject) => {
			const abort = () =>
				reject(
					new ReviewError(
						signal.aborted || this.lifetime.signal.aborted
							? "Review operation was cancelled."
							: message
					)
				);
			bounded.addEventListener("abort", abort, { once: true });
			if (bounded.aborted) abort();
			void underlying
				.then(
					(value) => {
						if (bounded.aborted) abort();
						else resolve(value);
					},
					() => reject(new ReviewError(message))
				)
				.finally(() => bounded.removeEventListener("abort", abort));
		});
	}
	private snapshot(): ReviewInbox {
		return ReviewInboxSchema.parse({
			repository: this.repository,
			localPath: this.localPath,
			items: [...this.entries.values()].map(({ abort: _, ...detail }) => detail),
			refreshing: Boolean(this.refreshing),
			lastRefreshedAt: this.lastRefreshedAt,
			...(this.error ? { error: this.error } : {}),
		});
	}
	private cache(
		progress?: { entry: Entry; value: ReviewProgress },
		connection?: { repository: string; localPath: string | null; entries: Map<string, Entry> }
	): ReviewCache {
		const entries = [...(connection?.entries ?? this.entries).values()];
		return ReviewCacheSchema.parse({
			repository: connection ? connection.repository : this.repository,
			localPath: connection ? connection.localPath : this.localPath,
			prepared: entries.flatMap((entry) => (entry.prepared ? [entry.prepared] : [])),
			progress: entries.flatMap((entry) => {
				const value = progress?.entry === entry ? progress.value : entry.progress;
				return entry.prepared && value ? [value] : [];
			}),
		});
	}
	private save(work: () => Promise<void>): Promise<void> {
		const operation = this.storage.then(work).catch((error) => {
			if (error instanceof ReviewError) throw error;
			fail("Could not save review progress. Check local storage and try again.");
		});
		this.storage = operation.catch(() => {});
		return this.track(operation);
	}
	private persist(): Promise<void> {
		return this.save(async () => {
			this.live();
			await this.ports.saveCache(this.cache());
		});
	}
	private commitPrepared(
		entry: Entry,
		prepared: PreparedReview,
		signal: AbortSignal
	): Promise<void> {
		return this.save(async () => {
			const valid = () => {
				this.current(entry, signal);
				if (
					entry.status !== "preparing" ||
					entry.prepared ||
					entry.progress ||
					!sameRevision(entry.pr, prepared.pr)
				)
					fail("Prepared review was replaced. Open its latest version.");
			};
			valid();
			// Build from the latest committed state inside the storage queue. The candidate stays private.
			const candidate = this.cache();
			candidate.prepared.push(prepared);
			try {
				await this.ports.saveCache(ReviewCacheSchema.parse(candidate));
				valid();
			} catch (error) {
				// Head changes/cancellation may occur during an async save. Restore current state,
				// not a captured older snapshot, before releasing the queue or completing shutdown.
				await this.ports.saveCache(this.cache());
				throw error;
			}
			entry.prepared = prepared;
			entry.progress = null;
			entry.status = "ready";
		});
	}
	private validatePrepared(raw: PreparedReview, context?: ConversationPRContext): PreparedReview {
		const review = PreparedReviewSchema.parse(raw);
		if (
			context &&
			(!sameRevision(review.pr, context.pr) ||
				review.files.some((file) => !context.files.some((changed) => changed.path === file.path)))
		)
			fail("Prepared review does not match the pull request. Prepare it again.");
		if (
			context &&
			review.coverage === "complete" &&
			(context.truncated || review.files.length !== context.files.length)
		)
			fail("Prepared review coverage is incomplete. Prepare it again.");
		for (const file of review.files)
			for (const comment of file.suggestedComments) {
				const at = comment.location;
				if (
					at &&
					(at.path !== file.path ||
						at.repository !== review.pr.repository ||
						at.commitSha !== (at.revision === "base" ? review.pr.baseSha : review.pr.headSha))
				)
					fail("Prepared comment references a different revision. Prepare the review again.");
			}
		return review;
	}
	private validateProgress(progress: ReviewProgress, review: PreparedReview) {
		if (
			progress.reviewId !== review.id ||
			progress.prId !== review.pr.id ||
			progress.baseSha !== review.pr.baseSha ||
			progress.headSha !== review.pr.headSha ||
			[...(progress.path ? [progress.path] : []), ...progress.visited].some(
				(path) => !review.files.some((file) => file.path === path)
			) ||
			new Set(progress.visited).size !== progress.visited.length
		)
			fail("Saved review progress is stale. Reopen the current review.");
	}
	initialize(): Promise<void> {
		if (this.lifetime.signal.aborted)
			return Promise.reject(new ReviewError("Review operation was cancelled."));
		this.initialized ??= this.track(
			(async () => {
				this.live();
				let cache: ReviewCache;
				try {
					cache = ReviewCacheSchema.parse(await this.ports.loadCache());
				} catch {
					fail("Could not load saved reviews. Check local storage and restart.");
				}
				this.live();
				this.repository = cache.repository;
				this.localPath = cache.localPath;
				for (const raw of cache.prepared) {
					const prepared = this.validatePrepared(raw);
					if (
						!cache.repository ||
						prepared.pr.repository.toLowerCase() !== cache.repository.toLowerCase() ||
						this.entries.has(prepared.pr.id)
					)
						fail("Saved reviews do not match the repository. Check local storage and restart.");
					const progress = cache.progress.find((item) => item.prId === prepared.pr.id) ?? null;
					if (progress) this.validateProgress(progress, prepared);
					this.entries.set(prepared.pr.id, {
						pr: prepared.pr,
						prepared,
						progress,
						status: "ready",
						abort: new AbortController(),
					});
				}
				if (cache.repository) {
					try {
						const candidate = await this.validateConnection(
							cache.repository,
							cache.localPath,
							this.connection.signal
						);
						this.live();
						this.connected = true;
						this.localPath = candidate.localPath;
						this.reconcile(candidate.prs);
						await this.persist();
						this.live();
						this.startPolling();
						this.schedule();
					} catch {
						this.live();
						this.error =
							"Could not resume the repository. Check GitHub access and the local path, then reconnect.";
					}
				}
			})()
		);
		return this.initialized;
	}
	private async validateConnection(
		repository: string,
		localPath: string | null,
		signal: AbortSignal
	) {
		let validatedPath = localPath;
		if (localPath) {
			const validate = this.ports.validateLocal;
			if (!validate)
				fail("Local repository support is unavailable. Select a supported repository connection.");
			validatedPath = await this.call(
				signal,
				(active) => validate(localPath, repository, active),
				"Local repository does not match GitHub or is unavailable. Check its origin and path."
			);
			ConnectReviewSchema.parse({ repository, localPath: validatedPath });
		}
		const prs = this.validateList(
			await this.call(
				signal,
				(active) => this.ports.listOpen(repository, active),
				"Could not list pull requests. Check the repository name and GitHub token."
			),
			repository
		);
		return { localPath: validatedPath, prs };
	}
	private validateList(raw: PullRequest[], repository: string) {
		const prs = z.array(PullRequestSchema).max(200).parse(raw);
		if (
			new Set(prs.map((pr) => pr.id)).size !== prs.length ||
			prs.some((pr) => pr.repository.toLowerCase() !== repository.toLowerCase())
		)
			fail("GitHub returned an inconsistent repository list. Refresh and try again.");
		return prs;
	}
	connect(raw: z.infer<typeof ConnectReviewSchema>): Promise<ReviewInbox> {
		this.candidate?.abort();
		const candidate = new AbortController();
		this.candidate = candidate;
		return this.request(async (signal) => {
			const input = ConnectReviewSchema.parse(raw);
			const active = AbortSignal.any([signal, candidate.signal]);
			const revision = this.revision;
			const result = await this.validateConnection(
				input.repository,
				input.localPath ?? null,
				active
			);
			let committed: ReviewInbox | undefined;
			await this.save(async () => {
				const valid = () => {
					this.live(active);
					if (this.candidate !== candidate || this.revision !== revision)
						fail("Repository changed while connecting. Try connecting again.");
				};
				valid();
				const entries = new Map<string, Entry>();
				for (const pr of result.prs) {
					const previous =
						this.repository?.toLowerCase() === input.repository.toLowerCase()
							? this.entries.get(pr.id)
							: undefined;
					entries.set(
						pr.id,
						previous && sameRevision(previous.pr, pr)
							? {
									...this.detail(previous),
									pr,
									abort: new AbortController(),
									status: previous.status === "preparing" ? "queued" : previous.status,
								}
							: this.queued(pr)
					);
				}
				try {
					await this.ports.saveCache(
						this.cache(undefined, {
							repository: input.repository,
							localPath: result.localPath,
							entries,
						})
					);
					valid();
				} catch (error) {
					// The accepted connection remains live; restore its latest state, including progress.
					await this.ports.saveCache(this.cache());
					throw error;
				}
				this.connection.abort();
				for (const entry of this.entries.values()) entry.abort.abort();
				this.connection = new AbortController();
				this.refreshing = undefined;
				this.repository = input.repository;
				this.localPath = result.localPath;
				this.connected = true;
				this.entries = entries;
				this.revision++;
				this.error = undefined;
				this.lastRefreshedAt = new Date().toISOString();
				this.startPolling();
				this.schedule();
				committed = this.snapshot();
			});
			return committed as ReviewInbox;
		});
	}
	disconnect(): Promise<ReviewInbox> {
		this.candidate?.abort();
		this.connection.abort();
		return this.request(async () => {
			this.stopPolling();
			this.connected = false;
			this.repository = null;
			this.localPath = null;
			for (const entry of this.entries.values()) entry.abort.abort();
			this.entries.clear();
			this.revision++;
			this.error = undefined;
			this.lastRefreshedAt = null;
			this.refreshing = undefined;
			await this.persist();
			return this.snapshot();
		});
	}
	private startPolling() {
		this.stopPolling();
		this.timer = setInterval(
			() => {
				void this.refresh().catch(() => {});
			},
			Math.max(10, this.ports.pollIntervalMs ?? 60_000)
		);
		this.timer.unref();
	}
	private stopPolling() {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}
	private reconcile(prs: PullRequest[]) {
		const next = new Map<string, Entry>();
		for (const pr of prs) {
			const previous = this.entries.get(pr.id);
			if (previous && sameRevision(previous.pr, pr)) {
				previous.pr = pr;
				if (previous.abort.signal.aborted) {
					previous.abort = new AbortController();
					if (previous.status === "preparing") previous.status = "queued";
				}
				next.set(pr.id, previous);
			} else {
				previous?.abort.abort();
				next.set(pr.id, this.queued(pr));
			}
		}
		for (const [id, entry] of this.entries) if (!next.has(id)) entry.abort.abort();
		this.entries = next;
		this.revision++;
		this.error = undefined;
		this.lastRefreshedAt = new Date().toISOString();
	}
	private queued(pr: PullRequest): Entry {
		return { pr, status: "queued", prepared: null, progress: null, abort: new AbortController() };
	}
	inbox(): Promise<ReviewInbox> {
		return this.request(async () => this.snapshot());
	}
	refresh(): Promise<ReviewInbox> {
		return this.request(async () => {
			if (!this.repository || !this.connected) return this.snapshot();
			if (this.refreshing) return this.refreshing;
			const repository = this.repository;
			const signal = this.connection.signal;
			const revision = this.revision;
			const refresh = Promise.resolve()
				.then(async () => {
					try {
						const prs = this.validateList(
							await this.call(
								signal,
								(active) => this.ports.listOpen(repository, active),
								"Could not refresh pull requests. Check GitHub access and refresh again."
							),
							repository
						);
						this.live(signal);
						if (revision === this.revision) {
							this.reconcile(prs);
							await this.persist();
							this.live(signal);
							this.schedule();
						}
					} catch {
						this.live(signal);
						this.error = "Could not refresh pull requests. Check GitHub access and refresh again.";
					}
				})
				.finally(() => {
					if (this.refreshing === refresh) this.refreshing = undefined;
				})
				.then(() => this.snapshot());
			this.refreshing = refresh;
			return refresh;
		});
	}
	private schedule() {
		if (this.worker || !this.connected || this.lifetime.signal.aborted) return;
		this.worker = this.track(
			(async () => {
				while (!this.lifetime.signal.aborted && this.connected) {
					const entry = [...this.entries.values()].find((item) => item.status === "queued");
					if (!entry) break;
					const signal = AbortSignal.any([this.connection.signal, entry.abort.signal]);
					entry.status = "preparing";
					try {
						const context = ConversationPRContextSchema.parse(
							await this.call(
								signal,
								(active) => this.ports.getContext(entry.pr.id, active),
								"Could not read PR changes. Check GitHub access and prepare again."
							)
						);
						this.current(entry, signal);
						await this.acceptRevision(entry, context.pr, signal);
						const prepared = this.validatePrepared(
							await this.call(
								signal,
								(active) => this.ports.prepare(context, active),
								"Review preparation failed. Check your connections in Settings, then retry.",
								120_000
							),
							context
						);
						await this.revalidate(entry, signal);
						this.current(entry, signal);
						if (!sameRevision(prepared.pr, entry.pr))
							fail("Prepared review changed revision. Prepare it again.");
						await this.commitPrepared(entry, prepared, signal);
					} catch (error) {
						if (
							!signal.aborted &&
							!this.lifetime.signal.aborted &&
							this.entries.get(entry.pr.id) === entry
						) {
							entry.status = "error";
							entry.prepared = null;
							entry.progress = null;
							entry.error =
								error instanceof ReviewError
									? error.message
									: "Review preparation returned invalid data. Prepare the review again.";
						}
					}
				}
			})().finally(() => {
				this.worker = undefined;
				if ([...this.entries.values()].some((entry) => entry.status === "queued")) this.schedule();
			})
		);
	}
	private entry(prId: string) {
		this.live();
		const entry = this.entries.get(IdSchema.parse(prId));
		if (!this.connected || !entry)
			fail("This PR is not in the connected repository. Refresh the inbox.");
		return entry;
	}
	private current(entry: Entry, signal: AbortSignal) {
		this.live(signal);
		if (!this.connected || this.entries.get(entry.pr.id) !== entry || entry.abort.signal.aborted)
			fail("Review changed. Open its latest prepared version.");
	}
	private async acceptRevision(entry: Entry, raw: PullRequest, signal: AbortSignal) {
		this.current(entry, signal);
		const pr = PullRequestSchema.parse(raw);
		if (!samePR(entry.pr, pr)) fail("GitHub returned a different pull request. Refresh the inbox.");
		if (!sameRevision(entry.pr, pr)) {
			entry.abort.abort();
			this.entries.set(pr.id, this.queued(pr));
			this.revision++;
			await this.persist();
			this.schedule();
			fail("Pull request changed. A fresh review is being prepared.");
		}
	}
	private async revalidate(entry: Entry, caller: AbortSignal) {
		const signal = AbortSignal.any([caller, this.connection.signal, entry.abort.signal]);
		await this.acceptRevision(
			entry,
			await this.call(
				signal,
				(active) => this.ports.readPR(entry.pr.id, active),
				"Could not verify the current PR. Check GitHub access and refresh."
			),
			signal
		);
	}
	private detail(entry: Entry): ReviewDetail {
		const { abort: _, ...detail } = entry;
		return ReviewDetailSchema.parse(detail);
	}
	get(prId: string): Promise<ReviewDetail> {
		return this.request(async () => this.detail(this.entry(prId)));
	}
	prepareReview(prId: string, force = false): Promise<ReviewDetail> {
		return this.request(async (signal) => {
			let entry = this.entry(prId);
			await this.revalidate(entry, signal);
			if (force || entry.status === "error") {
				await this.ports.beforeRetry?.(prId, signal);
				entry.abort.abort();
				entry = this.queued(entry.pr);
				this.entries.set(prId, entry);
				this.revision++;
				await this.persist();
			}
			this.schedule();
			return this.detail(entry);
		});
	}
	private async ready(prId: string, signal: AbortSignal) {
		const entry = this.entry(prId);
		await this.revalidate(entry, signal);
		this.current(entry, signal);
		if (entry.status !== "ready" || !entry.prepared)
			fail(entry.error ?? "Review is still being prepared. Open it when the inbox shows ready.");
		return { entry, review: entry.prepared };
	}
	getReady(prId: string, signal: AbortSignal): Promise<PreparedReview> {
		return this.request(async (active) => clone((await this.ready(prId, active)).review), signal);
	}
	getProgress(prId: string, signal: AbortSignal): Promise<ReviewProgress | null> {
		return this.request(
			async (active) => clone((await this.ready(prId, active)).entry.progress),
			signal
		);
	}
	/** Fresh operation-local context; source reads retain both authoritative revision checks. */
	readSnapshot(
		raw: z.infer<typeof ReadReviewSnapshotSchema>,
		caller: AbortSignal
	): Promise<{
		review: PreparedReview | null;
		progress: ReviewProgress | null;
		file: ReviewFile | null;
	}> {
		return this.request(async (active) => {
			const input = ReadReviewSnapshotSchema.parse(raw);
			const entry = this.entry(input.prId);
			const signal = AbortSignal.any([active, this.connection.signal, entry.abort.signal]);
			const valid = () => {
				this.current(entry, signal);
				if (
					input.screen.prId !== input.prId ||
					!isDeepStrictEqual(this.screens.get(input.sessionId), input.screen)
				)
					fail("The selected review or file changed. Continue from the current file.");
				this.checkScreen(input.sessionId, input.screen, true);
			};
			valid();
			await this.revalidate(entry, signal);
			valid();
			const review = entry.prepared;
			if (entry.status !== "ready" || !review) return { review: null, progress: null, file: null };
			const file =
				input.includeSource && input.screen.mode === "review" && input.screen.path
					? await this.readFile(entry, review, input.screen.path, signal)
					: null;
			// readFile verifies the exact source pins and the PR again after the provider read.
			// A replaced plan, connection or acknowledged screen cannot reuse this operation.
			valid();
			if (entry.prepared !== review) fail("Prepared review changed. Reopen it.");
			if (entry.progress) this.validateProgress(entry.progress, review);
			return clone({ review, progress: entry.progress, file });
		}, caller);
	}
	private assertPath(review: PreparedReview, reviewId: string, path: string | null) {
		if (
			review.id !== reviewId ||
			(path !== null && !review.files.some((file) => file.path === path))
		)
			fail("This file or progress belongs to an old review. Reopen the current review.");
	}
	private async readFile(entry: Entry, review: PreparedReview, path: string, caller: AbortSignal) {
		const signal = AbortSignal.any([caller, this.connection.signal, entry.abort.signal]);
		this.assertPath(review, review.id, path);
		const result = ReviewFileSchema.parse(
			await this.call(
				signal,
				(active) =>
					this.ports.readFile(
						{ prId: review.pr.id, baseSha: review.pr.baseSha, headSha: review.pr.headSha, path },
						this.localPath,
						active
					),
				"Could not read the pinned file. Check the local repository or GitHub access."
			)
		);
		this.current(entry, signal);
		if (
			result.prId !== review.pr.id ||
			result.path !== path ||
			(result.status !== "renamed" && result.base.path !== path) ||
			result.head.path !== path ||
			result.base.commitSha !== review.pr.baseSha ||
			result.head.commitSha !== review.pr.headSha ||
			[result.base, result.head].some(
				(source) => (source.status === "available") !== (source.content !== null)
			)
		)
			fail("File content does not match the prepared revision. Refresh the review.");
		await this.revalidate(entry, signal);
		this.current(entry, signal);
		return result;
	}
	file(raw: z.infer<typeof ReviewFileRequestSchema>, caller?: AbortSignal): Promise<ReviewFile> {
		return this.request(async (signal) => {
			const input = ReviewFileRequestSchema.parse(raw);
			const { entry, review } = await this.ready(input.prId, signal);
			this.assertPath(review, input.reviewId, input.path);
			return this.readFile(entry, review, input.path, signal);
		}, caller);
	}
	private progressValue(
		entry: Entry,
		review: PreparedReview,
		path: string | null,
		paused: boolean
	): ReviewProgress {
		return ReviewProgressSchema.parse({
			reviewId: review.id,
			prId: review.pr.id,
			baseSha: review.pr.baseSha,
			headSha: review.pr.headSha,
			path,
			paused,
			visited: [...new Set([...(entry.progress?.visited ?? []), ...(path ? [path] : [])])],
			updatedAt: new Date().toISOString(),
		});
	}
	private async commitProgress(
		entry: Entry,
		review: PreparedReview,
		path: string | null,
		paused: boolean,
		signal: AbortSignal,
		screen?: { sessionId: string; screen: ReviewScreen }
	) {
		let result: ReviewProgress | undefined;
		await this.save(async () => {
			const valid = () => {
				this.current(entry, signal);
				if (entry.prepared !== review) fail("Prepared review changed. Reopen it.");
				if (screen) this.checkScreen(screen.sessionId, screen.screen, true);
			};
			valid();
			const next = this.progressValue(entry, review, path, paused);
			await this.ports.saveCache(this.cache({ entry, value: next }));
			try {
				valid();
			} catch (error) {
				await this.ports.saveCache(this.cache());
				throw error;
			}
			entry.progress = next;
			if (screen) this.screens.set(screen.sessionId, clone(screen.screen));
			result = next;
		});
		return clone(result as ReviewProgress);
	}
	progress(raw: z.infer<typeof ReviewProgressInputSchema>): Promise<ReviewProgress> {
		return this.request(async (signal) => {
			const input = ReviewProgressInputSchema.parse(raw);
			const { entry, review } = await this.ready(input.prId, signal);
			this.assertPath(review, input.reviewId, input.path);
			return this.commitProgress(entry, review, input.path, input.paused, signal);
		});
	}
	/** One live authorization/revision check for workspace preparation and target selection.
	 * Main-only seam: callers must still validate the displayed/durable receipt separately.
	 */
	prepareNavigation(
		prId: string,
		raw: z.infer<typeof NavigateSchema>,
		caller: AbortSignal
	): Promise<{ review: PreparedReview; navigation: ReviewNavigation }> {
		return this.request(async (signal) => {
			const input = NavigateSchema.parse(raw);
			const { entry, review } = await this.ready(prId, signal);
			const navigation = await this.navigation(entry, review, input, signal);
			this.current(entry, signal);
			return { review: clone(review), navigation };
		}, caller);
	}
	navigate(
		prId: string,
		raw: z.infer<typeof NavigateSchema>,
		caller: AbortSignal
	): Promise<ReviewNavigation> {
		return this.prepareNavigation(prId, raw, caller).then(({ navigation }) => navigation);
	}
	private async navigation(
		entry: Entry,
		review: PreparedReview,
		input: z.infer<typeof NavigateSchema>,
		signal: AbortSignal
	): Promise<ReviewNavigation> {
		const prId = review.pr.id;
		const paths = review.files.map((file) => file.path);
		const previous = entry.progress?.path;
		let index = previous ? Math.max(0, paths.indexOf(previous)) : 0;
		if (input.direction === "start") index = 0;
		if (input.direction === "next" && previous) index = Math.min(paths.length - 1, index + 1);
		if (input.direction === "previous") index = Math.max(0, index - 1);
		const path = input.path ?? paths[index];
		if (!path) fail("This prepared review has no readable files.");
		this.assertPath(review, review.id, path);
		let highlight: ReviewNavigation["highlight"];
		if (input.line) {
			const side = input.side ?? "head";
			const file = await this.readFile(entry, review, path, signal);
			const source = file[side];
			const lines = source.content
				? source.content.split("\n").length - (source.content.endsWith("\n") ? 1 : 0)
				: 0;
			if (source.status !== "available" || input.line > lines)
				fail("That line is unavailable in the pinned file. Choose an existing line.");
			highlight = {
				repository: review.pr.repository,
				revision: side,
				commitSha: source.commitSha,
				path: source.path,
				startLine: input.line,
				endLine: input.line,
			};
		}
		return ReviewNavigationSchema.parse({
			reviewId: review.id,
			prId,
			baseSha: review.pr.baseSha,
			headSha: review.pr.headSha,
			path,
			paused: input.direction === "pause",
			...(highlight ? { highlight } : {}),
		});
	}

	private validateScreen(screen: ReviewScreen) {
		if (screen.mode === "review" || screen.reviewId !== undefined) {
			const entry = screen.prId ? this.entry(screen.prId) : undefined;
			const review = entry?.prepared;
			if (
				!review ||
				entry?.status !== "ready" ||
				screen.reviewId !== review.id ||
				screen.baseSha !== review.pr.baseSha ||
				screen.headSha !== review.pr.headSha ||
				!screen.path ||
				!review.files.some((file) => file.path === screen.path)
			)
				fail("Screen refers to an old review. Reopen the current review.");
		} else if (screen.path || screen.baseSha || screen.headSha || screen.paused !== undefined)
			fail("Conversation screen cannot carry incomplete review identity.");
		else if (screen.prId) this.entry(screen.prId);
	}
	private checkScreen(sessionId: string, screen: ReviewScreen, exact = false): ReviewScreen {
		const previous = this.screens.get(sessionId);
		if (previous && screen.sequence < previous.sequence) {
			if (exact) fail("Screen receipt is stale.");
			this.validateScreen(previous);
			return clone(previous);
		}
		if (previous && screen.sequence === previous.sequence && !isDeepStrictEqual(previous, screen))
			fail("Different screens cannot share a sequence.");
		if (!previous && this.screens.size >= 100)
			fail("Too many review sessions. Restart the application.");
		this.validateScreen(screen);
		return screen;
	}
	getScreen(sessionId: string, initial?: ReviewScreen): Promise<ReviewScreen> {
		return this.request(async () => {
			const id = IdSchema.parse(sessionId);
			const screen = ReviewScreenSchema.parse(initial ?? this.screens.get(id) ?? emptyScreen());
			const next = this.checkScreen(id, screen);
			this.screens.set(id, clone(next));
			return clone(next);
		});
	}
	updateScreen(raw: z.infer<typeof UpdateReviewScreenSchema>): Promise<ReviewScreen> {
		return this.request(async () => {
			const { sessionId, screen } = UpdateReviewScreenSchema.parse(raw);
			const next = this.checkScreen(sessionId, screen);
			this.screens.set(sessionId, clone(next));
			return clone(next);
		});
	}
	actionApplied(raw: Receipt, navigation?: ReviewNavigation, caller?: AbortSignal): Promise<void> {
		return this.request(async (signal) => {
			const receipt = ConversationActionReceiptSchema.parse(raw);
			const screen = receipt.screen;
			this.checkScreen(receipt.sessionId, screen, true);
			if (receipt.status === "ignored") {
				this.live(signal);
				this.screens.set(receipt.sessionId, clone(screen));
				return;
			}
			const expected = navigation ? ReviewNavigationSchema.parse(navigation) : undefined;
			if (
				expected &&
				(screen.mode !== "review" ||
					screen.prId !== expected.prId ||
					screen.reviewId !== expected.reviewId ||
					screen.path !== expected.path ||
					screen.baseSha !== expected.baseSha ||
					screen.headSha !== expected.headSha ||
					screen.paused !== expected.paused)
			)
				fail("Applied screen does not match the requested review navigation.");
			if (screen.mode !== "review" || !screen.prId || !screen.path || !screen.reviewId)
				fail("Applied review receipt must identify the displayed file.");
			const { entry, review } = await this.ready(screen.prId, signal);
			this.assertPath(review, screen.reviewId, screen.path);
			await this.commitProgress(entry, review, screen.path, screen.paused ?? false, signal, {
				sessionId: receipt.sessionId,
				screen,
			});
		}, caller);
	}
	dispose(): Promise<void> {
		if (this.disposal) return this.disposal;
		this.lifetime.abort();
		this.connection.abort();
		this.candidate?.abort();
		this.stopPolling();
		for (const entry of this.entries.values()) entry.abort.abort();
		this.disposal = (async () => {
			while (this.jobs.size) await Promise.allSettled([...this.jobs]);
			await this.storage;
			this.screens.clear();
		})();
		return this.disposal;
	}
}
