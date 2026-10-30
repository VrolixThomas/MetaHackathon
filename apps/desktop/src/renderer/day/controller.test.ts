import assert from "node:assert/strict";
import { it } from "node:test";
import type { DayOperationResult } from "../../shared/contracts/day";
import { DAY_ACTION_ERROR, DAY_LOAD_ERROR, createDayController } from "./controller";
import { deferred, snapshot, workItem } from "./test-support";

const operation = { kind: "cover", itemId: "item", expectedRevision: 3 } as const;
const result = (sequence = 2): DayOperationResult => ({
	requestId: "request",
	itemId: "item",
	snapshot: snapshot([workItem()], { sequence, currentItemId: "item" }),
});

it("starts empty, deduplicates observations and rejects late responses after disposal", async () => {
	const pending = deferred<ReturnType<typeof snapshot>>();
	let calls = 0;
	const day = createDayController({
		snapshot: () => {
			calls++;
			return pending.promise;
		},
		operate: async () => result(),
	});
	assert.equal(day.store.getState().snapshot, null);
	const start = day.start();
	const refresh = day.refresh();
	await Promise.resolve();
	assert.equal(calls, 1);
	assert.equal(day.store.getState().loading, true);
	day.dispose();
	pending.resolve(snapshot([workItem()]));
	await Promise.all([start, refresh]);
	assert.equal(day.store.getState().snapshot, null);
});

it("does not optimistically accept ownership and serializes explicit user mutations", async () => {
	const pending = deferred<DayOperationResult>();
	let calls = 0;
	const day = createDayController({
		snapshot: async () => snapshot([workItem()]),
		operate: () => {
			calls++;
			return pending.promise;
		},
	});
	await day.refresh();
	const action = day.operate({ ...operation, kind: "accept" });
	await Promise.resolve();
	assert.equal(day.store.getState().busy, true);
	assert.equal(day.store.getState().snapshot?.items[0]?.acceptance, "pending");
	assert.equal(await day.operate(operation), null);
	assert.equal(calls, 1);
	pending.resolve(result());
	await action;
	assert.equal(day.store.getState().busy, false);
	day.dispose();
});

it("fences older and equal conflicting snapshots after an acknowledged mutation", async () => {
	const pending = deferred<ReturnType<typeof snapshot>>();
	let read = 0;
	const day = createDayController({
		snapshot: () =>
			++read === 1 ? pending.promise : Promise.resolve(snapshot([], { sequence: 8 })),
		operate: async () => result(8),
	});
	const refresh = day.refresh();
	await day.operate(operation);
	pending.resolve(snapshot([], { sequence: 2 }));
	await refresh;
	assert.equal(day.store.getState().snapshot?.sequence, 8);
	await day.refresh();
	assert.equal(day.store.getState().snapshot?.items[0]?.id, "item");
	day.dispose();
});

it("background reads started before or during a mutation cannot erase its failure", async () => {
	for (const during of [false, true]) {
		const read = deferred<ReturnType<typeof snapshot>>();
		const action = deferred<DayOperationResult>();
		const day = createDayController({
			snapshot: () => read.promise,
			operate: () => action.promise,
		});
		let observing: Promise<void>;
		let operating: Promise<DayOperationResult | null>;
		if (during) {
			operating = day.operate(operation);
			observing = day.refresh();
		} else {
			observing = day.refresh();
			operating = day.operate(operation);
		}
		action.reject(new Error("private-provider-error"));
		await operating;
		read.resolve(snapshot());
		await observing;
		assert.equal(day.store.getState().error, DAY_ACTION_ERROR);
		assert.doesNotMatch(JSON.stringify(day.store.getState()), /private-provider-error/);
		day.dispose();
	}
});

it("retains real saved work on read failure and recovers only on a fresh read", async () => {
	let fail = false;
	const day = createDayController({
		snapshot: async () => {
			if (fail) throw new Error("source-secret");
			return snapshot([workItem()]);
		},
		operate: async () => result(),
	});
	await day.refresh();
	fail = true;
	await day.refresh();
	assert.equal(day.store.getState().snapshot?.items[0]?.id, "item");
	assert.equal(day.store.getState().error, DAY_LOAD_ERROR);
	fail = false;
	await day.refresh();
	assert.equal(day.store.getState().error, "");
	day.dispose();
});

it("disposal fences an in-flight action and stops future operations", async () => {
	const action = deferred<DayOperationResult>();
	const day = createDayController({
		snapshot: async () => snapshot(),
		operate: () => action.promise,
	});
	const operating = day.operate(operation);
	day.dispose();
	action.resolve(result());
	assert.equal(await operating, null);
	assert.equal(await day.operate(operation), null);
	assert.equal(day.store.getState().snapshot, null);
});
