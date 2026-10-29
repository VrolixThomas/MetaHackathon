import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
	type LinearTicket,
	type PullRequest,
	type PullRequestFeedback,
	type WatchedRepository,
	type WorkJob,
	WorkJobSchema,
	WorkLogPageSchema,
	type WorkReview,
} from "../../shared/contracts";
import { type CodingTaskInput, CodingTaskResultSchema } from "../agent/coding-worker";
import type { HubGitHubClient } from "../runtime/hub-github";
import type { HubLinearClient } from "../runtime/hub-linear";
import type { WorkJobRuntime } from "../runtime/work-job-runtime";
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
const inProgress = new Set(["queued", "running", "validating", "needs-input", "paused"]);
interface JobOptions {
	hub: CommandCenterService;
	runtime: WorkJobRuntime;
	github: HubGitHubClient;
	linear: HubLinearClient;
	directory: string;
	workerEntry: string;
	envPath: string;
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
	constructor(private readonly options: JobOptions) {}
	async restore() {
		await this.options.hub.initialize();
		await this.options.hub.update((state) => {
			for (const job of state.jobs) {
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
		const job = this.make(repository, ticket, null, brief);
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
		const job = this.make(repository, null, feedback, brief);
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
	private make(
		repository: WatchedRepository,
		ticket: LinearTicket | null,
		feedback: PullRequestFeedback | null,
		brief: string
	): WorkJob {
		const id = randomUUID();
		const now = new Date().toISOString();
		return WorkJobSchema.parse({
			id,
			ticket,
			feedback,
			repositoryId: repository.id,
			repository: repository.repository,
			state: "queued",
			branch: `muse/${(ticket?.identifier ?? "feedback").toLowerCase().replace(/[^a-z0-9-]/g, "-")}-${id.slice(0, 8)}`,
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
	private async patch(id: string, update: (job: WorkJob) => void) {
		await this.options.hub.update((state) => {
			const job = state.jobs.find((item) => item.id === id);
			if (!job) throw new Error("Work is unavailable");
			update(job);
			job.updatedAt = new Date().toISOString();
		});
	}
	private async pump() {
		if (this.stopping || this.pumping) return;
		this.pumping = true;
		try {
			while (!this.stopping) {
				const snapshot = await this.options.hub.snapshot();
				if (this.running.size >= snapshot.preferences.maxWorkers) return;
				const job = (await this.options.hub.allJobs()).find(
					(item) => item.state === "queued" && !this.running.has(item.id)
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
					.catch(() =>
						this.options.hub.workerFailure(
							"A worker could not confirm or save its state. Its worktree was retained."
						)
					)
					.finally(() => {
						if (this.running.get(job.id) === run) this.running.delete(job.id);
						void this.pump().catch(() =>
							this.options.hub.workerFailure(
								"Worker scheduling could not update its state. Existing work was retained."
							)
						);
					});
			}
		} finally {
			this.pumping = false;
		}
	}
	private live(id: string, run: Running) {
		return !this.stopping && !run.controller.signal.aborted && this.running.get(id) === run;
	}
	private async execute(initial: WorkJob, run: Running) {
		try {
			const signal = run.controller.signal;
			const repository = await this.options.hub.readyRepository(initial.repositoryId);
			await this.patch(initial.id, (job) => {
				job.state = "running";
				job.error = null;
				job.pauseReason = null;
			});
			let job = await this.options.hub.job(initial.id);
			if (!job.worktreePath) {
				await this.append(job.id, "Preparing an isolated worktree.");
				const prepared = await this.options.runtime.prepare(
					repository,
					job,
					signal,
					job.feedback && job.baseSha ? { baseCommit: job.baseSha } : undefined
				);
				if (!this.live(job.id, run)) return;
				await this.patch(job.id, (current) => Object.assign(current, prepared));
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
			const result = await this.runChild(job, run, input);
			if (!this.live(job.id, run)) return;
			if (result.status === "needs-input") {
				await this.patch(job.id, (current) => {
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
				});
				await this.options.hub.notice({
					kind: "decision",
					title: `Decision needed: ${job.ticket?.identifier ?? "PR feedback"}`,
					detail: result.question ?? "A decision is needed.",
					jobId: job.id,
					prId: job.pullRequest?.id ?? null,
				});
				return;
			}
			await this.patch(job.id, (current) => {
				current.state = "validating";
				current.summary = result.summary;
			});
			await this.append(job.id, "Committing changes and checking the actual commit.");
			const finalized = await this.options.runtime.finalize(
				await this.options.hub.job(job.id),
				signal
			);
			if (!this.live(job.id, run)) return;
			for (const check of finalized.checks)
				await this.append(
					job.id,
					`[check] ${check.command} ${check.args.join(" ")} exited ${check.exitCode}\n${await this.options.runtime.getLog(check.logId)}`
				);
			await this.patch(job.id, (current) => {
				Object.assign(current, finalized);
				if (!finalized.changedFiles.length)
					current.summary =
						"No source changes were produced. Review the recorded checks and existing implementation.";
			});
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
				this.feedback.set(job.id, feedback.slice(0, 20000));
				const count = (this.retries.get(job.id) ?? 0) + 1;
				this.retries.set(job.id, count);
				if (count <= 2) {
					await this.patch(job.id, (current) => {
						current.state = "queued";
						current.error = "Validation failed; Muse is addressing the actual check results.";
					});
					return;
				}
				throw new Error("Validation remains unsuccessful");
			}
			await this.patch(job.id, (current) => {
				current.state = "ready";
				current.error = null;
			});
			await this.append(
				job.id,
				`Ready for review at ${finalized.headSha}. ${finalized.checks.length} checks recorded.`
			);
			await this.maybeApplyFeedback(await this.options.hub.job(job.id), repository, signal);
			const ready = await this.options.hub.job(job.id);
			if (ready.state === "needs-input") return;
			await this.options.hub.notice({
				kind: "work-ready",
				title: `Ready to review: ${job.ticket?.identifier ?? "PR feedback"}`,
				detail:
					ready.summary.slice(0, 2500) +
					(finalized.checks.length ? "" : "\nNo configured validation commands were run."),
				jobId: job.id,
				prId: job.pullRequest?.id ?? null,
			});
		} catch (error) {
			if (!this.live(initial.id, run)) return;
			await this.append(initial.id, "Worker could not complete; inspect its latest log and retry.");
			await this.patch(initial.id, (job) => {
				job.state = "failed";
				job.error =
					"Muse could not finish this work. Check its execution log and connection, then resume.";
			});
			await this.options.hub.notice({
				kind: "work-failed",
				title: `Work needs attention: ${initial.ticket?.identifier ?? "PR feedback"}`,
				detail:
					"The work did not complete successfully. Its worktree and execution log were retained.",
				jobId: initial.id,
				prId: initial.pullRequest?.id ?? null,
			});
		}
	}
	private runChild(job: WorkJob, run: Running, input: CodingTaskInput) {
		return new Promise<z.infer<typeof CodingTaskResultSchema>>((resolve, reject) => {
			const child = fork(this.options.workerEntry, [], {
				silent: true,
				env: {
					PATH: process.env["PATH"],
					HOME: process.env["HOME"],
					LANG: process.env["LANG"],
					TMPDIR: process.env["TMPDIR"],
					ELECTRON_RUN_AS_NODE: "1",
				},
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
			child.send({ kind: "run", input, envPath: this.options.envPath }, (error) => {
				if (error) finish(undefined, new Error("Worker could not receive its task"));
			});
		});
	}
	async answer(jobId: string, decisionId: string, answer: string) {
		const job = await this.options.hub.job(jobId);
		const decision = job.decisions.find((item) => item.id === decisionId && item.answer === null);
		if (job.state !== "needs-input" || !decision)
			throw new Error("This decision is no longer pending");
		await this.patch(jobId, (current) => {
			const target = current.decisions.find((item) => item.id === decisionId);
			if (target) {
				target.answer = answer;
				target.answeredAt = new Date().toISOString();
			}
			current.state = "queued";
			current.error = null;
		});
		void this.pump().catch(() =>
			this.options.hub.workerFailure(
				"Worker scheduling could not update its state. Existing work was retained."
			)
		);
	}
	async resume(jobId: string) {
		const job = await this.options.hub.job(jobId);
		if (!["paused", "failed"].includes(job.state)) throw new Error("This work cannot resume yet");
		await this.patch(jobId, (current) => {
			current.state = "queued";
			current.pauseReason = null;
			current.error = null;
		});
		void this.pump().catch(() =>
			this.options.hub.workerFailure(
				"Worker scheduling could not update its state. Existing work was retained."
			)
		);
	}
	async pause(jobId: string, reason: "user" | "shutdown" = "user") {
		const job = await this.options.hub.job(jobId);
		if (!["queued", "running", "validating"].includes(job.state)) return;
		const run = this.running.get(jobId);
		this.running.delete(jobId);
		run?.controller.abort();
		await this.patch(jobId, (current) => {
			current.state = "paused";
			current.pauseReason = reason;
		});
		if (run) {
			await Promise.race([run.promise, new Promise((resolve) => setTimeout(resolve, 2000))]);
			if (run.child && !run.done) run.child.kill("SIGKILL");
		}
		void this.pump().catch(() =>
			this.options.hub.workerFailure(
				"Worker scheduling could not update its state. Existing work was retained."
			)
		);
	}
	async cancel(jobId: string) {
		await this.pause(jobId);
		await this.patch(jobId, (current) => {
			current.state = "cancelled";
			current.pauseReason = null;
		});
	}
	async review(jobId: string): Promise<WorkReview> {
		return this.options.runtime.review(await this.options.hub.job(jobId));
	}
	async publish(jobId: string) {
		const previous = this.publications.get(jobId);
		if (previous) return previous;
		const work = this.publishOnce(jobId).finally(() => {
			if (this.publications.get(jobId) === work) this.publications.delete(jobId);
		});
		this.publications.set(jobId, work);
		return work;
	}
	private async publishOnce(jobId: string) {
		const job = await this.options.hub.job(jobId);
		if (job.state !== "ready" || !job.headSha || !job.changedFiles.length)
			throw new Error("Review the ready work before publishing");
		const repository = await this.options.hub.readyRepository(job.repositoryId);
		if (!repository.defaultBranch) throw new Error("Repository branch unavailable");
		if (job.feedback) {
			await this.publishFeedback(job, repository, new AbortController().signal);
			return;
		}
		const rows = await this.options.github.reviews(job.repository);
		const existing = job.pullRequest
			? rows.find((row) => row.pr.id === job.pullRequest?.id)
			: rows.find(
					(row) =>
						row.kind === "own" &&
						row.headBranch === job.branch &&
						row.baseBranch === repository.defaultBranch
				);
		if (existing?.pr.headSha === job.headSha) {
			await this.patch(jobId, (current) => {
				current.pullRequest = existing.pr;
				current.publishedHeadSha = job.headSha;
			});
			return;
		}
		await this.options.runtime.push(job, repository, new AbortController().signal);
		await this.patch(jobId, (current) => {
			current.publishedHeadSha = job.headSha;
		});
		if (existing) {
			const updated = (await this.options.github.reviews(job.repository)).find(
				(row) => row.pr.id === existing.pr.id
			)?.pr;
			if (!updated || updated.headSha !== job.headSha)
				throw new Error("Publication could not be refreshed");
			await this.patch(jobId, (current) => {
				current.pullRequest = updated;
			});
			return;
		}
		const pr = await this.options.github.createDraft({
			repository: job.repository,
			base: repository.defaultBranch,
			head: job.branch,
			title: job.ticket ? `${job.ticket.identifier}: ${job.ticket.title}` : "Muse work",
			body: `${job.summary}\n\nChecks: ${job.checks.length ? job.checks.map((check) => `${check.command} ${check.args.join(" ")}: ${check.exitCode}`).join("\n") : "No configured checks run"}\n\n${job.ticket?.url ?? ""}`,
		});
		await this.patch(jobId, (current) => {
			current.pullRequest = pr;
		});
	}
	async revise(jobId: string, instruction: string) {
		const job = await this.options.hub.job(jobId);
		if (!["ready", "paused", "failed"].includes(job.state))
			throw new Error("Pause or review this work before requesting changes");
		if (job.ticket) {
			const current = await this.options.linear.ticket(job.ticket.id);
			if (current.state.type === "completed") {
				const updated = await this.options.linear.updateState(current.id, "started");
				await this.options.hub.syncTicket(updated);
				await this.patch(jobId, (item) => {
					item.ticket = updated;
				});
			}
		}
		await this.patch(jobId, (current) => {
			current.revisions = [
				...(current.revisions ?? []),
				{ instruction, createdAt: new Date().toISOString() },
			];
			current.state = "queued";
			current.reviewedAt = null;
			current.error = null;
			current.pauseReason = null;
		});
		this.retries.delete(jobId);
		this.feedback.delete(jobId);
		void this.pump().catch(() =>
			this.options.hub.workerFailure("Worker scheduling could not update its state.")
		);
	}
	async approve(jobId: string, headSha: string) {
		const job = await this.options.hub.job(jobId);
		if (job.state !== "ready" || job.headSha !== headSha)
			throw new Error("Review the current work revision before accepting it");
		const actual = await this.options.runtime.review(job);
		if (actual.job.headSha !== headSha) throw new Error("Work revision changed");
		if (job.ticket) {
			const ticket = await this.options.linear.updateState(job.ticket.id, "completed");
			await this.options.hub.syncTicket(ticket);
			await this.patch(jobId, (current) => {
				current.ticket = ticket;
				current.reviewedAt = new Date().toISOString();
			});
		} else
			await this.patch(jobId, (current) => {
				current.reviewedAt = new Date().toISOString();
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
			job.checks.some((check) => check.exitCode !== 0) ||
			!(await this.options.hub.snapshot()).preferences.autoApplySuggestions
		)
			return;
		try {
			if (!this.options.assessSuggestion) return;
			const assessment = await this.options.assessSuggestion(
				job,
				await this.options.runtime.review(job, signal),
				signal
			);
			await this.append(job.id, `[inferred fix assessment] ${assessment.reason}`);
			if (assessment.question?.trim()) {
				await this.patch(job.id, (current) => {
					current.state = "needs-input";
					current.decisions.push({
						id: randomUUID(),
						question: assessment.question ?? "A product decision is needed.",
						reason: assessment.reason,
						createdAt: new Date().toISOString(),
						answer: null,
						answeredAt: null,
					});
				});
				await this.options.hub.notice({
					kind: "decision",
					title: "Decision before applying PR feedback",
					detail: assessment.question,
					jobId: job.id,
					prId: job.pullRequest.id,
				});
				return;
			}
			if (!assessment.sound) return;
			await this.publishFeedback(job, repository, signal);
		} catch {
			await this.append(
				job.id,
				"Suggestion is ready locally; automatic acceptance was not confirmed. Inspect the assessment and PR branch before retrying."
			);
		}
	}
	private async publishFeedback(job: WorkJob, repository: WatchedRepository, signal: AbortSignal) {
		if (!job.feedback || !job.pullRequest || !job.headSha)
			throw new Error("Feedback work is unavailable");
		const row = (await this.options.github.reviews(job.repository, signal)).find(
			(item) => item.pr.id === job.pullRequest?.id && item.kind === "own"
		);
		const expected = job.publishedHeadSha ?? job.baseSha;
		if (
			!row ||
			row.headBranch === repository.defaultBranch ||
			(row.pr.headSha !== expected && row.pr.headSha !== job.headSha)
		)
			throw new Error("The PR branch changed before publication");
		await this.options.runtime.push(job, repository, signal, row.headBranch);
		await this.patch(job.id, (current) => {
			current.publishedHeadSha = job.headSha;
			current.feedbackAppliedAt = new Date().toISOString();
		});
		const refreshed = (await this.options.github.reviews(job.repository, signal)).find(
			(item) => item.pr.id === job.pullRequest?.id
		)?.pr;
		if (refreshed?.headSha === job.headSha)
			await this.patch(job.id, (current) => {
				current.pullRequest = refreshed;
			});
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
		for (const job of await this.options.hub.allJobs())
			if (["queued", "running", "validating"].includes(job.state))
				await this.pause(job.id, "shutdown");
		for (const run of this.running.values()) run.controller.abort();
		await Promise.allSettled([...this.running.values()].map((run) => run.promise));
		await Promise.allSettled([...this.logs.values()]);
	}
}
