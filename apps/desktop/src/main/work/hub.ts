import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import {
	GitHubRepositorySchema,
	HUB_ERROR_MESSAGES as HUB_FAILURES,
	type HubOperation,
	type HubOperationResult,
	HubOperationSchema,
	type HubPersistence,
	HubPersistenceSchema,
	type HubSnapshot,
	HubSnapshotSchema,
	type LinearTicket,
	type PinnedSource,
	PinnedSourceSchema,
	type PullRequest,
	type PullRequestFeedback,
	type ReviewCache,
	type ReviewQueueItem,
	SourceRangeRequestSchema,
	SourceSearchRequestSchema,
	type WatchedRepository,
	type WorkJob,
	type WorkNotice,
} from "../../shared/contracts";
import type { HubStore } from "../db/hub-store";
import type { HubGitHubClient } from "../runtime/hub-github";
import type { HubLinearClient } from "../runtime/hub-linear";
import { readLocalReviewSource, validateLocalRepository } from "../runtime/local-review";
import type { ReviewRegistry } from "./review-registry";

export class HubFailure extends Error {
	constructor(readonly kind: keyof typeof HUB_FAILURES) {
		super(HUB_FAILURES[kind]);
	}
}
export interface HubJobs {
	start(
		ticket: LinearTicket,
		repository: WatchedRepository,
		brief: string,
		requestId: string
	): Promise<string>;
	startFeedback(
		pr: PullRequest,
		feedback: PullRequestFeedback,
		repository: WatchedRepository,
		requestId: string
	): Promise<string>;
	answer(jobId: string, decisionId: string, answer: string): Promise<void>;
	resume(jobId: string): Promise<void>;
	pause(jobId: string): Promise<void>;
	cancel(jobId: string): Promise<void>;
	publish(jobId: string): Promise<void>;
	approve(jobId: string, headSha: string): Promise<void>;
	revise(jobId: string, instruction: string): Promise<void>;
}
interface HubPorts {
	store: Pick<HubStore, "loadState" | "saveState" | "loadReview" | "saveReview">;
	github: Pick<
		HubGitHubClient,
		"account" | "repository" | "repositories" | "reviews" | "feedback" | "source"
	>;
	linear: Pick<HubLinearClient, "viewer" | "tickets" | "ticket" | "scopes">;
	registry: Pick<ReviewRegistry, "register" | "ensure" | "remove"> &
		Partial<Pick<ReviewRegistry, "statuses" | "retry">>;
	connections(): Promise<{ github: boolean; linear: boolean; model: boolean; coding?: boolean }>;
	legacyCache(): Promise<ReviewCache>;
}
const empty = (): HubPersistence => ({
	version: 1,
	repositories: [],
	preferences: {
		linearTeamIds: [],
		linearProjectIds: [],
		maxWorkers: 2,
		autoApplySuggestions: true,
	},
	tickets: [],
	jobs: [],
	notices: [],
});
const active = new Set(["queued", "running", "validating", "needs-input"]);

/** Real provider inbox and durable job/event state; source fetches never become placeholder records. */
export class CommandCenterService {
	private state = empty();
	private initialized?: Promise<void>;
	private writes: Promise<unknown> = Promise.resolve();
	private lifetime = new AbortController();
	private timer?: ReturnType<typeof setInterval>;
	private sequence = 0;
	private refreshing?: Promise<void>;
	private refreshController?: AbortController;
	private connectionEpoch = 0;
	private refreshedAt: string | null = null;
	private reviews: ReviewQueueItem[] = [];
	private githubLogin: string | null = null;
	private linearName: string | null = null;
	private linearViewerId: string | null = null;
	private errors: HubSnapshot["errors"] = [];
	private jobs?: HubJobs;
	private requests = new Map<string, Promise<HubOperationResult>>();
	private listeners = new Set<() => void>();
	constructor(private readonly ports: HubPorts) {}
	subscribe(listener: () => void) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	async approvalPolicies() {
		await this.initialize();
		await this.writes;
		return structuredClone(this.state.approvalPolicies ?? []);
	}
	async attentionState() {
		await this.initialize();
		return structuredClone({
			jobs: this.state.jobs,
			approvalPolicies: this.state.approvalPolicies,
			notices: this.state.notices,
			attentionRecords: this.state.attentionRecords,
		});
	}
	private changed() {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				/* Observers never undo durable work. */
			}
		}
	}
	attachJobs(jobs: HubJobs) {
		this.jobs = jobs;
	}
	initialize(): Promise<void> {
		this.initialized ??= (async () => {
			this.state = HubPersistenceSchema.parse((await this.ports.store.loadState()) ?? empty());
			const legacy = await this.ports.legacyCache();
			if (legacy.repository) {
				const key = legacy.repository.toLowerCase();
				let repository = this.state.repositories.find((item) => item.id === key);
				if (!repository) {
					repository = {
						id: key,
						repository: legacy.repository,
						localPath: legacy.localPath,
						defaultBranch: null,
						addedAt: new Date().toISOString(),
						linearTeamIds: [],
						linearProjectIds: [],
					};
					this.state.repositories.push(repository);
				}
				if (!(await this.ports.store.loadReview(legacy.repository)))
					await this.ports.store.saveReview(legacy.repository, legacy);
				this.ports.registry.register(repository, true);
			}
			for (const repository of this.state.repositories) this.ports.registry.register(repository);
			await this.ports.store.saveState(this.state);
			this.timer = setInterval(() => void this.refresh().catch(() => {}), 60_000);
			this.timer.unref?.();
		})();
		return this.initialized;
	}
	async update(mutator: (state: HubPersistence) => void) {
		await this.initialize();
		const write = this.writes
			.catch(() => {})
			.then(async () => {
				if (this.lifetime.signal.aborted) throw new Error("Command center closed");
				const next = structuredClone(this.state);
				mutator(next);
				next.notices = next.notices.slice(-500);
				// Never evict an active job to admit another; schema bounds reject new work instead.
				const value = HubPersistenceSchema.parse(next);
				await this.ports.store.saveState(value);
				this.state = value;
				this.sequence++;
				this.changed();
			});
		this.writes = write;
		return write;
	}
	async snapshot(): Promise<HubSnapshot> {
		await this.initialize();
		const connections = await this.ports.connections();
		const preparation = await this.ports.registry.statuses?.();
		const preferences = this.state.preferences;
		const tickets = this.state.tickets
			.filter(
				(ticket) =>
					this.linearViewerId !== null &&
					ticket.assigneeId === this.linearViewerId &&
					!["completed", "canceled"].includes(ticket.state.type) &&
					((!preferences.linearTeamIds.length && !preferences.linearProjectIds.length) ||
						preferences.linearTeamIds.includes(ticket.teamId) ||
						(!!ticket.projectId && preferences.linearProjectIds.includes(ticket.projectId)))
			)
			.map(({ description: _, ...ticket }) => ticket);
		return HubSnapshotSchema.parse({
			sequence: this.sequence,
			refreshedAt: this.refreshedAt,
			refreshing: !!this.refreshing,
			viewer: { githubLogin: this.githubLogin, linearName: this.linearName },
			connections,
			repositories: this.state.repositories,
			reviews: this.reviews.map((item) => ({
				...item,
				...(preparation ? { preparationStatus: preparation.get(item.pr.id) ?? "queued" } : {}),
			})),
			tickets,
			jobs: this.state.jobs.map(
				({ brief: _, decisions, checks: __, changedFiles, ticket, ...job }) => ({
					...job,
					ticket: ticket ? (({ description: ___, ...rest }) => rest)(ticket) : null,
					pendingDecisions: decisions.filter((item) => item.answer === null).length,
					changedFileCount: changedFiles.length,
				})
			),
			notices: this.state.notices,
			preferences,
			errors: this.errors,
		});
	}
	async refresh(): Promise<HubSnapshot> {
		await this.initialize();
		if (!this.refreshing) {
			const controller = new AbortController();
			this.refreshController = controller;
			const work = this.refreshSources(
				AbortSignal.any([this.lifetime.signal, controller.signal])
			).finally(() => {
				if (this.refreshing === work) {
					this.refreshing = undefined;
					this.refreshController = undefined;
				}
			});
			this.refreshing = work;
		}
		await this.refreshing;
		return this.snapshot();
	}
	private async refreshSources(signal: AbortSignal) {
		const epoch = this.connectionEpoch;
		const current = () => !signal.aborted && epoch === this.connectionEpoch;
		const connections = await this.ports.connections();
		if (!current()) return;
		const errors: HubSnapshot["errors"] = [];
		if (connections.github) {
			try {
				const account = await this.ports.github.account(signal);
				if (!current()) return;
				this.githubLogin = account.login;
				const reviews: ReviewQueueItem[] = [];
				for (const repository of [...this.state.repositories]) {
					try {
						const actual = await this.ports.github.repository(repository.repository, signal);
						const rows = await this.ports.github.reviews(actual.repository, signal);
						if (!current()) return;
						reviews.push(...rows);
						if (repository.defaultBranch !== actual.defaultBranch)
							await this.update((state) => {
								if (!current()) return;
								const stored = state.repositories.find((item) => item.id === repository.id);
								if (stored) stored.defaultBranch = actual.defaultBranch;
							});
						void this.ports.registry
							.ensure({ ...repository, defaultBranch: actual.defaultBranch })
							.catch(() => {});
						const changed = rows.filter(
							(row) =>
								row.kind === "own" &&
								row.feedbackCount > 0 &&
								!this.reviews.some(
									(old) =>
										old.pr.id === row.pr.id &&
										old.lastFeedbackAt === row.lastFeedbackAt &&
										old.feedbackCount === row.feedbackCount
								)
						);
						for (const row of changed) await this.discoverFeedback(row, signal);
					} catch {
						if (!current()) return;
						errors.push({
							source: "github",
							repositoryId: repository.id,
							message: "Could not refresh this repository. Check GitHub access and refresh.",
						});
						reviews.push(...this.reviews.filter((item) => item.repositoryId === repository.id));
					}
				}
				if (!current()) return;
				this.reviews = reviews.slice(0, 1000);
			} catch {
				if (!current()) return;
				errors.push({ source: "github", message: HUB_FAILURES.github });
			}
		}
		if (connections.linear) {
			try {
				const viewer = await this.ports.linear.viewer(signal);
				if (!current()) return;
				this.linearName = viewer.name;
				this.linearViewerId = viewer.id;
				const tickets = await this.ports.linear.tickets(
					{
						teamIds: this.state.preferences.linearTeamIds,
						projectIds: this.state.preferences.linearProjectIds,
					},
					signal
				);
				await this.update((state) => {
					if (!current()) return;
					state.tickets = tickets.filter((ticket) => ticket.assigneeId === viewer.id);
				});
			} catch {
				if (!current()) return;
				errors.push({
					source: "linear",
					message:
						"Could not refresh your Linear tickets. Check the key and selected workspace scopes.",
				});
			}
		}
		if (!current()) return;
		this.errors = errors;
		this.refreshedAt = new Date().toISOString();
		this.sequence++;
	}
	/** Account changes discard fetched queues while retaining local jobs, source and user work. */
	async connectionChanged(provider: "github" | "linear") {
		await this.initialize();
		this.connectionEpoch++;
		this.refreshController?.abort();
		const previous = this.refreshing;
		if (provider === "github") {
			this.githubLogin = null;
			this.reviews = [];
		} else {
			this.linearName = null;
			this.linearViewerId = null;
			await this.update((state) => {
				state.tickets = [];
			});
		}
		this.errors = this.errors.filter((error) => error.source !== provider);
		this.refreshedAt = null;
		this.sequence++;
		this.changed();
		void (previous ?? Promise.resolve())
			.catch(() => {})
			.then(() => this.refresh())
			.catch(() => {});
	}
	private async discoverFeedback(row: ReviewQueueItem, signal: AbortSignal) {
		const feedback = await this.ports.github.feedback(row.pr.id, signal);
		signal.throwIfAborted();
		for (const item of feedback) {
			if (item.author.toLowerCase() === this.githubLogin?.toLowerCase()) continue;
			const noticeId = `feedback-${item.id}`;
			if (this.state.notices.some((notice) => notice.id === noticeId)) continue;
			await this.update((state) => {
				signal.throwIfAborted();
				state.notices.push({
					id: noticeId,
					kind: "feedback",
					title: `Feedback on #${row.pr.number}`,
					detail: item.body.slice(0, 1500),
					jobId: null,
					prId: row.pr.id,
					createdAt: item.updatedAt,
					announcedAt: null,
					seenAt: null,
				});
			});
			if (
				this.state.preferences.autoApplySuggestions &&
				item.suggestion !== null &&
				item.path &&
				item.line &&
				item.commitSha === row.pr.headSha &&
				this.jobs
			) {
				const repository = this.state.repositories.find((repo) => repo.id === row.repositoryId);
				if (repository)
					void this.jobs.startFeedback(row.pr, item, repository, noticeId).catch(() => {});
			}
		}
	}
	async operate(
		raw: HubOperation,
		requestId: string,
		signal?: AbortSignal
	): Promise<HubOperationResult> {
		await this.initialize();
		signal?.throwIfAborted();
		const previous = this.requests.get(requestId);
		if (previous) return previous;
		const operation = HubOperationSchema.parse(raw);
		const work = this.perform(operation, requestId).then(async (jobId) => ({
			snapshot: await this.snapshot(),
			...(jobId ? { jobId } : {}),
		}));
		this.requests.set(requestId, work);
		if (this.requests.size > 4096) this.requests.delete(this.requests.keys().next().value ?? "");
		return work;
	}
	private async perform(operation: HubOperation, requestId: string): Promise<string | undefined> {
		let jobId: string | undefined;
		if (
			[
				"answer-decision",
				"resume-work",
				"pause-work",
				"cancel-work",
				"publish-work",
				"approve-work",
				"revise-work",
			].includes(operation.kind) &&
			!this.jobs
		)
			throw new HubFailure("failed");
		switch (operation.kind) {
			case "retry-review":
				if (
					!this.reviews.some((item) => item.pr.id === operation.prId) ||
					!this.ports.registry.retry
				)
					throw new HubFailure("notFound");
				await this.ports.registry.retry(operation.prId);
				break;
			case "refresh":
				await this.refresh();
				break;
			case "add-repository": {
				if (!(await this.ports.connections()).github) throw new HubFailure("github");
				const actual = await this.ports.github.repository(
					operation.repository,
					this.lifetime.signal
				);
				const localPath = operation.localPath
					? await validateLocalRepository(
							operation.localPath,
							actual.repository,
							this.lifetime.signal
						)
					: null;
				const repository: WatchedRepository = {
					id: actual.repository.toLowerCase(),
					repository: actual.repository,
					defaultBranch: actual.defaultBranch,
					localPath,
					addedAt: new Date().toISOString(),
					linearTeamIds: [],
					linearProjectIds: [],
				};
				await this.update((state) => {
					const old = state.repositories.find((item) => item.id === repository.id);
					if (old) {
						if (localPath) old.localPath = localPath;
						old.defaultBranch = actual.defaultBranch;
					} else state.repositories.push(repository);
				});
				this.ports.registry.register(repository);
				await this.refresh();
				break;
			}
			case "remove-repository": {
				if (
					this.state.jobs.some(
						(job) => job.repositoryId === operation.repositoryId && active.has(job.state)
					)
				)
					throw new HubFailure("busy");
				const repository = this.repository(operation.repositoryId);
				await this.update((state) => {
					state.repositories = state.repositories.filter(
						(item) => item.id !== operation.repositoryId
					);
				});
				this.reviews = this.reviews.filter((item) => item.repositoryId !== operation.repositoryId);
				await this.ports.registry.remove(repository.repository);
				break;
			}
			case "preferences":
				await this.update((state) => {
					state.preferences = operation.preferences;
				});
				await this.refresh();
				break;
			case "start-work": {
				if (!this.jobs) throw new HubFailure("failed");
				const ticket = await this.ticket(operation.ticketId, this.lifetime.signal);
				const repository = await this.readyRepository(operation.repositoryId);
				jobId = await this.jobs.start(ticket, repository, operation.brief, requestId);
				break;
			}
			case "start-feedback-work": {
				if (!this.jobs) throw new HubFailure("failed");
				const row = this.reviews.find(
					(item) => item.pr.id === operation.prId && item.kind === "own"
				);
				if (!row) throw new HubFailure("notFound");
				const feedback = (await this.feedback(operation.prId, this.lifetime.signal)).find(
					(item) => item.id === operation.feedbackId
				);
				if (!feedback) throw new HubFailure("notFound");
				jobId = await this.jobs.startFeedback(
					row.pr,
					feedback,
					await this.readyRepository(row.repositoryId),
					requestId
				);
				break;
			}
			case "answer-decision":
				await this.jobs?.answer(operation.jobId, operation.decisionId, operation.answer);
				jobId = operation.jobId;
				break;
			case "resume-work":
				await this.jobs?.resume(operation.jobId);
				jobId = operation.jobId;
				break;
			case "pause-work":
				await this.jobs?.pause(operation.jobId);
				jobId = operation.jobId;
				break;
			case "cancel-work":
				await this.jobs?.cancel(operation.jobId);
				jobId = operation.jobId;
				break;
			case "publish-work":
				await this.jobs?.publish(operation.jobId);
				jobId = operation.jobId;
				break;
			case "revise-work":
				await this.jobs?.revise(operation.jobId, operation.instruction);
				jobId = operation.jobId;
				break;
			case "approve-work":
				await this.jobs?.approve(operation.jobId, operation.headSha);
				jobId = operation.jobId;
				break;
			case "seen-notice":
				await this.update((state) => {
					const notice = state.notices.find((item) => item.id === operation.noticeId);
					if (notice) notice.seenAt = new Date().toISOString();
				});
				break;
			case "announced-notices":
				await this.update((state) => {
					for (const notice of state.notices)
						if (operation.noticeIds.includes(notice.id) && !notice.announcedAt)
							notice.announcedAt = new Date().toISOString();
				});
				break;
		}
		return jobId;
	}
	repository(id: string): WatchedRepository {
		const item = this.state.repositories.find(
			(repo) => repo.id === id || repo.repository.toLowerCase() === id.toLowerCase()
		);
		if (!item) throw new HubFailure("repository");
		return structuredClone(item);
	}
	async readyRepository(id: string) {
		const item = this.repository(id);
		if (item.defaultBranch) return item;
		const actual = await this.ports.github.repository(item.repository, this.lifetime.signal);
		await this.update((state) => {
			const stored = state.repositories.find((repo) => repo.id === item.id);
			if (stored) stored.defaultBranch = actual.defaultBranch;
		});
		return { ...item, defaultBranch: actual.defaultBranch };
	}
	async ticket(id: string, signal?: AbortSignal) {
		await this.initialize();
		if (!(await this.ports.connections()).linear) throw new HubFailure("linear");
		return this.ports.linear.ticket(id, signal);
	}
	async job(id: string): Promise<WorkJob> {
		await this.initialize();
		const job = this.state.jobs.find((item) => item.id === id);
		if (!job) throw new HubFailure("notFound");
		return structuredClone(job);
	}
	async allJobs() {
		await this.initialize();
		return structuredClone(this.state.jobs);
	}
	workerFailure(message: string) {
		this.errors = [
			...this.errors.filter((error) => error.source !== "worker"),
			{ source: "worker", message },
		];
		this.sequence++;
	}
	async syncTicket(ticket: LinearTicket) {
		await this.update((state) => {
			const index = state.tickets.findIndex((item) => item.id === ticket.id);
			if (index >= 0) state.tickets[index] = ticket;
		});
	}
	async feedback(prId: string, signal?: AbortSignal) {
		await this.initialize();
		return this.ports.github.feedback(prId, signal);
	}
	async repositories(signal?: AbortSignal) {
		if (!(await this.ports.connections()).github) throw new HubFailure("github");
		return this.ports.github.repositories(signal);
	}
	async linearScopes(signal?: AbortSignal) {
		if (!(await this.ports.connections()).linear) throw new HubFailure("linear");
		return this.ports.linear.scopes(signal);
	}
	async notice(input: Pick<WorkNotice, "kind" | "title" | "detail" | "jobId" | "prId">) {
		await this.update((state) => {
			const job = state.jobs.find((item) => item.id === input.jobId);
			state.notices.push({
				...input,
				id: randomUUID(),
				createdAt: new Date().toISOString(),
				announcedAt: null,
				seenAt: null,
				...(job
					? {
							headSha: job.headSha,
							decisionId:
								input.kind === "decision"
									? (job.decisions.find((d) => d.answer === null)?.id ?? null)
									: null,
						}
					: {}),
			});
		});
	}
	async source(raw: unknown, signal?: AbortSignal): Promise<PinnedSource> {
		await this.initialize();
		const request = SourceRangeRequestSchema.parse(raw);
		const repository = this.repository(request.repository);
		const localPath =
			this.state.jobs.find(
				(job) =>
					job.repositoryId === repository.id &&
					job.worktreePath &&
					(job.headSha === request.commitSha || job.baseSha === request.commitSha)
			)?.worktreePath ?? repository.localPath;
		let source = localPath
			? await readLocalReviewSource(
					localPath,
					repository.repository,
					request.path,
					request.commitSha,
					signal
				)
			: undefined;
		if (!source)
			source = await this.ports.github.source(
				{ repository: repository.repository, path: request.path, commitSha: request.commitSha },
				signal
			);
		if (source.status !== "available" || source.content === null) throw new HubFailure("notFound");
		const lines =
			source.content
				.match(/[^\n]*(?:\n|$)/g)
				?.filter((line, index, array) => index < array.length - 1 || line !== "") ?? [];
		const start = request.startLine;
		const end = Math.min(request.endLine ?? start + 299, lines.length);
		if (start > end) throw new HubFailure("notFound");
		let text = lines.slice(start - 1, end).join("");
		let last = end;
		while (text.length > 100000 && last > start) {
			last--;
			text = lines.slice(start - 1, last).join("");
		}
		return PinnedSourceSchema.parse({
			location: {
				repository: repository.repository,
				revision: request.revision,
				commitSha: request.commitSha,
				path: request.path,
				startLine: start,
				endLine: last,
			},
			text,
			language: null,
			truncated: last < end || (!request.endLine && end < lines.length),
		});
	}
	async search(
		input: { repository: string; commitSha: string; query: string; revision?: "base" | "head" },
		signal?: AbortSignal
	): Promise<PinnedSource[]> {
		await this.initialize();
		const raw = SourceSearchRequestSchema.parse(input);
		const repository = this.repository(GitHubRepositorySchema.parse(raw.repository));
		const localPath =
			this.state.jobs.find(
				(job) =>
					job.repositoryId === repository.id &&
					job.worktreePath &&
					(job.headSha === raw.commitSha || job.baseSha === raw.commitSha)
			)?.worktreePath ?? repository.localPath;
		if (!localPath) throw new Error("Choose a local clone to search this pinned repository.");
		if (!/^[a-f0-9]{40}$/.test(raw.commitSha) || !raw.query.trim() || raw.query.length > 200)
			throw new HubFailure("notFound");
		let output = "";
		try {
			output = (
				await promisify(execFile)(
					"git",
					[
						"--no-replace-objects",
						"--no-optional-locks",
						"-c",
						"core.fsmonitor=false",
						"-C",
						localPath,
						"grep",
						"-n",
						"-I",
						"-F",
						"-e",
						raw.query,
						raw.commitSha,
						"--",
					],
					{
						signal,
						timeout: 10000,
						maxBuffer: 1000000,
						env: {
							PATH: process.env["PATH"],
							GIT_CONFIG_GLOBAL: "/dev/null",
							GIT_CONFIG_NOSYSTEM: "1",
							GIT_NO_LAZY_FETCH: "1",
						},
					}
				)
			).stdout;
		} catch (error) {
			if ((error as { code?: unknown }).code !== 1) throw error;
		}
		const requests = new Map<string, number>();
		for (const line of output.split("\n")) {
			const match = /^[a-f0-9]{40}:(.+?):([0-9]+):/.exec(line);
			if (match?.[1] && match[2] && !requests.has(match[1]))
				requests.set(match[1], Number(match[2]));
			if (requests.size >= 12) break;
		}
		return Promise.all(
			[...requests].map(([path, line]) =>
				this.source(
					{
						repository: repository.repository,
						commitSha: raw.commitSha,
						path,
						revision: raw.revision ?? "head",
						startLine: Math.max(1, line - 12),
						endLine: line + 40,
					},
					signal
				)
			)
		);
	}
	async dispose() {
		this.lifetime.abort();
		this.listeners.clear();
		clearInterval(this.timer);
		await this.refreshing?.catch(() => {});
		await this.writes.catch(() => {});
	}
}
