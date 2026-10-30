import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyDayState } from "./model";
import { DaySupervisor, type DaySupervisorPorts } from "./supervisor";

const timestamp = "2026-10-31T00:00:00.000Z";
function harness(cycle: DaySupervisorPorts["cycle"] = async () => {}) {
	let now = Date.parse(timestamp);
	const checkpoint = emptyDayState(timestamp).supervisor;
	const availability = { awake: true, online: true };
	let calls = 0;
	const ports: DaySupervisorPorts = {
		read: async () => structuredClone(checkpoint),
		update: async (mutator) => {
			const next = structuredClone(checkpoint);
			mutator(next);
			Object.assign(checkpoint, next);
		},
		cycle: async (signal) => {
			calls++;
			await cycle(signal);
		},
		availability: () => availability,
		now: () => now,
		cadenceMs: 1000,
		maxBackoffMs: 4000,
		operationTimeoutMs: 1000,
	};
	return {
		checkpoint,
		availability,
		ports,
		supervisor: new DaySupervisor(ports),
		calls: () => calls,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

test("successful checks respect durable cadence and coalesce overlapping ticks", async () => {
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const h = harness(async () => gate);
	const first = h.supervisor.tick();
	const second = h.supervisor.tick();
	assert.equal(first, second);
	release?.();
	await first;
	assert.equal(h.calls(), 1);
	assert.equal(h.checkpoint.lastStartedAt, timestamp);
	assert.equal(h.checkpoint.lastCompletedAt, timestamp);
	await h.supervisor.tick();
	assert.equal(h.calls(), 1);
	h.advance(1000);
	await h.supervisor.tick();
	assert.equal(h.calls(), 2);
	await h.supervisor.dispose();
});

test("failure backoff is bounded and survives recreation without claiming a successful check", async () => {
	const h = harness(async () => {
		throw new Error("Controlled check failure");
	});
	await assert.rejects(h.supervisor.tick());
	assert.equal(h.checkpoint.mode, "backoff");
	assert.equal(h.checkpoint.failures, 1);
	assert.equal(h.checkpoint.nextCheckAt, "2026-10-31T00:00:02.000Z");
	assert.equal(h.checkpoint.lastCompletedAt, null);
	await h.supervisor.dispose();
	const reopened = new DaySupervisor(h.ports);
	await reopened.start();
	assert.equal(h.calls(), 1);
	h.advance(2000);
	await assert.rejects(reopened.tick());
	assert.equal(h.checkpoint.failures, 2);
	assert.equal(h.checkpoint.nextCheckAt, "2026-10-31T00:00:06.000Z");
	h.advance(4000);
	await assert.rejects(reopened.tick());
	assert.equal(h.checkpoint.nextCheckAt, "2026-10-31T00:00:10.000Z");
	await reopened.dispose();
});

test("an interrupted durable checking checkpoint resumes from due time and never fabricates completion", async () => {
	const h = harness();
	h.checkpoint.mode = "checking";
	h.checkpoint.lastStartedAt = timestamp;
	h.availability.awake = false;
	await h.supervisor.start();
	assert.equal(h.checkpoint.mode, "sleeping");
	assert.equal(h.checkpoint.lastCompletedAt, null);
	assert.equal(h.calls(), 0);
	h.advance(60000);
	h.availability.awake = true;
	await h.supervisor.availabilityChanged();
	await h.supervisor.tick();
	assert.equal(h.calls(), 1);
	assert.equal(h.checkpoint.lastCompletedAt, "2026-10-31T00:01:00.000Z");
	await h.supervisor.dispose();
});

test("dispose aborts an adapter that ignores cancellation without waiting for its late result", async () => {
	let started: (() => void) | undefined;
	const entered = new Promise<void>((resolve) => {
		started = resolve;
	});
	const h = harness(async () => {
		started?.();
		await new Promise<void>(() => {});
	});
	const pending = h.supervisor.tick();
	await entered;
	await h.supervisor.dispose();
	await pending;
	assert.equal(h.checkpoint.mode, "stopped");
	assert.equal(h.checkpoint.lastCompletedAt, null);
	await h.supervisor.tick();
	assert.equal(h.calls(), 1);
});

test("a hung adapter has a bounded timeout and a durable retry checkpoint", async () => {
	const h = harness(async () => new Promise<void>(() => {}));
	await assert.rejects(h.supervisor.tick());
	assert.equal(h.checkpoint.mode, "backoff");
	assert.equal(h.checkpoint.lastCompletedAt, null);
	assert.equal(h.checkpoint.failures, 1);
	await h.supervisor.dispose();
});
