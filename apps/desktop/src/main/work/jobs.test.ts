import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import {
	type HubPersistence,
	type LinearTicket,
	type WorkJob,
	WorkJobSchema,
	type WorkReview,
} from "../../shared/contracts";
import type { CodingTaskInput, CodingTaskResult } from "../agent/coding-worker";
import type { WorkJobRuntime } from "../runtime/work-job-runtime";
import { CommandCenterService } from "./hub";
import { WorkJobCoordinator } from "./jobs";

const time = "2026-10-29T00:00:00Z";
const ticket = {
	id: "ticket",
	identifier: "MET-49",
	title: "Controlled coordinator test",
	description: "Test-only source",
	url: "https://linear.app/test/issue/MET-49",
	updatedAt: time,
	state: { id: "started", name: "Started", type: "started" as const },
	priority: 1,
	teamId: "team",
	teamName: "Test",
	projectId: null,
	projectName: null,
	assigneeId: "me",
	assigneeName: "Me",
};
const repository = {
	id: "test/repo",
	repository: "test/repo",
	localPath: null,
	defaultBranch: "main",
	addedAt: time,
	linearTeamIds: [],
	linearProjectIds: [],
};
const pr = {
	id: "test/repo#1",
	repository: repository.repository,
	number: 1,
	title: "Controlled PR",
	author: "me",
	url: "https://github.com/test/repo/pull/1",
	baseSha: "c".repeat(40),
	headSha: "a".repeat(40),
};
function job(state: WorkJob["state"] = "ready", feedback = false): WorkJob {
	return WorkJobSchema.parse({
		id: "job",
		ticket: feedback ? null : ticket,
		repositoryId: repository.id,
		repository: repository.repository,
		state,
		branch: "muse/test",
		worktreePath: "/controlled/worktree",
		baseSha: "a".repeat(40),
		headSha: "b".repeat(40),
		brief: "Actual test request",
		summary: "Controlled change",
		createdAt: time,
		updatedAt: time,
		decisions: [],
		checks: [],
		changedFiles: ["caller.ts"],
		pullRequest: feedback ? pr : null,
		error: null,
		reviewedAt: null,
		feedback: feedback
			? {
					id: "feedback",
					prId: pr.id,
					author: "reviewer",
					body: "Controlled feedback",
					url: `${pr.url}#discussion`,
					createdAt: time,
					updatedAt: time,
					kind: "inline",
					state: null,
					path: "caller.ts",
					line: 1,
					commitSha: "a".repeat(40),
					suggestion: "return 2;",
				}
			: null,
	});
}
function deferred<T>() {
	let resolve: (value: T) => void = () => {};
	let reject: (error: Error) => void = () => {};
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
async function eventually(check: () => boolean | Promise<boolean>) {
	for (let attempt = 0; attempt < 500; attempt++) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	throw Error("Expected coordinator state did not settle");
}
async function prompt<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(Error("Cancellation waited for a pending provider")), 150);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
const aborted = (promise: Promise<unknown>) => assert.rejects(promise, /cancel|interrupt|changed/i);
type Running = {
	controller: AbortController;
	child: ChildProcess | null;
	done: boolean;
	promise: Promise<void>;
};
type Internals = {
	pump(): Promise<void>;
	running: Map<string, Running>;
	runChild(job: WorkJob, run: Running, input: CodingTaskInput): Promise<CodingTaskResult>;
};
async function harness(t: TestContext, initial = job()) {
	const directory = await mkdtemp(join(tmpdir(), "muse-coordinator-test-"));
	let stored: HubPersistence = {
		version: 1,
		repositories: [repository],
		preferences: {
			linearTeamIds: [],
			linearProjectIds: [],
			maxWorkers: 1,
			autoApplySuggestions: true,
		},
		tickets: [ticket],
		jobs: [initial],
		notices: [],
	};
	const hub = new CommandCenterService({
		store: {
			loadState: async () => structuredClone(stored),
			saveState: async (value) => {
				stored = structuredClone(value);
			},
			loadReview: async () => null,
			saveReview: async () => {},
		},
		registry: {
			register: () => {},
			ensure: async () => {
				throw Error("No preparation in this unit");
			},
			remove: async () => {},
		},
		connections: async () => ({ github: false, linear: false, model: true }),
		legacyCache: async () => ({ repository: null, localPath: null, prepared: [], progress: [] }),
		github: {
			account: async () => ({ login: "me" }),
			repository: async () => ({
				repository: repository.repository,
				defaultBranch: "main",
				private: false,
			}),
			repositories: async () => [],
			reviews: async () => [],
			feedback: async () => [],
			source: async () => {
				throw Error("No source provider in this unit");
			},
		},
		linear: {
			viewer: async () => ({ id: "me", name: "Me" }),
			tickets: async () => [],
			ticket: async () => ticket,
			scopes: async () => [],
		},
	});
	const inputs: CodingTaskInput[] = [];
	const pushes: Array<{ job: WorkJob; signal: AbortSignal; target?: string }> = [];
	const drafts: AbortSignal[] = [];
	const completions: AbortSignal[] = [];
	const checks = [
		{
			id: "check",
			command: "test",
			args: [],
			commitSha: initial.headSha as string,
			startedAt: time,
			finishedAt: time,
			exitCode: 0,
			logId: "check",
		},
	];
	const runtime = {
		prepare: async () => ({
			worktreePath: "/controlled/worktree",
			branch: initial.branch,
			baseSha: initial.baseSha as string,
		}),
		finalize: async () => ({
			headSha: initial.headSha as string,
			changedFiles: initial.changedFiles,
			checks,
		}),
		review: async (value: WorkJob, _signal?: AbortSignal): Promise<WorkReview> => ({
			job: value,
			files: [],
		}),
		getLog: async () => "Controlled successful check",
		push: async (value: WorkJob, _repository: unknown, signal: AbortSignal, target?: string) => {
			pushes.push({ job: value, signal, target });
		},
	};
	const github = {
		reviews: async (_repository: string, _signal?: AbortSignal) => [
			{
				kind: "own" as const,
				pr: { ...pr, headSha: pushes.length ? (initial.headSha as string) : pr.headSha },
				repositoryId: repository.id,
				headBranch: initial.feedback ? "change" : initial.branch,
				baseBranch: "main",
				updatedAt: time,
				draft: true,
				reviewState: "waiting" as const,
				feedbackCount: 0,
				lastFeedbackAt: null,
			},
		],
		createDraft: async (_input: unknown, signal?: AbortSignal) => {
			assert(signal);
			drafts.push(signal);
			return { ...pr, headSha: initial.headSha as string };
		},
	};
	const linear = {
		ticket: async (_id: string, _signal?: AbortSignal) => ticket,
		updateState: async (
			_id: string,
			state: "started" | "completed" | "unstarted",
			signal?: AbortSignal
		): Promise<LinearTicket> => {
			assert(signal);
			if (state === "completed") completions.push(signal);
			return { ...ticket, state: { id: state, name: state, type: state } };
		},
	};
	const options = {
		hub,
		runtime: runtime as unknown as WorkJobRuntime,
		github: github as unknown as ConstructorParameters<typeof WorkJobCoordinator>[0]["github"],
		linear: linear as unknown as ConstructorParameters<typeof WorkJobCoordinator>[0]["linear"],
		directory,
		workerEntry: "/MUST-NOT-LAUNCH",
		envPath: "/MUST-NOT-READ",
		assessSuggestion: async (_job: WorkJob, _review: WorkReview, _signal: AbortSignal) => ({
			sound: true,
			reason: "Controlled sound fix",
		}),
	};
	const jobs = new WorkJobCoordinator(options);
	const internal = jobs as unknown as Internals;
	internal.runChild = async (_job, run, input) => {
		inputs.push(structuredClone(input));
		run.done = true;
		return { status: "completed", summary: "Actual controlled result" };
	};
	await hub.initialize();
	t.after(async () => {
		await jobs.dispose();
		await hub.dispose();
		await rm(directory, { recursive: true, force: true });
	});
	return {
		jobs,
		hub,
		internal,
		runtime,
		github,
		linear,
		options,
		inputs,
		pushes,
		drafts,
		completions,
		initial,
		checks,
		snapshot: () => hub.snapshot(),
		get: () => hub.job(initial.id),
		start: () => internal.pump(),
	};
}

test("late repository metadata cannot resurrect paused or cancelled work and interruption returns before the provider", async (t) => {
	for (const action of ["pause", "cancel"] as const) {
		const h = await harness(t, job("queued"));
		const gate = deferred<typeof repository>();
		let entered = false;
		let prepared = 0;
		h.hub.readyRepository = async () => {
			entered = true;
			return gate.promise;
		};
		h.runtime.prepare = async () => {
			prepared++;
			throw Error("Preparation must not run after interruption");
		};
		h.initial.worktreePath = null;
		await h.hub.update((state) => {
			const item = state.jobs[0];
			assert(item);
			item.worktreePath = null;
		});
		await h.start();
		await eventually(() => entered);
		const run = h.internal.running.get("job");
		assert(run);
		await prompt(h.jobs[action]("job"));
		assert.equal((await h.get()).state, action === "pause" ? "paused" : "cancelled");
		assert.equal(run.controller.signal.aborted, true);
		gate.resolve(repository);
		await run.promise;
		assert.equal((await h.get()).state, action === "pause" ? "paused" : "cancelled");
		assert.equal(prepared, 0);
		assert.equal(h.inputs.length, 0);
		assert.equal(h.internal.running.size, 0);
		assert.deepEqual((await h.snapshot()).notices, []);
	}
});

test("a cancelled running-state write is rejected inside the durable mutation queue", async (t) => {
	const h = await harness(t, job("queued"));
	const gate = deferred<void>();
	let held = false;
	const originalUpdate = h.hub.update.bind(h.hub);
	h.hub.update = async (mutator) => {
		if (!held) {
			held = true;
			await gate.promise;
		}
		return originalUpdate(mutator);
	};
	await h.start();
	await eventually(() => held);
	const stopping = h.jobs.cancel("job");
	await prompt(stopping);
	gate.resolve();
	await eventually(() => h.internal.running.size === 0);
	assert.equal((await h.get()).state, "cancelled");
	assert.equal(h.inputs.length, 0);
	assert.deepEqual((await h.snapshot()).notices, []);
});

test("cancel during approval review prevents Linear completion and stale acceptance without waiting for review", async (t) => {
	const h = await harness(t);
	const gate = deferred<WorkReview>();
	let signal: AbortSignal | undefined;
	h.runtime.review = async (_value, current) => {
		signal = current;
		return gate.promise;
	};
	const approving = h.jobs.approve("job", h.initial.headSha as string);
	const rejected = aborted(approving);
	await eventually(() => !!signal);
	await prompt(h.jobs.cancel("job"));
	assert(signal?.aborted);
	gate.resolve({ job: h.initial, files: [] });
	await rejected;
	assert.equal(h.completions.length, 0);
	assert.equal((await h.get()).state, "cancelled");
	assert.equal((await h.get()).reviewedAt, null);
	assert.equal((await h.snapshot()).tickets[0]?.state.type, "started");
});

test("a new revision or changed pinned head invalidates pending approval before any external completion", async (t) => {
	for (const change of ["revision", "head"] as const) {
		const h = await harness(t);
		const gate = deferred<WorkReview>();
		let reviewing = false;
		h.runtime.review = async () => {
			reviewing = true;
			return gate.promise;
		};
		const approving = h.jobs.approve("job", h.initial.headSha as string);
		const rejected = aborted(approving);
		await eventually(() => reviewing);
		if (change === "revision") {
			await h.jobs.revise("job", "Use the newly requested product behavior");
			await eventually(() => h.inputs.length === 1);
		} else
			await h.hub.update((state) => {
				const current = state.jobs[0];
				assert(current);
				current.headSha = "d".repeat(40);
			});
		gate.resolve({ job: h.initial, files: [] });
		await rejected;
		assert.equal(h.completions.length, 0);
		assert.equal((await h.get()).reviewedAt, null);
		if (change === "revision") {
			assert.equal(h.inputs[0]?.jobId, h.initial.id);
			assert.equal(h.inputs[0]?.worktreePath, h.initial.worktreePath);
			assert.equal(h.inputs[0]?.brief, h.initial.brief);
			assert(h.inputs[0]?.decisionContext?.includes("Use the newly requested product behavior"));
		}
	}
});

test("cancel aborts a pending Linear mutation and ignores its uncooperative late receipt", async (t) => {
	const h = await harness(t);
	const gate = deferred<typeof ticket>();
	let signal: AbortSignal | undefined;
	h.linear.updateState = async (_id, _state, current) => {
		signal = current;
		return gate.promise;
	};
	const approving = h.jobs.approve("job", h.initial.headSha as string);
	const rejected = aborted(approving);
	await eventually(() => !!signal);
	await prompt(h.jobs.cancel("job"));
	assert(signal?.aborted);
	gate.resolve(ticket);
	await rejected;
	assert.equal((await h.get()).state, "cancelled");
	assert.equal((await h.get()).reviewedAt, null);
	assert.equal((await h.snapshot()).tickets[0]?.state.type, "started");
});

test("feedback stays validating during assessment and cancellation prevents an automatic PR push", async (t) => {
	const h = await harness(t, job("queued", true));
	const gate = deferred<{ sound: boolean; reason: string }>();
	let signal: AbortSignal | undefined;
	h.options.assessSuggestion = async (_job, _review, current) => {
		signal = current;
		return gate.promise;
	};
	await h.start();
	await eventually(() => !!signal);
	assert.equal((await h.get()).state, "validating");
	assert.equal((await h.snapshot()).notices.length, 0);
	await prompt(h.jobs.cancel("job"));
	assert(signal?.aborted);
	gate.resolve({ sound: true, reason: "Controlled sound fix" });
	await eventually(() => h.internal.running.size === 0);
	assert.equal((await h.get()).state, "cancelled");
	assert.equal(h.pushes.length, 0);
	assert.equal((await h.get()).feedbackAppliedAt, undefined);
	assert.deepEqual((await h.snapshot()).notices, []);
});

test("cancel during automatic PR observation prevents push, even when observation ignores abort", async (t) => {
	const h = await harness(t, job("queued", true));
	const gate = deferred<Awaited<ReturnType<typeof h.github.reviews>>>();
	let signal: AbortSignal | undefined;
	h.github.reviews = async (_repository, current) => {
		signal = current;
		return gate.promise;
	};
	await h.start();
	await eventually(() => !!signal);
	await prompt(h.jobs.cancel("job"));
	assert(signal?.aborted);
	gate.resolve([]);
	await eventually(() => h.internal.running.size === 0);
	assert.equal(h.pushes.length, 0);
	assert.equal((await h.get()).state, "cancelled");
	assert.equal((await h.get()).feedbackAppliedAt, undefined);
	assert.deepEqual((await h.snapshot()).notices, []);
});

test("cancel during automatic or manual push aborts its signal and cannot publish a stale receipt", async (t) => {
	for (const automatic of [true, false]) {
		const h = await harness(t, job(automatic ? "queued" : "ready", true));
		const gate = deferred<void>();
		let signal: AbortSignal | undefined;
		let observations = 0;
		const observe = h.github.reviews;
		h.github.reviews = async (...args) => {
			observations++;
			return observe(...args);
		};
		h.runtime.push = async (_job, _repo, current) => {
			signal = current;
			return gate.promise;
		};
		const publishing = automatic ? h.start() : h.jobs.publish("job");
		const settled = automatic ? publishing : aborted(publishing);
		await eventually(() => !!signal);
		await prompt(h.jobs.cancel("job"));
		assert(signal?.aborted);
		gate.resolve();
		await settled;
		await eventually(() => h.internal.running.size === 0);
		const current = await h.get();
		assert.equal(current.state, "cancelled");
		assert.equal(current.publishedHeadSha, undefined);
		assert.equal(current.feedbackAppliedAt, undefined);
		assert.equal(observations, 1);
		assert.equal(h.drafts.length, 0);
		assert.deepEqual((await h.snapshot()).notices, []);
	}
});

test("manual publication refreshes actual job pins before push and never creates a PR after cancellation", async (t) => {
	for (const change of ["cancel", "head"] as const) {
		const h = await harness(t);
		const gate = deferred<Awaited<ReturnType<typeof h.github.reviews>>>();
		let observing = false;
		h.github.reviews = async () => {
			observing = true;
			return gate.promise;
		};
		const publishing = h.jobs.publish("job");
		const rejected = aborted(publishing);
		await eventually(() => observing);
		if (change === "cancel") await prompt(h.jobs.cancel("job"));
		else
			await h.hub.update((state) => {
				const item = state.jobs[0];
				assert(item);
				item.headSha = "d".repeat(40);
			});
		gate.resolve([]);
		await rejected;
		assert.equal(h.pushes.length, 0);
		assert.equal(h.drafts.length, 0);
		assert.equal((await h.get()).pullRequest, null);
	}
});

test("cancel during draft creation aborts publication and ignores late PR metadata", async (t) => {
	const h = await harness(t);
	h.github.reviews = async () => [];
	const gate = deferred<typeof pr>();
	let signal: AbortSignal | undefined;
	h.github.createDraft = async (_input, current) => {
		signal = current;
		return gate.promise;
	};
	const publishing = h.jobs.publish("job");
	const rejected = aborted(publishing);
	await eventually(() => !!signal);
	assert.equal(h.pushes.length, 1);
	await prompt(h.jobs.cancel("job"));
	assert(signal?.aborted);
	gate.resolve({ ...pr, headSha: h.initial.headSha as string });
	await rejected;
	assert.equal((await h.get()).pullRequest, null);
	assert.equal((await h.get()).state, "cancelled");
});

test("normal approval, ordinary publication and automatic feedback retain their real successful receipts", async (t) => {
	const accepted = await harness(t);
	await accepted.jobs.approve("job", accepted.initial.headSha as string);
	assert.equal(accepted.completions.length, 1);
	assert((await accepted.get()).reviewedAt);
	assert.equal(
		(await accepted.snapshot()).tickets.length,
		0,
		"The completed ticket leaves the pending ticket brief"
	);
	const published = await harness(t);
	published.github.reviews = async () => [];
	await published.jobs.publish("job");
	assert.equal(published.pushes.length, 1);
	assert.equal(published.pushes[0]?.target, undefined);
	assert.equal(published.drafts.length, 1);
	assert.equal((await published.get()).pullRequest?.headSha, published.initial.headSha);
	const automatic = await harness(t, job("queued", true));
	await automatic.start();
	await eventually(async () => (await automatic.get()).state === "ready");
	await eventually(() => automatic.internal.running.size === 0);
	assert.equal(automatic.pushes.length, 1);
	assert.equal(automatic.pushes[0]?.target, "change");
	assert((await automatic.get()).feedbackAppliedAt);
	assert.equal((await automatic.snapshot()).notices[0]?.kind, "work-ready");
});

test("answered decisions resume the same task and worktree; user pauses stay paused across restore", async (t) => {
	const initial = job("needs-input");
	initial.decisions = [
		{
			id: "decision",
			question: "Which behavior?",
			reason: "Controlled product choice",
			createdAt: time,
			answer: null,
			answeredAt: null,
		},
	];
	const h = await harness(t, initial);
	await h.jobs.answer("job", "decision", "Keep the existing behavior");
	await eventually(() => h.inputs.length === 1);
	assert.equal(h.inputs[0]?.jobId, initial.id);
	assert.equal(h.inputs[0]?.worktreePath, initial.worktreePath);
	assert(h.inputs[0]?.decisionContext?.includes("User decision: Keep the existing behavior"));
	await eventually(() => h.internal.running.size === 0);
	const paused = await harness(t, { ...job("paused"), pauseReason: "user" });
	await paused.jobs.restore();
	assert.equal((await paused.get()).state, "paused");
	assert.equal(paused.inputs.length, 0);
});

test("resume waits for the old writer to exit without delaying pause or cancellation", async (t) => {
	const h = await harness(t, job("queued"));
	const child = new EventEmitter() as EventEmitter & {
		pid: number;
		exitCode: number | null;
		signalCode: string | null;
		kill(signal: string): boolean;
	};
	child.pid = 123;
	child.exitCode = null;
	child.signalCode = null;
	const signals: string[] = [];
	child.kill = (signal) => {
		signals.push(signal);
		return true;
	};
	const gate = deferred<CodingTaskResult>();
	let calls = 0;
	h.internal.runChild = async (_job, run, input) => {
		calls++;
		h.inputs.push(input);
		if (calls === 1) {
			run.child = child as unknown as ChildProcess;
			return gate.promise;
		}
		run.done = true;
		return { status: "completed", summary: "Resumed controlled result" };
	};
	await h.start();
	await eventually(() => calls === 1);
	await prompt(h.jobs.pause("job"));
	await h.jobs.resume("job");
	assert.equal((await h.get()).state, "queued");
	assert.equal(calls, 1);
	assert(signals.includes("SIGTERM"));
	child.signalCode = "SIGTERM";
	child.emit("exit");
	gate.resolve({ status: "completed", summary: "Discarded late result" });
	await eventually(() => calls === 2);
	await eventually(() => h.internal.running.size === 0);
	assert.equal((await h.get()).state, "ready");
});

test("restore resumes interrupted and shutdown-paused work with the same decision/revision context", async (t) => {
	for (const state of ["running", "validating", "paused"] as const) {
		const initial = job(state);
		initial.pauseReason = state === "paused" ? "shutdown" : null;
		initial.decisions = [
			{
				id: "answered",
				question: "Which behavior?",
				reason: "Product choice",
				createdAt: time,
				answer: "Keep the old behavior",
				answeredAt: time,
			},
		];
		initial.revisions = [{ instruction: "Add the requested review change", createdAt: time }];
		const h = await harness(t, initial);
		await h.jobs.restore();
		await eventually(() => h.inputs.length === 1);
		await eventually(() => h.internal.running.size === 0);
		assert.equal((await h.get()).state, "ready");
		assert.equal((await h.get()).pauseReason, null);
		assert.equal(h.inputs[0]?.jobId, initial.id);
		assert.equal(h.inputs[0]?.worktreePath, initial.worktreePath);
		assert.equal(h.inputs[0]?.brief, initial.brief);
		assert(h.inputs[0]?.decisionContext?.includes("User decision: Keep the old behavior"));
		assert(
			h.inputs[0]?.decisionContext?.includes(
				"User review instruction: Add the requested review change"
			)
		);
		assert.deepEqual((await h.get()).decisions, initial.decisions);
	}
	const waiting = job("needs-input");
	waiting.decisions = [
		{
			id: "pending",
			question: "Which behavior?",
			reason: "Product choice",
			createdAt: time,
			answer: null,
			answeredAt: null,
		},
	];
	const h = await harness(t, waiting);
	await h.jobs.restore();
	assert.equal(h.inputs.length, 0);
	assert.equal((await h.get()).state, "needs-input");
	assert.deepEqual((await h.get()).decisions, waiting.decisions);
});

test("the fixed commit-hook diagnostic stays actionable while arbitrary provider errors remain private", async (t) => {
	const known = "Repository commit hooks require an explicit convention decision before committing";
	for (const message of [known, "PRIVATE_UPSTREAM_ERROR_WITH_CREDENTIAL"]) {
		const h = await harness(t, job("queued"));
		h.runtime.finalize = async () => {
			throw Error(message);
		};
		await h.start();
		await eventually(() => h.internal.running.size === 0);
		assert.equal((await h.get()).state, "failed");
		assert.equal(h.pushes.length, 0);
		const log = (await h.jobs.log("job")).lines.join("\n");
		if (message === known) {
			assert.equal((await h.get()).error, known);
			assert(log.includes(known));
		} else {
			assert(!(await h.get()).error?.includes(message));
			assert(!log.includes(message));
		}
	}
});
