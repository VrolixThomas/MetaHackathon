import assert from "node:assert/strict";
import { test } from "node:test";
import { getReviewFixture } from "../../shared/fixtures/review";
import { ScreenContextStore, createAgentScreenRouter } from "./screen-context";

test("screen snapshots initialize from the turn and reject out-of-order or conflicting UI state", async () => {
	const initial = getReviewFixture().screenContext;
	const store = new ScreenContextStore();
	const caller = createAgentScreenRouter(store).createCaller({});
	assert.deepEqual(store.get("session", initial), initial);
	const next = { ...initial, sequence: initial.sequence + 1, panel: "diff" as const };
	await caller.update({ sessionId: "session", screenContext: next });
	await caller.update({ sessionId: "session", screenContext: initial });
	assert.deepEqual(store.get("session", initial), next);
	await assert.rejects(
		caller.update({ sessionId: "session", screenContext: { ...next, panel: "why" } })
	);
	const copy = store.get("session", initial);
	copy.prId = "mutated";
	assert.equal(store.get("session", initial).prId, initial.prId);
	await caller.release({ sessionId: "session" });
	assert.deepEqual(store.get("session", initial), initial);
});
