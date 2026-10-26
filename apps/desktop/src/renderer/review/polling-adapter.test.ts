import assert from "node:assert/strict";
import { it } from "node:test";
import { getReviewFixture } from "../../shared/fixtures/review";
import { createPollingAgentAdapter } from "./polling-adapter";

const fixture = getReviewFixture();
const identity = {
	sessionId: fixture.agentTurn.sessionId,
	turnId: fixture.agentTurn.turnId,
	generation: fixture.agentTurn.generation,
};
const ports = {
	start: async () => identity,
	cancel: async () => {},
	getScenario: async () => fixture.scenario,
	getPreview: async () => fixture.preview,
	getDiagram: async () => fixture.diagram,
};

it("drains terminal event pages using the last event sequence, not the latest snapshot sequence", async () => {
	const cursors: number[] = [];
	let text = "";
	const adapter = createPollingAgentAdapter(
		{
			...ports,
			poll: async (input) => {
				cursors.push(input.afterSequence);
				return {
					...identity,
					status: "completed",
					sequence: 102,
					text: "x".repeat(101),
					actions: [],
					events:
						input.afterSequence === 0
							? Array.from({ length: 100 }, (_, i) => ({
									...identity,
									sequence: i + 1,
									kind: "text-delta",
									delta: "x",
								}))
							: [
									{ ...identity, sequence: 101, kind: "text-delta", delta: "x" },
									{ ...identity, sequence: 102, kind: "completed" },
								],
				};
			},
		},
		0
	);
	await adapter.ask(
		fixture.agentTurn,
		{
			text: (delta) => {
				text += delta;
			},
			replaceText: (value) => {
				text = value;
			},
			action: async () => {},
		},
		new AbortController().signal
	);
	assert.deepEqual(cursors, [0, 100]);
	assert.equal(text, "x".repeat(101));
});

it("recovers compacted history from a validated snapshot without losing actions", async () => {
	let text = "";
	const actions: string[] = [];
	const adapter = createPollingAgentAdapter(
		{
			...ports,
			poll: async () => ({
				...identity,
				status: "completed",
				sequence: 200,
				text: "Complete answer",
				actions: fixture.actions,
				events: [{ ...identity, kind: "completed", sequence: 200 }],
			}),
		},
		0
	);
	await adapter.ask(
		fixture.agentTurn,
		{
			text: (delta) => {
				text += delta;
			},
			replaceText: (value) => {
				text = value;
			},
			action: async (action) => {
				actions.push(action.requestId);
			},
		},
		new AbortController().signal
	);
	assert.equal(text, "Complete answer");
	assert.deepEqual(
		actions,
		fixture.actions.map((action) => action.requestId)
	);
});
