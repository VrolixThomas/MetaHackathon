import { type ChildProcess, fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
	type CodingProviderSettings,
	IdSchema,
	type LinearTicket,
	type PullRequest,
	type PullRequestFeedback,
	type WatchedRepository,
	WatchedRepositorySchema,
	type WorkJob,
	WorkJobSchema,
	WorkLogPageSchema,
	type WorkReview,
} from "../../shared/contracts";
import { DayActorSchema } from "../../shared/contracts/day";
import { abortable, throwIfAborted } from "../agent/cancellation";
import { type CodingTaskInput, CodingTaskResultSchema } from "../agent/coding-worker";
import type { HubGitHubClient } from "../runtime/hub-github";
import type { HubLinearClient } from "../runtime/hub-linear";
import type { WorkJobRuntime } from "../runtime/work-job-runtime";
import { codingEnvironment } from "./coding-environment";
import type { CommandCenterService, HubJobs } from "./hub";

const eventSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("log"), text: z.string().max(12000) }),
	z.strictObject({ kind: z.literal("result"), result: CodingTaskResultSchema }),
	z.strictObject({ kind: z.literal("failed"), message: z.string().max(1000) }),
]);
type Running = {
	controller: AbortController;
	child: ChildProcess | null;
	done: boolean;
	promise: Promise<void>;
};
const COMMIT_CONVENTION =
	"Repository commit hooks require an explicit convention decision before committing";
class WorkChanged extends Error {
	constructor() {
		super("Work changed or was interrupted; inspect its current state before retrying");
	}
}
const inProgress = new Set(["queued", "running", "validating", "needs-input", "paused"]);
const InternalPreparationSchema = z.strictObject({
	actor: DayActorSchema,
	itemId: IdSchema,
	requestId: IdSchema,
	repository: WatchedRepositorySchema,
	brief: WorkJobSchema.shape.brief,
});
const InternalExecutionSchema = z.strictObject({
	actor: DayActorSchema,
	jobId: IdSchema,
	requestId: IdSchema,
});
function internalDigest(input: z.infer<typeof InternalPreparationSchema>) {
	return createHash("sha256")
		.update(JSON.stringify(InternalPreparationSchema.parse(input)))
		.digest("hex");
}
const admitted = (job: WorkJob) => !job.internal || job.internal.stage === "admitted";
interface JobOptions {
	hub: CommandCenterService;
	runtime: WorkJobRuntime;
	github: HubGitHubClient;
	linear: HubLinearClient;
	directory: string;
	workerEntry: string;
	envPath: string;
	codingSettings?: () => Promise<CodingProviderSettings>;
	redact?: (value: string) => string;
	assessSuggestion?: (
		job: WorkJob,
		review: WorkReview,
		signal: AbortSignal
	) => Promise<{ sound: boolean; reason: string; question?: string }>;
}

/** App-owned independent worker processes. Foreground turn cancellation never owns these jobs. */
export class WorkJobCoordinator implements HubJobs {
	private running = new Map<string, Running>();
	private stopping = false;
	private pumping = false;
	private logs = new Map<string, Promise<unknown>>();
	private retries = new Map<string, number>();
	private feedback = new Map<string, string>();
	private publications = new Map<string, Promise<void>>();
	private operations = new Map<string, Set<AbortController>>();
	private preparations = new Map<
		string,
		{ bindingDigest: string; controller: AbortController; promise: Promise<string> }
	>();
	constructor(private readonly options: JobOptions) {}
	async restore() {
		await this.options.hub.initialize();
		await this.options.hub.update((state) => {
			for (const job of state.jobs) {
				if (!admitted(job)) continue;
				if (
					job.state === "running" ||
					job.state === "validating" ||
					(job.state === "paused" && job.pauseReason === "shutdown")
				) {
					job.state = "queued";
					job.pauseReason = null;
					job.updatedAt = new Date().toISOString();
				}
			}
		});
		void this.pump().catch(() =>
			this.options.hub.workerFailure(
				"Worker scheduling could not update its state. Existing work was retained."
			)
		);
	}
	async start(
		ticket: LinearTicket,
		repository: WatchedRepository,
		brief: string,
		_requestId: string
	): Promise<string> {
		const existing = (await this.options.hub.allJobs()).find(
			(job) =>
				job.ticket?.id === ticket.id &&
				job.repositoryId === repository.id &&
				inProgress.has(job.state)
		);
		if (existing) return existing.id;
		const job = await this.make(repository, ticket, null, brief);
		let admitted = job.id;
		await this.options.hub.update((state) => {
			const duplicate = state.jobs.find(
				(item) =>
					item.ticket?.id === ticket.id &&
					item.repositoryId === repository.id &&
					inProgress.has(item.state)
			);
			if (duplicate) admitted = duplicate.id;
			else state.jobs.push(job);
		});
		if (admitted !== job.id) return admitted;
		try {
			const updated = await this.options.linear.updateState(ticket.id, "started");
			await this.options.hub.syncTicket(updated);
			await this.patch(job.id, (current) => {
				current.ticket = updated;
			});
		} catch {
			await this.append(job.id, "Linear status could not be updated; local work remains queued.");
		}
		void this.pump().catch(() =>
			this.options.hub.workerFailure(
				"Worker scheduling could not update its state. Existing work was retained."
			)
		);
		return job.id;
	}
	/** Root owns source authorization/acceptance. This signal belongs to Day, never a voice turn. */
	async prepareInternal(
		input: z.infer<typeof InternalPreparationSchema>,
		signal?: AbortSignal
	): Promise<string> {
		const request = InternalPreparationSchema.parse(input);
		if (signal) throwIfAborted(signal);
		const bindingDigest = internalDigest(request);
		let pending = this.preparations.get(request.requestId);
		if (pending && pending.bindingDigest !== bindingDigest)
			throw new Error("Internal work request binding mismatch");
		if (!pending) {
			const controller = new AbortController();
			const promise = Promise.resolve()
				.then(() => this.prepareInternalOnce(request, bindingDigest, controller.signal))
				.finally(() => {
					if (this.preparations.get(request.requestId)?.promise === promise)
						this.preparations.delete(request.requestId);
				});
			pending = { bindingDigest, controller, promise };
			this.preparations.set(request.requestId, pending);
		}
		const controller = pending.controller;
		const abort = () => controller.abort();
		signal?.addEventListener("abort", abort, { once: true });
		try {
			return await pending.promise;
		} finally {
			signal?.removeEventListener("abort", abort);
		}
	}
	private async prepareInternalOnce(
		request: z.infer<typeof InternalPreparationSchema>,
		bindingDigest: string,
		signal: AbortSignal
	) {
		const candidate = await this.make(request.repository, null, null, request.brief);
		candidate.state = "paused";
		candidate.pauseReason = "user";
		candidate.internal = {
			workspaceId: request.actor.workspaceId,
			ownerUserId: request.actor.userId,
			itemId: request.itemId,
			requestId: request.requestId,
			bindingDigest,
			stage: "preparing",
		};
		let job = candidate;
		await this.options.hub.update((state) => {
			throwIfAborted(signal);
			if (this.stopping) throw new WorkChanged();
			const existing = state.jobs.find((item) => item.internal?.requestId === request.requestId);
			if (existing) {
				if (existing.internal?.bindingDigest !== bindingDigest)
					throw new Error("Internal work request binding mismatch");
				job = structuredClone(existing);
			} else state.jobs.push(candidate);
			this.assertInternal(job, request.actor, state.repositories);
			if (job.state === "cancelled") throw new WorkChanged();
		});
		throwIfAborted(signal);
		if (job.internal?.stage !== "preparing") return job.id;
		return this.operation(
			job.id,
			async (operationSignal) => {
				if (job.state !== "paused") throw new WorkChanged();
				const prepared = await this.call(operationSignal, () =>
					this.options.runtime.prepare(request.repository, job, operationSignal)
				);
				await this.options.hub.update((state) => {
					throwIfAborted(operationSignal);
					const current = state.jobs.find((item) => item.id === job.id);
					if (
						!current ||
						!isDeepStrictEqual(current, job) ||
						current.internal?.stage !== "preparing"
					)
						throw new WorkChanged();
					this.assertInternal(current, request.actor, state.repositories);
					const value = WorkJobSchema.parse({
						...current,
						...prepared,
						internal: { ...current.internal, stage: "prepared" },
					});
					if (!value.worktreePath || !value.baseSha || value.branch !== job.branch)
						throw new Error("Internal work preparation pins unavailable");
					Object.assign(current, value, { updatedAt: new Date().toISOString() });
				});
				throwIfAborted(operationSignal);
				return job.id;
			},
			signal
		);
	}
	private assertInternal(
		job: WorkJob,
		actor: z.infer<typeof DayActorSchema>,
		repositories: WatchedRepository[]
	): WatchedRepository {
		const origin = job.internal;
		const repository = repositories.find((item) => item.id === job.repositoryId);
		if (
			!origin ||
			origin.workspaceId !== actor.workspaceId ||
			origin.ownerUserId !== actor.userId ||
			job.ticket !== null ||
			job.feedback ||
			!repository ||
			job.repository !== repository.repository ||
			origin.bindingDigest !==
				internalDigest({
					actor,
					itemId: origin.itemId,
					requestId: origin.requestId,
					repository,
					brief: job.brief,
				})
		)
			throw new Error("Internal work origin or scope mismatch");
		return repository;
	}
	/** Only root's accepted start_work outbox calls this. Admission outlives its caller's signal. */
	async executeInternal(
		input: z.infer<typeof InternalExecutionSchema>,
		signal?: AbortSignal
	): Promise<void> {
		const request = InternalExecutionSchema.parse(input);
		await this.operation(
			request.jobId,
			async (operationSignal) => {
				const job = await this.call(operationSignal, () => this.options.hub.job(request.jobId));
				const repository = this.assertInternal(job, request.actor, [
					this.options.hub.repository(job.repositoryId),
				]);
				if (job.state === "cancelled") throw new WorkChanged();
				if (job.internal?.stage === "admitted") return;
				if (
					job.internal?.stage !== "prepared" ||
					job.state !== "paused" ||
					!job.worktreePath ||
					!job.baseSha ||
					job.headSha !== null
				)
					throw new Error("Internal work must be prepared before admission");
				// Reopening the owned preparation verifies its original worktree and base pin.
				const prepared = await this.call(operationSignal, () =>
					this.options.runtime.prepare(repository, job, operationSignal, {
						baseCommit: job.baseSha as string,
					})
				);
				if (
					prepared.worktreePath !== job.worktreePath ||
					prepared.branch !== job.branch ||
					prepared.baseSha !== job.baseSha
				)
					throw new WorkChanged();
				await this.options.hub.update((state) => {
					throwIfAborted(operationSignal);
					const current = state.jobs.find((item) => item.id === job.id);
					if (!current) throw new WorkChanged();
					this.assertInternal(current, request.actor, state.repositories);
					if (current.internal?.stage === "admitted" && current.state !== "cancelled") return;
					if (!isDeepStrictEqual(current, job) || !current.internal) throw new WorkChanged();
					current.internal.stage = "admitted";
					current.state = "queued";
					current.pauseReason = null;
					current.updatedAt = new Date().toISOString();
				});
			},
			signal
		);
		this.schedule();
	}
	async startFeedback(
		pr: PullRequest,
		feedback: PullRequestFeedback,
		repository: WatchedRepository,
		_requestId: string
	): Promise<string> {
		const existing = (await this.options.hub.allJobs()).find(
			(job) => job.feedback?.id === feedback.id && job.state !== "cancelled"
		);
		if (existing) return existing.id;
		const brief = `Review this actual GitHub feedback on ${pr.id}. Follow repository conventions. Clarify any changed product behavior before applying it.\nReviewer: ${feedback.author}\n${feedback.body}\nPinned revision: ${pr.headSha}\nPath: ${feedback.path ?? "not anchored"}; line: ${feedback.line ?? "not anchored"}\nProposed suggestion: ${feedback.suggestion ?? "none"}`;
		const job = await this.make(repository, null, feedback, brief);
		job.pullRequest = pr;
		job.baseSha = pr.headSha;
		let admitted = job.id;
		await this.options.hub.update((state) => {
			const duplicate = state.jobs.find(
				(item) => item.feedback?.id === feedback.id && item.state !== "cancelled"
			);
			if (duplicate) admitted = duplicate.id;
			else state.jobs.push(job);
		});
		if (admitted !== job.id) return admitted;
		void this.pump().catch(() =>
			this.options.hub.workerFailure(
				"Worker scheduling could not update its state. Existing work was retained."
			)
		);
		return job.id;
	}
	private async make(
		repository: WatchedRepository,
		ticket: LinearTicket | null,
		feedback: PullRequestFeedback | null,
		brief: string
	): Promise<WorkJob> {
		const id = randomUUID();
		const now = new Date().toISOString();
		return WorkJobSchema.parse({
			id,
			codingProvider: (await this.options.codingSettings?.()) ?? {
				provider: "meta-api",
				musePath: null,
			},
			ticket,
			feedback,
			repositoryId: repository.id,
			repository: repository.repository,
			state: "queued",
			branch: `muse/${(ticket?.identifier ?? (feedback ? "feedback" : "internal")).toLowerCase().replace(/[^a-z0-9-]/g, "-")}-${id.slice(0, 8)}`,
			worktreePath: null,
			baseSha: null,
			headSha: null,
			brief,
			summary: "",
			createdAt: now,
			updatedAt: now,
			decisions: [],
			checks: [],
			changedFiles: [],
			pullRequest: null,
			error: null,
			pauseReason: null,
			reviewedAt: null,
		});
	}
	private async patch(
		id: string,
		update: (job: WorkJob) => void,
		signal?: AbortSignal,
		valid?: (job: WorkJob) => boolean
	) {
		await this.options.hub.update((state) => {
			const job = state.jobs.find((item) => item.id === id);
			if (!job) throw new Error("Work is unavailable");
			if (signal) throwIfAborted(signal);
			if (valid && !valid(job)) throw new WorkChanged();
			update(job);
			job.updatedAt = new Date().toISOString();
		});
	}
	/** A lease never holds the durable state queue while a provider is pending. */
	private async operation<T>(
		jobId: string,
		work: (signal: AbortSignal) => Promise<T>,
		parentSignal?: AbortSignal
	): Promise<T> {
		if (this.stopping) throw new WorkChanged();
		if (parentSignal) throwIfAborted(parentSignal);
		const controller = new AbortController();
		const abort = () => controller.abort();
		parentSignal?.addEventListener("abort", abort, { once: true });
		const set = this.operations.get(jobId) ?? new Set<AbortController>();
		this.operations.set(jobId, set);
		set.add(controller);
		try {
			return await work(controller.signal);
		} finally {
			parentSignal?.removeEventListener("abort", abort);
			set.delete(controller);
			if (!set.size && this.operations.get(jobId) === set) this.operations.delete(jobId);
		}
	}
	private call<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
		throwIfAborted(signal);
		return abortable(work(), signal);
	}
	/** Synchronous invalidation also catches leases admitted before the queued state write. */
	private interrupt(jobId: string, keep?: AbortSignal): boolean {
		let active = false;
		for (const controller of this.operations.get(jobId) ?? [])
			if (controller.signal !== keep) {
				active = true;
				controller.abort();
			}
		const run = this.running.get(jobId);
		if (run && run.controller.signal !== keep) {
			active = true;
			run.controller.abort();
		}
		return active;
	}
	private async current(job: WorkJob, signal: AbortSignal, states: WorkJob["state"][] = ["ready"]) {
		const current = await this.call(signal, () => this.options.hub.job(job.id));
		if (!this.matches(current, job, states)) throw new WorkChanged();
	}
	private matches(current: WorkJob, expected: WorkJob, states: WorkJob["state"][]) {
		return (
			admitted(current) &&
			admitted(expected) &&
			states.includes(current.state) &&
			current.headSha === expected.headSha &&
			current.baseSha === expected.baseSha &&
			current.branch === expected.branch &&
			current.worktreePath === expected.worktreePath
		);
	}
	private patchCurrent(
		job: WorkJob,
		signal: AbortSignal,
		update: (job: WorkJob) => void,
		states: WorkJob["state"][] = ["ready"]
	) {
		return this.patch(job.id, update, signal, (current) => this.matches(current, job, states));
	}
	private runPatch(
		id: string,
		run: Running,
		update: (job: WorkJob) => void,
		states: WorkJob["state"][]
	) {
		return this.patch(
			id,
			update,
			run.controller.signal,
			(current) => this.live(id, run) && admitted(current) && states.includes(current.state)
		);
	}
	private notify(
		job: WorkJob,
		signal: AbortSignal,
		input: Parameters<CommandCenterService["notice"]>[0],
		state: WorkJob["state"]
	) {
		return this.options.hub.update((store) => {
			throwIfAborted(signal);
			const current = store.jobs.find((item) => item.id === job.id);
			if (!current || !this.matches(current, job, [state])) throw new WorkChanged();
			store.notices.push({
				...input,
				id: randomUUID(),
				createdAt: new Date().toISOString(),
				seenAt: null,
				announcedAt: null,
				headSha: current.headSha,
				decisionId:
					input.kind === "decision"
						? (current.decisions.find((d) => d.answer === null)?.id ?? null)
						: null,
			});
		});
	}
	/** Retain ownership until the old process exits; cancellation itself never awaits this. */
	private async retire(id: string, run: Running) {
		const child = run.child;
		if (child?.pid && child.exitCode === null && child.signalCode === null) {
			await new Promise<void>((resolve) => {
				const finish = () => {
					clearTimeout(timer);
					child.removeListener("exit", finish);
					resolve();
				};
				const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
				timer.unref?.();
				child.once("exit", finish);
				child.kill("SIGTERM");
				if (child.exitCode !== null || child.signalCode !== null) finish();
			});
		}
		if (this.running.get(id) === run) this.running.delete(id);
		void this.pump().catch(() =>
			this.options.hub.workerFailure(
				"Worker scheduling could not update its state. Existing work was retained."
			)
		);
	}

	private async pump() {
		if (this.stopping || this.pumping) return;
		this.pumping = true;
		try {
			while (!this.stopping) {
				const snapshot = await this.options.hub.snapshot();
				if (this.running.size >= snapshot.preferences.maxWorkers) return;
				const job = (await this.options.hub.allJobs()).find(
					(item) => item.state === "queued" && admitted(item) && !this.running.has(item.id)
				);
				if (!job) return;
				const run: Running = {
					controller: new AbortController(),
					child: null,
					done: false,
					promise: Promise.resolve(),
				};
				this.running.set(job.id, run);
				run.promise = this.execute(job, run)
					.catch((error) => {
						if (error instanceof WorkChanged || run.controller.signal.aborted) return;
						this.options.hub.workerFailure(
							"A worker could not confirm or save its state. Its worktree was retained."
						);
					})
					.finally(() => this.retire(job.id, run));
			}
		} finally {
			this.pumping = false;
		}
	}
	private live(id: string, run: Running) {
		return !this.stopping && !run.controller.signal.aborted && this.running.get(id) === run;
	}
	private async execute(initial: WorkJob, run: Running) {
		const signal = run.controller.signal;
		try {
			const repository = await this.call(signal, () =>
				this.options.hub.readyRepository(initial.repositoryId)
			);
			await this.runPatch(
				initial.id,
				run,
				(job) => {
					job.state = "running";
					job.error = null;
					job.pauseReason = null;
				},
				["queued"]
			);
			let job = await this.call(signal, () => this.options.hub.job(initial.id));
			if (!job.worktreePath) {
				await this.append(job.id, "Preparing an isolated worktree.");
				const prepared = await this.call(signal, () =>
					this.options.runtime.prepare(
						repository,
						job,
						signal,
						job.feedback && job.baseSha ? { baseCommit: job.baseSha } : undefined
					)
				);
				if (!this.live(job.id, run)) return;
				await this.runPatch(job.id, run, (current) => Object.assign(current, prepared), [
					"running",
				]);
				job = await this.options.hub.job(job.id);
			}
			if (!this.live(job.id, run) || !job.worktreePath) return;
			const decisionContext =
				job.decisions
					.filter((item) => item.answer !== null)
					.map((item) => `${item.question}\nUser decision: ${item.answer}`)
					.join("\n\n") +
				(job.revisions ?? [])
					.map((item) => `\nUser review instruction: ${item.instruction}`)
					.join("\n");
			const input: CodingTaskInput = {
				jobId: job.id,
				ticket: job.ticket,
				repository: job.repository,
				worktreePath: job.worktreePath,
				brief: job.brief,
				checkpointPath: join(this.options.directory, job.id, "checkpoint.json"),
				...(decisionContext ? { decisionContext: decisionContext.slice(-20000) } : {}),
				...(this.feedback.has(job.id) ? { validationFeedback: this.feedback.get(job.id) } : {}),
			};
			const result = await this.call(signal, () => this.runChild(job, run, input));
			if (!this.live(job.id, run)) return;
			if (result.status === "needs-input") {
				await this.runPatch(
					job.id,
					run,
					(current) => {
						current.state = "needs-input";
						current.summary = result.summary;
						current.decisions.push({
							id: randomUUID(),
							question: result.question ?? "A decision is needed.",
							reason: result.reason ?? "",
							createdAt: new Date().toISOString(),
							answer: null,
							answeredAt: null,
						});
					},
					["running"]
				);
				const pending = await this.call(signal, () => this.options.hub.job(job.id));
				await this.notify(
					pending,
					signal,
					{
						kind: "decision",
						title: `Decision needed: ${job.ticket?.identifier ?? "PR feedback"}`,
						detail: result.question ?? "A decision is needed.",
						jobId: job.id,
						prId: job.pullRequest?.id ?? null,
					},
					"needs-input"
				);
				return;
			}
			await this.runPatch(
				job.id,
				run,
				(current) => {
					current.state = "validating";
					current.summary = result.summary;
				},
				["running"]
			);
			await this.append(job.id, "Committing changes and checking the actual commit.");
			const finalizing = await this.call(signal, () => this.options.hub.job(job.id));
			const finalized = await this.call(signal, () =>
				this.options.runtime.finalize(finalizing, signal)
			);
			if (!this.live(job.id, run)) return;
			for (const check of finalized.checks)
				await this.append(
					job.id,
					`[check] ${check.command} ${check.args.join(" ")} exited ${check.exitCode}\n${await this.options.runtime.getLog(check.logId)}`
				);
			await this.runPatch(
				job.id,
				run,
				(current) => {
					Object.assign(current, finalized);
					if (!finalized.changedFiles.length)
						current.summary =
							"No source changes were produced. Review the recorded checks and existing implementation.";
				},
				["validating"]
			);
			const failed = finalized.checks.filter((check) => check.exitCode !== 0);
			if (failed.length) {
				const feedback = (
					await Promise.all(
						failed.map(
							async (check) =>
								`${check.command} ${check.args.join(" ")} exited ${check.exitCode}\n${await this.options.runtime.getLog(check.logId)}`
						)
					)
				).join("\n\n");
				throwIfAborted(signal);
				this.feedback.set(job.id, feedback.slice(0, 20000));
				const count = (this.retries.get(job.id) ?? 0) + 1;
				this.retries.set(job.id, count);
				if (count <= 2) {
					await this.runPatch(
						job.id,
						run,
						(current) => {
							current.state = "queued";
							current.error = "Validation failed; Muse is addressing the actual check results.";
						},
						["validating"]
					);
					return;
				}
				throw new Error("Validation remains unsuccessful");
			}
			await this.maybeApplyFeedback(
				await this.call(signal, () => this.options.hub.job(job.id)),
				repository,
				signal
			);
			const completed = await this.call(signal, () => this.options.hub.job(job.id));
			if (completed.state === "needs-input") return;
			await this.runPatch(
				job.id,
				run,
				(current) => {
					current.state = "ready";
					current.error = null;
				},
				["validating"]
			);
			await this.append(
				job.id,
				`Ready for review at ${finalized.headSha}. ${finalized.checks.length} checks recorded.`
			);
			const ready = await this.call(signal, () => this.options.hub.job(job.id));
			await this.notify(
				ready,
				signal,
				{
					kind: "work-ready",
					title: `Ready to review: ${job.ticket?.identifier ?? "PR feedback"}`,
					detail:
						ready.summary.slice(0, 2500) +
						(finalized.checks.length ? "" : "\nNo configured validation commands were run."),
					jobId: job.id,
					prId: ready.pullRequest?.id ?? null,
				},
				"ready"
			);
		} catch (error) {
			if (error instanceof WorkChanged || !this.live(initial.id, run)) return;
			const diagnostic =
				error instanceof Error && error.message === COMMIT_CONVENTION
					? COMMIT_CONVENTION
					: "Muse could not finish this work. Check its execution log and connection, then resume.";
			await this.append(initial.id, diagnostic);
			await this.runPatch(
				initial.id,
				run,
				(job) => {
					job.state = "failed";
					job.error = diagnostic;
				},
				["queued", "running", "validating"]
			);
			const failed = await this.call(signal, () => this.options.hub.job(initial.id));
			await this.notify(
				failed,
				signal,
				{
					kind: "work-failed",
					title: `Work needs attention: ${initial.ticket?.identifier ?? "PR feedback"}`,
					detail:
						"The work did not complete successfully. Its worktree and execution log were retained.",
					jobId: initial.id,
					prId: initial.pullRequest?.id ?? null,
				},
				"failed"
			);
		}
	}
	private runChild(job: WorkJob, run: Running, input: CodingTaskInput) {
		return new Promise<z.infer<typeof CodingTaskResultSchema>>((resolve, reject) => {
			const child = fork(this.options.workerEntry, [], {
				silent: true,
				env: codingEnvironment({ ELECTRON_RUN_AS_NODE: "1" }),
				serialization: "json",
				execArgv: [],
			});
			run.child = child;
			let settled = false;
			const finish = (result?: z.infer<typeof CodingTaskResultSchema>, error?: Error) => {
				if (settled) return;
				settled = true;
				run.controller.signal.removeEventListener("abort", abort);
				result ? resolve(result) : reject(error ?? new Error("Worker stopped"));
			};
			const abort = () => {
				child.send?.({ kind: "cancel" }, () => {});
				child.kill("SIGTERM");
				finish(undefined, new DOMException("Work paused", "AbortError"));
			};
			run.controller.signal.addEventListener("abort", abort, { once: true });
			child.stdout?.on("data", (data) => void this.append(job.id, String(data)));
			child.stderr?.on("data", (data) => void this.append(job.id, String(data)));
			child.on("message", (raw) => {
				if (!this.live(job.id, run)) return;
				const event = eventSchema.safeParse(raw);
				if (!event.success) return;
				if (event.data.kind === "log") void this.append(job.id, event.data.text);
				else if (event.data.kind === "result") {
					run.done = true;
					finish(event.data.result);
				} else finish(undefined, new Error("Worker failed"));
			});
			child.once("error", () => finish(undefined, new Error("Worker could not launch")));
			child.once("exit", () => finish(undefined, new Error("Worker exited before completion")));
			child.send(
				{
					kind: "run",
					input,
					envPath: this.options.envPath,
					providerSettings: job.codingProvider ?? { provider: "meta-api", musePath: null },
				},
				(error) => {
					if (error) finish(undefined, new Error("Worker could not receive its task"));
				}
			);
		});
	}
	async answer(jobId: string, decisionId: string, answer: string) {
		await this.operation(jobId, async (signal) => {
			await this.patch(
				jobId,
				(current) => {
					if (!admitted(current)) throw new WorkChanged();
					const target = current.decisions.find(
						(item) => item.id === decisionId && item.answer === null
					);
					if (current.state !== "needs-input" || !target) throw new WorkChanged();
					this.interrupt(jobId, signal);
					target.answer = answer;
					target.answeredAt = new Date().toISOString();
					current.state = "queued";
					current.error = null;
				},
				signal
			);
		});
		this.schedule();
	}
	async resume(jobId: string) {
		await this.operation(jobId, async (signal) => {
			await this.patch(
				jobId,
				(current) => {
					if (!admitted(current) || !["paused", "failed"].includes(current.state))
						throw new WorkChanged();
					this.interrupt(jobId, signal);
					current.state = "queued";
					current.pauseReason = null;
					current.error = null;
				},
				signal
			);
		});
		this.schedule();
	}
	private schedule() {
		void this.pump().catch(() =>
			this.options.hub.workerFailure(
				"Worker scheduling could not update its state. Existing work was retained."
			)
		);
	}
	async pause(jobId: string, reason: "user" | "shutdown" = "user") {
		const active = this.interrupt(jobId);
		await this.patch(jobId, (current) => {
			const admitted = this.interrupt(jobId);
			if (
				["queued", "running", "validating"].includes(current.state) ||
				(current.state === "ready" && (active || admitted))
			) {
				current.state = "paused";
				current.pauseReason = reason;
			}
		});
		this.schedule();
	}
	async cancel(jobId: string) {
		this.interrupt(jobId);
		await this.patch(jobId, (current) => {
			this.interrupt(jobId);
			current.state = "cancelled";
			current.pauseReason = null;
		});
		this.schedule();
	}
	async review(jobId: string): Promise<WorkReview> {
		return this.options.runtime.review(await this.options.hub.job(jobId));
	}
	async publish(jobId: string) {
		const previous = this.publications.get(jobId);
		if (previous) return previous;
		const work = this.operation(jobId, (signal) => this.publishOnce(jobId, signal)).finally(() => {
			if (this.publications.get(jobId) === work) this.publications.delete(jobId);
		});
		this.publications.set(jobId, work);
		return work;
	}
	private async publishOnce(jobId: string, signal: AbortSignal) {
		const job = await this.call(signal, () => this.options.hub.job(jobId));
		if (!admitted(job) || job.state !== "ready" || !job.headSha || !job.changedFiles.length)
			throw new Error("Review the ready work before publishing");
		const repository = await this.call(signal, () =>
			this.options.hub.readyRepository(job.repositoryId)
		);
		if (!repository.defaultBranch) throw new Error("Repository branch unavailable");
		await this.current(job, signal);
		if (job.feedback) {
			await this.publishFeedback(job, repository, signal, ["ready"]);
			return;
		}
		const rows = await this.call(signal, () => this.options.github.reviews(job.repository, signal));
		const existing = job.pullRequest
			? rows.find((row) => row.pr.id === job.pullRequest?.id)
			: rows.find(
					(row) =>
						row.kind === "own" &&
						row.headBranch === job.branch &&
						row.baseBranch === repository.defaultBranch
				);
		await this.current(job, signal);
		if (existing?.pr.headSha === job.headSha) {
			await this.patchCurrent(job, signal, (current) => {
				current.pullRequest = existing.pr;
				current.publishedHeadSha = job.headSha;
			});
			return;
		}
		await this.call(signal, () => this.options.runtime.push(job, repository, signal));
		await this.patchCurrent(job, signal, (current) => {
			current.publishedHeadSha = job.headSha;
		});
		if (existing) {
			const updated = (
				await this.call(signal, () => this.options.github.reviews(job.repository, signal))
			).find((row) => row.pr.id === existing.pr.id)?.pr;
			if (!updated || updated.headSha !== job.headSha)
				throw new Error("Publication could not be refreshed");
			await this.patchCurrent(job, signal, (current) => {
				current.pullRequest = updated;
			});
			return;
		}
		await this.current(job, signal);
		const pr = await this.call(signal, () =>
			this.options.github.createDraft(
				{
					repository: job.repository,
					base: repository.defaultBranch as string,
					head: job.branch,
					title: job.ticket ? `${job.ticket.identifier}: ${job.ticket.title}` : "Muse work",
					body: `${job.summary}\n\nChecks: ${job.checks.length ? job.checks.map((check) => `${check.command} ${check.args.join(" ")}: ${check.exitCode}`).join("\n") : "No configured checks run"}\n\n${job.ticket?.url ?? ""}`,
				},
				signal
			)
		);
		await this.patchCurrent(job, signal, (current) => {
			current.pullRequest = pr;
		});
	}
	async revise(jobId: string, instruction: string) {
		await this.operation(jobId, async (signal) => {
			const job = await this.call(signal, () => this.options.hub.job(jobId));
			const states: WorkJob["state"][] = ["ready", "paused", "failed"];
			if (!admitted(job)) throw new WorkChanged();
			if (!states.includes(job.state))
				throw new Error("Pause or review this work before requesting changes");
			this.interrupt(jobId, signal);
			let ticket = job.ticket;
			if (ticket) {
				const actual = await this.call(signal, () =>
					this.options.linear.ticket(job.ticket?.id ?? "", signal)
				);
				await this.current(job, signal, states);
				if (actual.state.type === "completed")
					ticket = await this.call(signal, () =>
						this.options.linear.updateState(actual.id, "started", signal)
					);
			}
			await this.patchCurrent(
				job,
				signal,
				(current) => {
					this.interrupt(jobId, signal);
					current.ticket = ticket;
					current.revisions = [
						...(current.revisions ?? []),
						{ instruction, createdAt: new Date().toISOString() },
					];
					// Publish the new revision only after clearing the previous pass's retry context.
					this.retries.delete(jobId);
					this.feedback.delete(jobId);
					current.state = "queued";
					current.reviewedAt = null;
					current.error = null;
					current.pauseReason = null;
				},
				states
			);
			if (ticket) await this.call(signal, () => this.options.hub.syncTicket(ticket));
		});
		this.schedule();
	}
	async approve(jobId: string, headSha: string) {
		await this.operation(jobId, async (signal) => {
			const job = await this.call(signal, () => this.options.hub.job(jobId));
			if (!admitted(job) || job.state !== "ready" || job.headSha !== headSha)
				throw new Error("Review the current work revision before accepting it");
			const actual = await this.call(signal, () => this.options.runtime.review(job, signal));
			if (actual.job.headSha !== headSha) throw new Error("Work revision changed");
			await this.current(job, signal);
			const ticket = job.ticket
				? await this.call(signal, () =>
						this.options.linear.updateState(job.ticket?.id ?? "", "completed", signal)
					)
				: null;
			await this.patchCurrent(job, signal, (current) => {
				current.ticket = ticket;
				current.reviewedAt = new Date().toISOString();
			});
			if (ticket) await this.call(signal, () => this.options.hub.syncTicket(ticket));
		});
	}
	private async maybeApplyFeedback(
		job: WorkJob,
		repository: WatchedRepository,
		signal: AbortSignal
	) {
		if (
			!job.feedback ||
			!job.pullRequest ||
			!job.changedFiles.length ||
			job.feedback.commitSha !== job.baseSha ||
			!job.checks.length ||
			job.checks.some((check) => check.exitCode !== 0)
		)
			return;
		if (
			!(await this.call(signal, () => this.options.hub.snapshot())).preferences.autoApplySuggestions
		)
			return;
		const states: WorkJob["state"][] = ["validating"];
		try {
			const assess = this.options.assessSuggestion;
			if (!assess) return;
			const review = await this.call(signal, () => this.options.runtime.review(job, signal));
			const assessment = await this.call(signal, () => assess(job, review, signal));
			await this.current(job, signal, states);
			await this.append(job.id, `[inferred fix assessment] ${assessment.reason}`);
			if (assessment.question?.trim()) {
				await this.patchCurrent(
					job,
					signal,
					(current) => {
						current.state = "needs-input";
						current.decisions.push({
							id: randomUUID(),
							question: assessment.question ?? "A product decision is needed.",
							reason: assessment.reason,
							createdAt: new Date().toISOString(),
							answer: null,
							answeredAt: null,
						});
					},
					states
				);
				const pending = await this.call(signal, () => this.options.hub.job(job.id));
				await this.notify(
					pending,
					signal,
					{
						kind: "decision",
						title: "Decision before applying PR feedback",
						detail: assessment.question,
						jobId: job.id,
						prId: job.pullRequest.id,
					},
					"needs-input"
				);
				return;
			}
			if (assessment.sound) await this.publishFeedback(job, repository, signal, states);
		} catch (error) {
			throwIfAborted(signal);
			if (error instanceof WorkChanged) throw error;
			await this.append(
				job.id,
				"Suggestion is ready locally; automatic acceptance was not confirmed. Inspect the assessment and PR branch before retrying."
			);
		}
	}
	private async publishFeedback(
		job: WorkJob,
		repository: WatchedRepository,
		signal: AbortSignal,
		states: WorkJob["state"][]
	) {
		if (!job.feedback || !job.pullRequest || !job.headSha)
			throw new Error("Feedback work is unavailable");
		await this.current(job, signal, states);
		const row = (
			await this.call(signal, () => this.options.github.reviews(job.repository, signal))
		).find((item) => item.pr.id === job.pullRequest?.id && item.kind === "own");
		const expected = job.publishedHeadSha ?? job.baseSha;
		if (
			!row ||
			row.headBranch === repository.defaultBranch ||
			(row.pr.headSha !== expected && row.pr.headSha !== job.headSha)
		)
			throw new Error("The PR branch changed before publication");
		await this.current(job, signal, states);
		await this.call(signal, () =>
			this.options.runtime.push(job, repository, signal, row.headBranch)
		);
		await this.patchCurrent(
			job,
			signal,
			(current) => {
				current.publishedHeadSha = job.headSha;
				current.feedbackAppliedAt = new Date().toISOString();
			},
			states
		);
		const refreshed = (
			await this.call(signal, () => this.options.github.reviews(job.repository, signal))
		).find((item) => item.pr.id === job.pullRequest?.id)?.pr;
		if (refreshed?.headSha === job.headSha)
			await this.patchCurrent(
				job,
				signal,
				(current) => {
					current.pullRequest = refreshed;
				},
				states
			);
		await this.current(job, signal, states);
		await this.append(
			job.id,
			"Validated changes applied to the PR branch; no merge was performed."
		);
	}

	private async append(jobId: string, value: string) {
		const task = (this.logs.get(jobId) ?? Promise.resolve())
			.catch(() => {})
			.then(async () => {
				const directory = join(this.options.directory, jobId);
				await mkdir(directory, { recursive: true, mode: 0o700 });
				const path = join(directory, "terminal.log");
				if ((await stat(path).catch(() => ({ size: 0 }))).size > 8 * 1024 * 1024) return;
				const text = (this.options.redact?.(value) ?? value).slice(0, 50000);
				await appendFile(path, `${text}\n`, { mode: 0o600 });
			});
		this.logs.set(jobId, task);
		await task;
	}
	async log(jobId: string, cursor = 0, limit = 100) {
		await this.options.hub.job(jobId);
		await this.logs.get(jobId)?.catch(() => {});
		const text = await readFile(join(this.options.directory, jobId, "terminal.log"), "utf8").catch(
			() => ""
		);
		const lines = text.split("\n");
		const page = lines
			.slice(cursor, cursor + Math.min(200, limit))
			.map((line) => line.slice(0, 12000));
		return WorkLogPageSchema.parse({
			jobId,
			cursor: cursor + page.length,
			lines: page,
			truncated: page.some((line) => line.length >= 12000) || text.length > 8 * 1024 * 1024,
		});
	}
	async dispose() {
		this.stopping = true;
		for (const id of this.operations.keys()) this.interrupt(id);
		for (const job of await this.options.hub.allJobs())
			if (["queued", "running", "validating"].includes(job.state))
				await this.pause(job.id, "shutdown");
		for (const run of this.running.values()) run.controller.abort();
		await Promise.allSettled([...this.running.values()].map((run) => run.promise));
		await Promise.allSettled([...this.logs.values()]);
	}
}
