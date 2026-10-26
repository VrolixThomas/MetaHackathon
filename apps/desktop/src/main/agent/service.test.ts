import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentActionSchema } from "../../shared/contracts";
import { createAgentRouter } from "./router";
import { AgentService } from "./service";
import { call, completed, eventually, testContext } from "./test-support";

test("screen-aware tool loop preserves identity and encrypted replay, requests scenario and highlight", async () => {
	const ctx = testContext([
		[
			completed([
				{ type: "reasoning", encrypted_content: "opaque", summary: [] },
				call("show_scenario", { scenarioId: "scenario-c", stepId: "head-4" }),
			]),
		],
		[
			{
				type: "response.output_text.delta",
				delta: "Scenario requested. These are fixture results.",
			},
			completed(),
		],
	]);
	const service = new AgentService(ctx.client, ctx.ports);
	const caller = createAgentRouter(service, ctx.ports.drafts).createCaller({});
	const identity = await caller.start(ctx.fixture.agentTurn);
	assert.equal(identity.status, "running");
	const pollInput = {
		sessionId: identity.sessionId,
		turnId: identity.turnId,
		generation: identity.generation,
	};
	await eventually(() => service.poll(pollInput).status === "completed");
	const result = await caller.poll(pollInput);
	assert.equal(result.events[0]?.kind, "acknowledgement");
	assert.deepEqual(
		result.actions.map((a) => a.kind),
		["show-scenario", "highlight-code"]
	);
	for (const action of result.actions) {
		assert.equal(action.sessionId, identity.sessionId);
		assert.equal(action.generation, identity.generation);
		assert.equal(action.screenSequence, ctx.fixture.screenContext.sequence);
		AgentActionSchema.parse(action);
	}
	assert.equal(ctx.requests.length, 2);
	const replay = JSON.stringify(ctx.requests[1]?.["input"]);
	assert(replay.includes("opaque"));
	assert(replay.includes("function_call_output"));
	assert(replay.includes("currentScreenContext"));
	assert(replay.includes("fixture"));
	assert.equal(ctx.postCount(), 0);
	await service.dispose();
});

test("interruption cancels pending tool work and discards late results from prior generation", async () => {
	const ctx = testContext([
		[completed([call("show_scenario", { scenarioId: "scenario-c" })])],
		[completed()],
	]);
	let resolveScenario: (() => void) | undefined;
	let toolSignal: AbortSignal | undefined;
	ctx.ports.getScenario = (_pr, _id, signal) => {
		toolSignal = signal;
		return new Promise((resolve) => {
			resolveScenario = () => resolve(ctx.fixture.scenario);
		});
	};
	const service = new AgentService(ctx.client, ctx.ports);
	const first = service.start(ctx.fixture.agentTurn);
	const pollFirst = {
		sessionId: first.sessionId,
		turnId: first.turnId,
		generation: first.generation,
	};
	await eventually(() => resolveScenario !== undefined);
	assert.equal(service.cancel({ ...ctx.fixture.cancellation, generation: 99 }).status, "stale");
	assert.equal(service.poll(pollFirst).status, "running");
	assert.equal(service.cancel(ctx.fixture.cancellation).status, "cancelled");
	assert.equal(toolSignal?.aborted, true);
	const second = service.start({
		...ctx.fixture.agentTurn,
		requestId: "next-request",
		turnId: "turn-2",
		generation: 2,
	});
	resolveScenario?.();
	await eventually(
		() =>
			service.poll({
				sessionId: second.sessionId,
				turnId: second.turnId,
				generation: second.generation,
			}).status === "completed"
	);
	assert.equal(service.poll(pollFirst).status, "stale");
	assert.equal(
		service.poll({
			sessionId: second.sessionId,
			turnId: second.turnId,
			generation: second.generation,
		}).actions.length,
		0
	);
	assert.equal(ctx.requests.length, 2);
	await service.dispose();
});

test("draft tool preserves reviewer wording; model cannot post or manufacture confirmation", async () => {
	const ctx = testContext([
		[completed([call("draft_comment", { body: "Please retain later reminder deliveries." })])],
		[completed([call("post_comment", { confirmed: true }, "call-2")])],
		[completed()],
	]);
	const service = new AgentService(ctx.client, ctx.ports);
	service.start(ctx.fixture.agentTurn);
	const identity = {
		sessionId: ctx.fixture.agentTurn.sessionId,
		turnId: ctx.fixture.agentTurn.turnId,
		generation: ctx.fixture.agentTurn.generation,
	};
	await eventually(() => service.poll(identity).status === "completed");
	const action = service.poll(identity).actions[0];
	assert.equal(action?.kind, "draft-comment");
	if (action?.kind !== "draft-comment") throw new Error("Draft expected");
	assert.equal(action.draft.originalWords, ctx.fixture.agentTurn.text);
	assert.equal(ctx.postCount(), 0);
	assert(JSON.stringify(ctx.requests[2]).includes("Tool request failed"));
	await service.dispose();
});

test("navigation while an artifact loads suppresses the stale UI effect", async () => {
	const ctx = testContext([
		[completed([call("show_preview", { previewId: "preview-phone" })])],
		[completed()],
	]);
	ctx.ports.getPreview = async () => {
		ctx.fixture.screenContext.sequence++;
		return ctx.fixture.preview;
	};
	const service = new AgentService(ctx.client, ctx.ports);
	const turn = service.start(ctx.fixture.agentTurn);
	const poll = { sessionId: turn.sessionId, turnId: turn.turnId, generation: turn.generation };
	await eventually(() => service.poll(poll).status === "completed");
	assert.deepEqual(service.poll(poll).actions, []);
	assert(JSON.stringify(ctx.requests[1]).includes("screen-changed"));
	await service.dispose();
});

test("invalid screen and duplicate/stale turn identity are rejected; disposal ends admission", async () => {
	const ctx = testContext([[completed()]]);
	const service = new AgentService(ctx.client, ctx.ports);
	assert.throws(() => service.start({ ...ctx.fixture.agentTurn, screenContext: null }));
	const first = service.start(ctx.fixture.agentTurn);
	assert.deepEqual(service.start(ctx.fixture.agentTurn), first);
	assert.throws(() => service.start({ ...ctx.fixture.agentTurn, text: "different" }), /reused/);
	assert.throws(() => service.start({ ...ctx.fixture.agentTurn, requestId: "changed" }), /stale/);
	await service.dispose();
	assert.throws(() => service.start(ctx.fixture.agentTurn), /disposed/);
});
