import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import {
	type CodingProviderSettings,
	type HubPersistence,
	type LinearTicket,
	type WatchedRepository,
	type WorkJob,
	WorkJobSchema,
	type WorkReview,
} from "../../shared/contracts";
import { NEW_CODING_MODEL } from "../agent/coding-model";
import type { CodingTaskInput, CodingTaskResult } from "../agent/coding-worker";
import type { WorkJobRuntime } from "../runtime/work-job-runtime";
import { readCodingModelAdmission } from "./coding-provider/pin";
import { CommandCenterService } from "./hub";
import { WorkJobCoordinator } from "./jobs";

const time = "2026-10-29T00:00:00Z";

test("queued jobs keep their admission provider while later jobs use the changed preference", async (t) => {
	const fixture = await harness(t);
	fixture.internal.pump = async () => {};
	let preference: CodingProviderSettings = { provider: "muse-code", musePath: "/opt/muse" };
	Object.assign(fixture.options, { codingSettings: async () => preference });
	const first = await fixture.jobs.start(ticket, repository, "First real request", "first");
	preference = { provider: "meta-api", musePath: null };
	const second = await fixture.jobs.start(
		{ ...ticket, id: "second-ticket" },
		repository,
		"Second request",
		"second"
	);
	assert.deepEqual((await fixture.hub.job(first)).codingProvider, {
		provider: "muse-code",
		musePath: "/opt/muse",
	});
	assert.deepEqual((await fixture.hub.job(second)).codingProvider, preference);
	assert.equal((await fixture.hub.job(first)).state, "queued");
});
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
async function harness(t: TestContext, initial = job(), persisted?: HubPersistence) {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "muse-coordinator-test-")));
	let stored: HubPersistence = persisted ?? {
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
	const linearCalls: string[] = [];
	const preparations: Array<{
		repository: WatchedRepository;
		job: Pick<WorkJob, "id" | "branch">;
		signal: AbortSignal;
		options?: { baseCommit?: string };
	}> = [];
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
		prepare: async (
			repository: WatchedRepository,
			job: Pick<WorkJob, "id" | "branch">,
			signal: AbortSignal,
			options?: { baseCommit?: string }
		) => {
			preparations.push({ repository, job: structuredClone(job), signal, options });
			return {
				worktreePath: "/controlled/worktree",
				branch: job.branch,
				baseSha: initial.baseSha as string,
			};
		},
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
		ticket: async (_id: string, _signal?: AbortSignal) => {
			linearCalls.push("ticket");
			return ticket;
		},
		updateState: async (
			_id: string,
			state: "started" | "completed" | "unstarted",
			signal?: AbortSignal
		): Promise<LinearTicket> => {
			linearCalls.push(state);
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
		linearCalls,
		preparations,
		initial,
		checks,
		snapshot: () => hub.snapshot(),
		stored: () => structuredClone(stored),
		get: () => hub.job(initial.id),
		start: () => internal.pump(),
	};
}

const actor = { workspaceId: "workspace", userId: "owner" };
const internalRequest = {
	actor,
	itemId: "day-item",
	requestId: "prepare-request",
	repository,
	brief: "Implement the accepted source-bound request; source revision: 7",
};
const executeRequest = (jobId: string) => ({ actor, jobId, requestId: "start-work-request" });
function assertNoPublication(h: Awaited<ReturnType<typeof harness>>) {
	assert.deepEqual(h.linearCalls, []);
	assert.deepEqual(h.pushes, []);
	assert.deepEqual(h.drafts, []);
}

test("internal preparation coalesces, persists its binding before the isolated prepare and starts no child", async (t) => {
	const h = await harness(t);
	const gate = deferred<{ worktreePath: string; branch: string; baseSha: string }>();
	let preparing: WorkJob | undefined;
	let calls = 0;
	h.runtime.prepare = async (actualRepository, actualJob) => {
		calls++;
		assert.deepEqual(actualRepository, repository);
		preparing = WorkJobSchema.parse(actualJob);
		assert.equal(preparing.ticket, null);
		assert.equal(preparing.internal?.stage, "preparing");
		assert.deepEqual(await h.hub.job(preparing.id), preparing);
		return gate.promise;
	};
	const first = h.jobs.prepareInternal(internalRequest);
	const second = h.jobs.prepareInternal(structuredClone(internalRequest));
	await eventually(() => !!preparing);
	assert(preparing);
	assert.equal(preparing.state, "paused");
	assert.match(preparing.branch, /^muse\/internal-[a-f0-9]{8}$/);
	assert.deepEqual(h.inputs, []);
	await assert.rejects(
		h.jobs.prepareInternal({
			...internalRequest,
			brief: `${internalRequest.brief}\nDifferent body`,
		}),
		/binding mismatch/
	);
	gate.resolve({
		worktreePath: "/controlled/internal-worktree",
		branch: preparing.branch,
		baseSha: "e".repeat(40),
	});
	const [id, replay] = await Promise.all([first, second]);
	assert.equal(id, replay);
	assert.equal(calls, 1);
	const prepared = await h.hub.job(id);
	assert.equal(prepared.ticket, null);
	assert.equal(prepared.feedback, null);
	assert.equal(prepared.state, "paused");
	assert.equal(prepared.worktreePath, "/controlled/internal-worktree");
	assert.equal(prepared.baseSha, "e".repeat(40));
	assert.equal(prepared.headSha, null);
	assert.deepEqual(prepared.internal, {
		workspaceId: actor.workspaceId,
		ownerUserId: actor.userId,
		itemId: internalRequest.itemId,
		requestId: internalRequest.requestId,
		bindingDigest: prepared.internal?.bindingDigest,
		stage: "prepared",
	});
	assert.match(prepared.internal?.bindingDigest ?? "", /^[a-f0-9]{64}$/);
	await h.start();
	assert.deepEqual(h.inputs, []);
	assertNoPublication(h);
});

test("prepared internal work replays after restart and rejects a reused request's changed body, actor or repository", async (t) => {
	const first = await harness(t);
	const id = await first.jobs.prepareInternal(internalRequest);
	const saved = first.stored();
	const restarted = await harness(t, job(), saved);
	await restarted.jobs.restore();
	assert.equal(await restarted.jobs.prepareInternal(structuredClone(internalRequest)), id);
	assert.deepEqual(restarted.preparations, []);
	assert.deepEqual(restarted.inputs, []);
	for (const changed of [
		{ brief: `${internalRequest.brief} ` },
		{ itemId: "other-item" },
		{ actor: { ...actor, userId: "other-user" } },
		{ actor: { ...actor, workspaceId: "other-workspace" } },
		{ repository: { ...repository, localPath: "/other-checkout" } },
	])
		await assert.rejects(
			restarted.jobs.prepareInternal({ ...internalRequest, ...changed }),
			/binding mismatch/
		);
	assert.deepEqual(restarted.stored(), saved);
	assertNoPublication(restarted);
});

test("only scoped admission runs the existing internal worker; its caller cannot cancel admitted work or complete Linear", async (t) => {
	const h = await harness(t);
	const id = await h.jobs.prepareInternal(internalRequest);
	for (const invalidActor of [
		{ ...actor, userId: "other-user" },
		{ ...actor, workspaceId: "other-workspace" },
	])
		await assert.rejects(
			h.jobs.executeInternal({ ...executeRequest(id), actor: invalidActor }),
			/origin or scope mismatch/
		);
	await assert.rejects(h.jobs.executeInternal(executeRequest("job")), /origin or scope mismatch/);
	const gate = deferred<CodingTaskResult>();
	let workerSignal: AbortSignal | undefined;
	h.internal.runChild = async (value, run, input) => {
		assert.equal(value.internal?.stage, "admitted");
		workerSignal = run.controller.signal;
		h.inputs.push(input);
		return gate.promise;
	};
	const lifetime = new AbortController();
	await Promise.all([
		h.jobs.executeInternal(executeRequest(id), lifetime.signal),
		h.jobs.executeInternal(executeRequest(id), lifetime.signal),
	]);
	await eventually(() => !!workerSignal);
	assert.equal(h.preparations[1]?.options?.baseCommit, "a".repeat(40));
	assert.equal(h.inputs.length, 1);
	assert.equal(h.inputs[0]?.ticket, null);
	lifetime.abort();
	assert.equal(workerSignal?.aborted, false);
	gate.resolve({ status: "completed", summary: "Controlled internal implementation" });
	await eventually(async () => (await h.hub.job(id)).state === "ready");
	await eventually(() => h.internal.running.size === 0);
	await h.jobs.executeInternal(executeRequest(id));
	assert.equal(h.inputs.length, 1, "Repeated admission never reruns a ready job");
	await h.jobs.approve(id, (await h.hub.job(id)).headSha as string);
	assert((await h.hub.job(id)).reviewedAt);
	assert.equal((await h.hub.job(id)).internal?.stage, "admitted");
	assertNoPublication(h);
	const restarted = await harness(t, job(), h.stored());
	await restarted.jobs.restore();
	await restarted.jobs.executeInternal(executeRequest(id));
	assert.equal(restarted.inputs.length, 0, "Durable admission replay never reruns completed work");
	assertNoPublication(restarted);
});

test("admitted internal work reuses decisions, pause/resume, review and shutdown restore without Linear writes", async (t) => {
	const h = await harness(t);
	const id = await h.jobs.prepareInternal(internalRequest);
	h.internal.runChild = async (_job, run, input) => {
		h.inputs.push(input);
		run.done = true;
		return h.inputs.length === 1
			? { status: "needs-input", summary: "Needs choice", question: "Which behavior?" }
			: { status: "completed", summary: "User choice applied" };
	};
	await h.jobs.executeInternal(executeRequest(id));
	await eventually(async () => (await h.hub.job(id)).state === "needs-input");
	const decision = (await h.hub.job(id)).decisions[0];
	assert(decision);
	await h.jobs.answer(id, decision.id, "Keep the existing behavior");
	await eventually(async () => (await h.hub.job(id)).state === "ready");
	await eventually(() => h.internal.running.size === 0);
	assert(h.inputs[1]?.decisionContext?.includes("User decision: Keep the existing behavior"));
	assert(
		h.inputs.every(
			(input) => JSON.stringify(input.codingModel) === JSON.stringify(NEW_CODING_MODEL)
		)
	);
	assert.equal((await h.jobs.review(id)).job.ticket, null);
	await h.jobs.revise(id, "Add the requested check");
	await h.jobs.pause(id);
	await eventually(() => h.internal.running.size === 0);
	assert.equal((await h.hub.job(id)).state, "paused");
	await h.jobs.restore();
	assert.equal((await h.hub.job(id)).state, "paused");
	await h.jobs.resume(id);
	await eventually(async () => (await h.hub.job(id)).state === "ready");
	await eventually(() => h.internal.running.size === 0);
	assert(
		h.inputs.at(-1)?.decisionContext?.includes("User review instruction: Add the requested check")
	);
	await h.hub.update((state) => {
		const value = state.jobs.find((item) => item.id === id);
		assert(value);
		value.state = "paused";
		value.pauseReason = "shutdown";
	});
	const restarted = await harness(t, job(), h.stored());
	await restarted.jobs.restore();
	await eventually(() => restarted.inputs.length === 1);
	await eventually(() => restarted.internal.running.size === 0);
	assert.equal((await restarted.hub.job(id)).internal?.stage, "admitted");
	assert.equal(restarted.inputs[0]?.worktreePath, "/controlled/worktree");
	assertNoPublication(h);
	assertNoPublication(restarted);
});

test("changed preparation records and repository scope cannot publish late preparation pins", async (t) => {
	for (const changed of ["record", "scope"] as const) {
		const h = await harness(t);
		const gate = deferred<{ worktreePath: string; branch: string; baseSha: string }>();
		let preparing: Pick<WorkJob, "id" | "branch"> | undefined;
		h.runtime.prepare = async (_repository, value) => {
			preparing = value;
			return gate.promise;
		};
		const preparation = h.jobs.prepareInternal(internalRequest);
		const rejected = assert.rejects(preparation, /changed|scope mismatch/i);
		await eventually(() => !!preparing);
		assert(preparing);
		const id = preparing.id;
		await h.hub.update((state) => {
			if (changed === "scope") state.repositories[0] = { ...repository, localPath: "/other" };
			else {
				const value = state.jobs.find((item) => item.id === id);
				assert(value);
				value.brief += " Changed source";
			}
		});
		gate.resolve({
			worktreePath: "/controlled/worktree",
			branch: preparing.branch,
			baseSha: "a".repeat(40),
		});
		await rejected;
		assert.equal((await h.hub.job(id)).internal?.stage, "preparing");
		assert.equal((await h.hub.job(id)).worktreePath, null);
		assert.deepEqual(h.inputs, []);
		assertNoPublication(h);
	}
});

test("internal preparation source cancellation returns promptly and discards a provider's late worktree", async (t) => {
	for (const interruption of ["source", "pause", "cancel", "shutdown"] as const) {
		const h = await harness(t);
		const gate = deferred<{ worktreePath: string; branch: string; baseSha: string }>();
		let current: Pick<WorkJob, "id" | "branch"> | undefined;
		let runtimeSignal: AbortSignal | undefined;
		h.runtime.prepare = async (_repository, value, signal) => {
			current = value;
			runtimeSignal = signal;
			return gate.promise;
		};
		const source = new AbortController();
		const preparation = h.jobs.prepareInternal(internalRequest, source.signal);
		const rejected = aborted(preparation);
		await eventually(() => !!runtimeSignal);
		assert(current);
		const id = current.id;
		if (interruption === "source") source.abort();
		else if (interruption === "shutdown") await prompt(h.jobs.dispose());
		else await prompt(h.jobs[interruption](id));
		await prompt(rejected);
		assert(runtimeSignal?.aborted);
		const retained = await h.hub.job(id);
		gate.resolve({
			worktreePath: "/retained/owned/partial-worktree",
			branch: current.branch,
			baseSha: "a".repeat(40),
		});
		await Promise.resolve();
		await Promise.resolve();
		assert.deepEqual(await h.hub.job(id), retained);
		assert.equal(retained.internal?.stage, "preparing");
		assert.equal(retained.worktreePath, null);
		assert.deepEqual(h.inputs, []);
		assertNoPublication(h);
		if (interruption === "source") {
			const restarted = await harness(t, job(), h.stored());
			await restarted.jobs.restore();
			assert.deepEqual(restarted.inputs, []);
			assert.equal(await restarted.jobs.prepareInternal(internalRequest), id);
			assert.equal((await restarted.hub.job(id)).internal?.stage, "prepared");
		}
	}
});

test("a coalesced source signal aborts preparation and an already-aborted signal creates no job", async (t) => {
	const h = await harness(t);
	const dead = new AbortController();
	dead.abort();
	await aborted(h.jobs.prepareInternal(internalRequest, dead.signal));
	assert.equal((await h.hub.allJobs()).length, 1);
	const gate = deferred<{ worktreePath: string; branch: string; baseSha: string }>();
	let signal: AbortSignal | undefined;
	h.runtime.prepare = async (_repository, _job, current) => {
		signal = current;
		return gate.promise;
	};
	const first = aborted(h.jobs.prepareInternal(internalRequest));
	await eventually(() => !!signal);
	const source = new AbortController();
	const second = aborted(h.jobs.prepareInternal(internalRequest, source.signal));
	source.abort();
	await prompt(Promise.all([first, second]));
	assert(signal?.aborted);
	assert.equal((await h.hub.allJobs()).length, 2);
	gate.reject(Error("Late controlled failure"));
	assert.deepEqual(h.inputs, []);
});

test("pending internal jobs cannot enter the worker through resume, revise, answer, restore or pump", async (t) => {
	for (const stage of ["preparing", "prepared"] as const) {
		for (const state of [
			"paused",
			"queued",
			"running",
			"validating",
			"needs-input",
			"ready",
			"failed",
		] as const) {
			const h = await harness(t);
			const id = await h.jobs.prepareInternal(internalRequest);
			await h.hub.update((store) => {
				const value = store.jobs.find((row) => row.id === id);
				assert(value?.internal);
				value.internal.stage = stage;
				value.state = state;
				value.headSha = "b".repeat(40);
				value.changedFiles = ["caller.ts"];
				value.pauseReason = "shutdown";
				value.decisions = [
					{
						id: "decision",
						question: "Controlled pending question",
						reason: "Controlled",
						createdAt: time,
						answer: null,
						answeredAt: null,
					},
				];
			});
			const retained = await h.hub.job(id);
			await aborted(h.jobs.resume(id));
			await aborted(h.jobs.revise(id, "Try to bypass admission"));
			await aborted(h.jobs.answer(id, "decision", "Try to bypass admission"));
			await assert.rejects(h.jobs.publish(id), /Review the ready work/);
			await assert.rejects(h.jobs.approve(id, "b".repeat(40)), /Review the current work/);
			await h.jobs.restore();
			await h.start();
			assert.deepEqual(await h.hub.job(id), retained);
			assert.deepEqual(h.inputs, []);
			assertNoPublication(h);
		}
	}
});

test("admission rejects preparation without pins, cancelled jobs and altered internal origins or current repository scope", async (t) => {
	for (const alteration of ["stage", "cancel", "brief", "ticket", "repository", "pins"] as const) {
		const h = await harness(t);
		const id = await h.jobs.prepareInternal(internalRequest);
		await h.hub.update((store) => {
			const value = store.jobs.find((row) => row.id === id);
			assert(value?.internal);
			if (alteration === "stage") value.internal.stage = "preparing";
			if (alteration === "cancel") value.state = "cancelled";
			if (alteration === "brief") value.brief += " altered source binding";
			if (alteration === "ticket") value.ticket = ticket;
			if (alteration === "repository")
				store.repositories[0] = { ...repository, localPath: "/other" };
			if (alteration === "pins") value.baseSha = null;
		});
		await assert.rejects(h.jobs.executeInternal(executeRequest(id)));
		assert.deepEqual(h.inputs, []);
		assertNoPublication(h);
	}
});

test("admission revalidates the current record after owned worktree verification and rejects late cancellation", async (t) => {
	for (const interruption of ["source", "cancel", "pause", "record", "scope", "pins"] as const) {
		const h = await harness(t);
		const id = await h.jobs.prepareInternal(internalRequest);
		const initial = await h.hub.job(id);
		const gate = deferred<{ worktreePath: string; branch: string; baseSha: string }>();
		let signal: AbortSignal | undefined;
		h.runtime.prepare = async (_repository, _job, current) => {
			signal = current;
			return gate.promise;
		};
		const source = new AbortController();
		const execution = h.jobs.executeInternal(executeRequest(id), source.signal);
		const rejected = assert.rejects(execution, /cancel|interrupt|changed|scope mismatch/i);
		await eventually(() => !!signal);
		if (interruption === "source") source.abort();
		else if (interruption === "cancel" || interruption === "pause")
			await prompt(h.jobs[interruption](id));
		else if (interruption !== "pins")
			await h.hub.update((store) => {
				if (interruption === "scope")
					store.repositories[0] = { ...repository, localPath: "/other" };
				else {
					const value = store.jobs.find((row) => row.id === id);
					assert(value);
					value.brief += " Changed during preparation";
				}
			});
		if (["source", "cancel", "pause"].includes(interruption)) {
			await prompt(rejected);
			assert(signal?.aborted);
		}
		gate.resolve({
			worktreePath: initial.worktreePath as string,
			branch: initial.branch,
			baseSha: interruption === "pins" ? "f".repeat(40) : (initial.baseSha as string),
		});
		await rejected;
		assert.equal((await h.hub.job(id)).internal?.stage, "prepared");
		assert.deepEqual(h.inputs, []);
		assertNoPublication(h);
	}
});

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
	assert.equal(h.stored().tickets[0]?.state.type, "started");
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
	assert.equal(h.stored().tickets[0]?.state.type, "started");
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

test("new queued API jobs persist model before dispatch; a legacy queued job with no checkpoint stays unpinned", async (t) => {
	const h = await harness(t);
	const pump = h.internal.pump.bind(h.internal);
	h.internal.pump = async () => {};
	const id = await h.jobs.start(ticket, repository, "New exact task", "new-pin");
	const admitted = await h.hub.job(id);
	assert.equal(admitted.worktreePath, null);
	assert.deepEqual(await readCodingModelAdmission(h.options.directory, admitted), NEW_CODING_MODEL);
	assert.equal(
		(admitted as unknown as Record<string, unknown>)["codingModel"],
		undefined,
		"no public DTO extension"
	);
	await pump();
	await eventually(async () => (await h.hub.job(id)).state === "ready");
	assert.deepEqual(h.inputs[0]?.codingModel, NEW_CODING_MODEL);
	const old = await harness(t, {
		...job("queued"),
		codingProvider: { provider: "meta-api", musePath: null },
		worktreePath: null,
	});
	await old.jobs.restore();
	await eventually(async () => (await old.hub.job("job")).state === "ready");
	assert.equal(old.inputs.length, 1);
	assert.equal(
		old.inputs[0]?.codingModel,
		undefined,
		"missing admission means legacy at the pin boundary"
	);
	assert.equal(
		await readCodingModelAdmission(old.options.directory, await old.hub.job("job")),
		undefined
	);
});

test("admission metadata reopens privately and rejects source/provider drift or corrupt bytes", async (t) => {
	const h = await harness(t);
	h.internal.pump = async () => {};
	const id = await h.jobs.start(ticket, repository, "Private exact task", "new-pin");
	const admitted = await h.hub.job(id);
	assert.deepEqual(
		await readCodingModelAdmission(h.options.directory, structuredClone(admitted)),
		NEW_CODING_MODEL
	);
	for (const change of [
		{ brief: "changed" },
		{ repository: "other/repo" },
		{ codingProvider: { provider: "muse-code" as const, musePath: null } },
	]) {
		await assert.rejects(
			readCodingModelAdmission(h.options.directory, { ...admitted, ...change }),
			/identity changed/
		);
	}
	const name = (await readdir(h.options.directory)).find((name) =>
		name.startsWith(".coding-model-")
	);
	assert(name);
	const path = join(h.options.directory, name);
	const bytes = await readFile(path, "utf8");
	assert(!bytes.includes(admitted.brief));
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	await writeFile(path, "{corrupt");
	await assert.rejects(readCodingModelAdmission(h.options.directory, admitted));
});

test("subscription admission remains unchanged and a new coordinator reuses queued API admission", async (t) => {
	const h = await harness(t);
	h.internal.pump = async () => {};
	Object.assign(h.options, {
		codingSettings: async () => ({ provider: "muse-code", musePath: "/controlled/muse" }),
	});
	const cliId = await h.jobs.start(ticket, repository, "CLI request", "cli");
	assert.equal(
		await readCodingModelAdmission(h.options.directory, await h.hub.job(cliId)),
		undefined
	);
	Object.assign(h.options, {
		codingSettings: async () => ({ provider: "meta-api", musePath: null }),
	});
	const id = await h.jobs.start({ ...ticket, id: "api-ticket" }, repository, "API request", "api");
	await h.jobs.dispose();
	const restarted = new WorkJobCoordinator(h.options);
	t.after(() => restarted.dispose());
	const seen: CodingTaskInput[] = [];
	(restarted as unknown as Internals).runChild = async (_job, run, input) => {
		seen.push(input);
		run.done = true;
		return { status: "completed", summary: "Controlled" };
	};
	await restarted.restore();
	await eventually(async () => (await h.hub.job(id)).state === "ready");
	assert.deepEqual(seen.find((input) => input.jobId === id)?.codingModel, NEW_CODING_MODEL);
	assert.equal(seen.find((input) => input.jobId === cliId)?.codingModel, undefined);
});

test("failed admission metadata persistence cannot expose or dispatch a new API job", async (t) => {
	const h = await harness(t);
	const blocked = join(h.options.directory, "not-a-directory");
	await writeFile(blocked, "controlled");
	h.options.directory = blocked;
	const before = await h.hub.allJobs();
	await assert.rejects(h.jobs.start(ticket, repository, "Must not admit", "failed-admission"));
	assert.deepEqual(await h.hub.allJobs(), before);
	assert.equal(h.inputs.length, 0);
});
