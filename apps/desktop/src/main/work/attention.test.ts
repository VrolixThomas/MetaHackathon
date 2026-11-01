import assert from "node:assert/strict";
import { it } from "node:test";
import {
	type AttentionPresence,
	type HubPersistence,
	HubPersistenceSchema,
	WorkJobSchema,
} from "../../shared/contracts";
import { type AttentionPorts, AttentionScheduler } from "./attention";
const base = Date.parse("2026-10-30T15:00:00Z");
const first = <T>(items: T[]) => {
	const item = items[0];
	assert.ok(item);
	return item;
};
const iso = (offset = 0) => new Date(base + offset).toISOString();
const readyJob = (id = "job", kind = "ready") =>
	WorkJobSchema.parse({
		id,
		ticket: null,
		repositoryId: "owner/repo",
		repository: "owner/repo",
		state: kind,
		branch: `muse/${id}`,
		worktreePath: `/controlled/${id}`,
		baseSha: "a".repeat(40),
		headSha: "b".repeat(40),
		brief: "Controlled task",
		summary: "Controlled result, not authority",
		createdAt: iso(),
		updatedAt: iso(),
		decisions:
			kind === "needs-input"
				? [
						{
							id: `decision-${id}`,
							question: "Should the existing behavior stay?",
							reason: "Product choice",
							createdAt: iso(),
							answer: null,
							answeredAt: null,
						},
					]
				: [],
		checks: [],
		changedFiles: ["src/code.ts"],
		pullRequest: null,
		error: null,
	});
function harness() {
	let clock = base;
	let state: HubPersistence = HubPersistenceSchema.parse({
		version: 1,
		repositories: [],
		preferences: {
			linearTeamIds: [],
			linearProjectIds: [],
			maxWorkers: 2,
			autoApplySuggestions: false,
		},
		tickets: [],
		jobs: [readyJob()],
		notices: [
			{
				id: "notice",
				kind: "work-ready",
				title: "Actual result",
				detail: "Untrusted worker text",
				jobId: "job",
				prId: null,
				createdAt: iso(),
				announcedAt: null,
				seenAt: null,
				headSha: "b".repeat(40),
			},
		],
	});
	let busy = false;
	let completed = false;
	let focused = true;
	const interrupted: unknown[] = [];
	const presence: AttentionPresence = {
		sessionId: "session",
		enabled: true,
		state: "idle",
		focused: true,
		obscured: false,
		activitySequence: 0,
	};
	const ports: AttentionPorts = {
		read: async () => structuredClone(state),
		update: async (mutator) => {
			const next = structuredClone(state);
			mutator(next);
			state = HubPersistenceSchema.parse(next);
		},
		isBusy: () => busy,
		completed: () => completed,
		interrupt: (turn) => interrupted.push(turn),
		focused: () => focused,
		now: () => clock,
		id: () => `claim-${clock}`,
	};
	const scheduler = new AttentionScheduler(ports);
	return {
		scheduler,
		ports,
		presence,
		interrupted,
		get state() {
			return state;
		},
		set busy(v: boolean) {
			busy = v;
		},
		set completed(v: boolean) {
			completed = v;
		},
		set focused(v: boolean) {
			focused = v;
		},
		advance: (ms: number) => {
			clock += ms;
		},
		async claim() {
			await scheduler.poll(presence);
			clock += 2500;
			return (await scheduler.poll(presence)).claim;
		},
	};
}
const receipt = (claimId: string) => ({
	sessionId: "session",
	turnId: "turn",
	generation: 1,
	claimId,
});
const turn = (claimId: string) => ({
	sessionId: "session",
	turnId: "turn",
	generation: 1,
	requestId: "request",
	claimId,
});
it("waits for actual quiet eligibility, groups actual notices, and reserves only one delivery", async () => {
	const h = harness();
	assert.equal((await h.scheduler.poll(h.presence)).claim, null);
	h.advance(2499);
	assert.equal((await h.scheduler.poll(h.presence)).claim, null);
	h.advance(1);
	const result = await h.scheduler.poll(h.presence);
	assert.ok(result.claim);
	assert.equal(result.claim.items[0]?.jobId, "job");
	assert.equal(h.state.attentionRecords?.[0]?.attempts, 1);
	assert.equal((await h.scheduler.poll(h.presence)).claim, null);
	assert.equal(h.state.notices[0]?.announcedAt, null);
});
it("defers for speech, active response, dialogs, focus, typing and a busy main turn", async () => {
	for (const patch of [
		{ state: "user-speaking" },
		{ state: "responding" },
		{ state: "interacting" },
		{ obscured: true },
		{ focused: false },
		{ enabled: false },
	]) {
		const h = harness();
		Object.assign(h.presence, patch);
		assert.equal(await h.claim(), null);
	}
	const h = harness();
	h.busy = true;
	assert.equal(await h.claim(), null);
	h.busy = false;
	h.focused = false;
	assert.equal(await h.claim(), null);
});
it("a user activity sequence restarts the quiet period and native input invalidates bound delivery immediately", async () => {
	const h = harness();
	await h.scheduler.poll(h.presence);
	h.advance(2500);
	h.presence.activitySequence++;
	assert.equal((await h.scheduler.poll(h.presence)).claim, null);
	h.advance(2500);
	const claim = (await h.scheduler.poll(h.presence)).claim;
	assert.ok(claim);
	await h.scheduler.resolve(turn(claim.id), new AbortController().signal);
	h.scheduler.noteActivity();
	assert.equal(h.interrupted.length, 1);
	h.completed = true;
	assert.deepEqual(await h.scheduler.settle({ ...receipt(claim.id), status: "spoken" }), {
		status: "stale",
	});
	assert.equal(h.state.notices[0]?.announcedAt, null);
});
it("announces only after current-turn completion and durable acknowledgement, and does not repeat on scheduler reopen", async () => {
	const h = harness();
	const claim = await h.claim();
	assert.ok(claim);
	await h.scheduler.resolve(turn(claim.id), new AbortController().signal);
	assert.deepEqual(await h.scheduler.settle({ ...receipt(claim.id), status: "spoken" }), {
		status: "stale",
	});
	h.completed = true;
	assert.deepEqual(await h.scheduler.settle({ ...receipt(claim.id), status: "spoken" }), {
		status: "accepted",
	});
	assert.ok(h.state.notices[0]?.announcedAt);
	assert.ok(h.state.attentionRecords?.[0]?.deliveredAt);
	const reopened = new AttentionScheduler(h.ports);
	await reopened.poll(h.presence);
	h.advance(70_000);
	assert.equal((await reopened.poll(h.presence)).claim, null);
});
it("interruptions retain queue entries with a persisted retry delay and bounded automatic attempts", async () => {
	const h = harness();
	for (let attempt = 1; attempt <= 3; attempt++) {
		const claim = await h.claim();
		assert.ok(claim);
		await h.scheduler.resolve(turn(claim.id), new AbortController().signal);
		assert.deepEqual(await h.scheduler.settle({ ...receipt(claim.id), status: "interrupted" }), {
			status: "accepted",
		});
		assert.equal(h.state.attentionRecords?.[0]?.attempts, attempt);
		assert.equal((await h.scheduler.poll(h.presence)).claim, null);
		h.advance(60_000);
	}
	assert.equal(await h.claim(), null);
	assert.equal(h.state.notices[0]?.announcedAt, null);
});
it("ignores accepted, cancelled, seen, answered and wrong-head events; never substitutes another decision", async () => {
	for (const change of [
		(s: HubPersistence) => {
			first(s.jobs).reviewedAt = iso();
		},
		(s: HubPersistence) => {
			first(s.jobs).state = "cancelled";
		},
		(s: HubPersistence) => {
			first(s.notices).seenAt = iso();
		},
		(s: HubPersistence) => {
			first(s.jobs).headSha = "c".repeat(40);
		},
	]) {
		const h = harness();
		await h.ports.update(change);
		assert.equal(await h.claim(), null);
	}
	const h = harness();
	await h.ports.update((s) => {
		s.jobs = [readyJob("job", "needs-input")];
		first(s.notices).kind = "decision";
		first(s.notices).decisionId = "old-answered-decision";
	});
	assert.equal(await h.claim(), null);
});
it("changed heads and answered decisions cancel an in-flight update before its delivery receipt", async () => {
	const h = harness();
	const claim = await h.claim();
	assert.ok(claim);
	await h.scheduler.resolve(turn(claim.id), new AbortController().signal);
	await h.ports.update((s) => {
		first(s.jobs).headSha = "c".repeat(40);
	});
	await h.scheduler.changed();
	assert.equal(h.interrupted.length, 1);
	await assert.rejects(
		h.scheduler.validate(turn(claim.id), new AbortController().signal),
		/no longer current/
	);
});
it("prioritizes decisions and failures and emits at most one item for each current job", async () => {
	const h = harness();
	await h.ports.update((s) => {
		s.jobs.push(readyJob("question", "needs-input"), readyJob("failure", "failed"));
		for (const [id, kind] of [
			["question", "decision"],
			["failure", "work-failed"],
		] as const)
			s.notices.push({
				...first(s.notices),
				id: `notice-${id}`,
				jobId: id,
				kind,
				createdAt: iso(1),
				decisionId: kind === "decision" ? `decision-${id}` : null,
			});
	});
	const claim = await h.claim();
	assert.ok(claim);
	assert.deepEqual(
		claim.items.map((i) => i.kind),
		["decision"]
	);
});
it("delivery store failures preserve the notice and allow the exact receipt to be retried", async () => {
	const h = harness();
	const claim = await h.claim();
	assert.ok(claim);
	await h.scheduler.resolve(turn(claim.id), new AbortController().signal);
	h.completed = true;
	const original = h.ports.update;
	h.ports.update = async () => {
		throw Error("Controlled storage failure");
	};
	await assert.rejects(h.scheduler.settle({ ...receipt(claim.id), status: "spoken" }));
	assert.equal(h.state.notices[0]?.announcedAt, null);
	h.ports.update = original;
	assert.deepEqual(await h.scheduler.settle({ ...receipt(claim.id), status: "spoken" }), {
		status: "accepted",
	});
});
it("activity during durable claim admission cannot publish an obsolete claim", async () => {
	const h = harness();
	const original = h.ports.update;
	h.ports.update = async (fn) => {
		await original(fn);
		h.scheduler.noteActivity();
	};
	assert.equal(await h.claim(), null);
	assert.equal(h.state.notices[0]?.announcedAt, null);
});

it("an immediate real followup cannot erase already-spoken proof before the final settlement RPC", async () => {
	const h = harness();
	const claim = await h.claim();
	assert.ok(claim);
	await h.scheduler.resolve(turn(claim.id), new AbortController().signal);
	h.completed = true;
	h.scheduler.noteActivity();
	h.focused = false;
	h.presence.state = "user-speaking";
	assert.equal(h.interrupted.length, 0);
	assert.deepEqual(await h.scheduler.settle({ ...receipt(claim.id), status: "spoken" }), {
		status: "accepted",
	});
	assert.ok(h.state.notices[0]?.announcedAt);
});
it("a lost final renderer receipt is recovered from exact spoken proof and flushed before shutdown", async () => {
	for (const close of [false, true]) {
		const h = harness();
		const claim = await h.claim();
		assert.ok(claim);
		await h.scheduler.resolve(turn(claim.id), new AbortController().signal);
		h.completed = true;
		if (close) await h.scheduler.dispose();
		else await h.scheduler.poll({ ...h.presence, enabled: false, state: "disabled" });
		assert.ok(h.state.notices[0]?.announcedAt);
		assert.ok(h.state.attentionRecords?.[0]?.deliveredAt);
	}
});

it("clarification judgments use the existing quiet attention lease and stale removal fences delivery", async () => {
	const h = harness();
	h.state.notices = [
		{
			id: "clarification-notice",
			kind: "decision",
			title: "Slack clarification needs judgment",
			detail: "Inspect My day",
			jobId: null,
			prId: null,
			createdAt: iso(),
			announcedAt: null,
			seenAt: null,
			clarification: { itemId: "day-item", policyId: "policy", policyRevision: 1 },
		},
	];
	h.presence.obscured = true;
	assert.equal(await h.claim(), null);
	h.presence.obscured = false;
	const claim = await h.claim();
	assert.ok(claim);
	assert.equal(claim.items[0]?.kind, "clarification");
	assert.equal(claim.items[0]?.repository, null);
	assert.equal(claim.items[0]?.dayItemId, "day-item");
	await h.scheduler.resolve(turn(claim.id), new AbortController().signal);
	h.state.notices = [];
	await h.scheduler.changed();
	await assert.rejects(h.scheduler.validate(turn(claim.id), new AbortController().signal));
	assert.equal(h.state.attentionRecords?.[0]?.deliveredAt, null);
	await h.scheduler.dispose();
});
