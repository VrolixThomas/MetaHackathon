import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import type { AgentAction, AgentTurnInput } from "../../shared/contracts";
import { getReviewFixture } from "../../shared/fixtures/review";
import { useReview } from "./controller";
import { cancelActiveQuestion, runAgentQuestion, useConversation } from "./conversation";
import { type AgentAdapter, configureReviewServices } from "./services";
import { initialFiles } from "./workspace-data";

const fixture = getReviewFixture();
beforeEach(() =>
	useReview.setState({
		preparation: fixture.preparation,
		files: initialFiles,
		file: "pricing/applyDiscounts.ts",
		panel: null,
		selection: null,
		sequence: 0,
		sourceMode: "reference",
	})
);
afterEach(async () => {
	await cancelActiveQuestion();
	configureReviewServices({ agent: null, sources: null });
});

function harness() {
	let resolve = () => {};
	let observer: Parameters<AgentAdapter["ask"]>[1] | undefined;
	let input: AgentTurnInput | undefined;
	let cancelled = 0;
	const adapter: AgentAdapter = {
		ask: (request, callbacks) => {
			input = request;
			observer = callbacks;
			return new Promise<void>((done) => {
				resolve = done;
			});
		},
		cancel: async () => {
			cancelled++;
		},
		getScenario: async () => fixture.scenario,
		getPreview: async () => fixture.preview,
		getDiagram: async () => fixture.diagram,
	};
	configureReviewServices({ agent: adapter });
	return {
		finish: () => resolve(),
		observer: () => {
			assert.ok(observer);
			return observer;
		},
		input: () => {
			assert.ok(input);
			return input;
		},
		cancelled: () => cancelled,
	};
}

it("ignores late text and actions after cancellation and calls main cancellation", async () => {
	const h = harness();
	const running = runAgentQuestion("What is this for?");
	await Promise.resolve();
	await Promise.resolve();
	h.observer().text("First part");
	await cancelActiveQuestion();
	h.observer().text("LATE");
	const request = h.input();
	const action: AgentAction = {
		sessionId: request.sessionId,
		turnId: request.turnId,
		generation: request.generation,
		requestId: "late-action",
		screenSequence: request.screenContext.sequence,
		kind: "show-preview",
		previewId: fixture.preview.id,
	};
	await h.observer().action(action);
	assert.equal(useConversation.getState().answer, "First part");
	assert.equal(useConversation.getState().state, "cancelled");
	assert.equal(h.cancelled(), 1);
	h.finish();
	await running;
});

it("rejects an effect for a screen left during the turn", async () => {
	useReview.getState().openFile("pricing/applyDiscounts.ts");
	useReview.getState().setPanel("conversation");
	const h = harness();
	const running = runAgentQuestion("Show the scenario");
	await Promise.resolve();
	await Promise.resolve();
	const request = h.input();
	useReview.getState().openFile("checkout/PromoField.tsx");
	const location = fixture.scenario.after.steps[3]?.location;
	assert.ok(location);
	await h.observer().action({
		sessionId: request.sessionId,
		turnId: request.turnId,
		generation: request.generation,
		requestId: "outdated",
		screenSequence: request.screenContext.sequence,
		kind: "highlight-code",
		location: location,
		note: "Old screen",
	});
	assert.equal(useReview.getState().file, "checkout/PromoField.tsx");
	h.finish();
	await running;
});

it("never lets a delayed cancellation acknowledgement launch an older question", async () => {
	let releaseCancel = () => {};
	const started: string[] = [];
	const finished: Array<() => void> = [];
	configureReviewServices({
		agent: {
			ask: async (input) => {
				started.push(input.text);
				await new Promise<void>((resolve) => finished.push(resolve));
			},
			cancel: () =>
				new Promise<void>((resolve) => {
					releaseCancel = resolve;
				}),
			getScenario: async () => fixture.scenario,
			getPreview: async () => fixture.preview,
			getDiagram: async () => fixture.diagram,
		},
	});
	const a = runAgentQuestion("A");
	await Promise.resolve();
	await Promise.resolve();
	const b = runAgentQuestion("B");
	await Promise.resolve();
	const c = runAgentQuestion("C");
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(started, ["A", "C"]);
	releaseCancel();
	await b;
	assert.deepEqual(started, ["A", "C"]);
	assert.equal(useConversation.getState().question, "C");
	for (const done of finished) done();
	await Promise.all([a, c]);
});

it("rejects a diagram whose nodes belong to a stale revision", async () => {
	useReview.setState({ panel: "conversation", diagram: null });
	const h = harness();
	const stale = structuredClone(fixture.diagram);
	for (const node of stale.nodes) node.location.commitSha = "3".repeat(40);
	const { useServices } = await import("./services");
	const adapter = useServices.getState().agent;
	assert.ok(adapter);
	adapter.getDiagram = async () => stale;
	const running = runAgentQuestion("Show callers");
	await Promise.resolve();
	await Promise.resolve();
	const request = h.input();
	await h.observer().action({
		sessionId: request.sessionId,
		turnId: request.turnId,
		generation: request.generation,
		requestId: "stale-diagram",
		screenSequence: request.screenContext.sequence,
		kind: "show-diagram",
		diagramId: stale.id,
	});
	assert.equal(useReview.getState().panel, "conversation");
	assert.equal(useReview.getState().diagram, null);
	h.finish();
	await running;
});

it("accepts a preview pinned to this PR's base revision", async () => {
	const h = harness();
	const preview = structuredClone(fixture.preview);
	preview.revision = "base";
	preview.commitSha = fixture.preparation.pr.baseSha;
	for (const marker of preview.markers) {
		marker.location.revision = "base";
		marker.location.commitSha = preview.commitSha;
	}
	const { useServices } = await import("./services");
	const adapter = useServices.getState().agent;
	assert.ok(adapter);
	adapter.getPreview = async () => preview;
	const running = runAgentQuestion("Show before this PR");
	await Promise.resolve();
	await Promise.resolve();
	const request = h.input();
	await h.observer().action({
		sessionId: request.sessionId,
		turnId: request.turnId,
		generation: request.generation,
		requestId: "base-preview",
		screenSequence: request.screenContext.sequence,
		kind: "show-preview",
		previewId: preview.id,
	});
	assert.equal(useReview.getState().preview?.revision, "base");
	assert.equal(useReview.getState().panel, "preview");
	h.finish();
	await running;
});

it("does not adopt a new screen after an asynchronous source highlight was superseded", async () => {
	const h = harness();
	const resolveReads: Array<() => void> = [];
	configureReviewServices({
		sources: {
			read: (input) =>
				new Promise((resolve) =>
					resolveReads.push(() =>
						resolve({
							...input,
							repository: fixture.preparation.pr.repository,
							commitSha:
								input.revision === "base"
									? fixture.preparation.pr.baseSha
									: fixture.preparation.pr.headSha,
							content: "caller();",
						})
					)
				),
		},
	});
	const running = runAgentQuestion("Explain the caller");
	await Promise.resolve();
	await Promise.resolve();
	const request = h.input();
	const location = fixture.scenario.after.steps[3]?.location;
	assert.ok(location);
	const identity = {
		sessionId: request.sessionId,
		turnId: request.turnId,
		generation: request.generation,
		screenSequence: request.screenContext.sequence,
	};
	const pending = h.observer().action({
		...identity,
		requestId: "async-source",
		kind: "highlight-code",
		location: { ...location, path: "jobs/otherCaller.ts", startLine: 1, endLine: 1 },
		note: "Caller",
	});
	useReview.getState().openFile("checkout/PromoField.tsx");
	for (const resolve of resolveReads) resolve();
	await pending;
	await h.observer().action({
		...identity,
		requestId: "following-stale-effect",
		kind: "highlight-code",
		location,
		note: "Previous screen",
	});
	assert.equal(useReview.getState().file, "checkout/PromoField.tsx");
	h.finish();
	await running;
});

it("voice transcript, text and actions share the UI session without starting a second turn", async () => {
	const { allocateReviewTurn, externalVoiceTurn, reviewSessionId } = await import("./conversation");
	const h = harness();
	const identity = allocateReviewTurn();
	assert.equal(identity.sessionId, reviewSessionId);
	assert.equal(externalVoiceTurn.begin(identity), true);
	externalVoiceTurn.transcript(identity, "Show the scenario");
	externalVoiceTurn.replaceText(identity, "Here is the trace.");
	assert.throws(() => h.input()); // ask() has never run.
	await externalVoiceTurn.action({
		...identity,
		requestId: "voice-scenario",
		screenSequence: 0,
		kind: "show-scenario",
		scenarioId: fixture.scenario.id,
	});
	assert.equal(useReview.getState().panel, "scenario");
	assert.equal(useConversation.getState().question, "Show the scenario");
	externalVoiceTurn.finish(identity, "complete");
	externalVoiceTurn.replaceText(identity, "late voice response");
	assert.equal(useConversation.getState().answer, "Here is the trace.");
	assert.equal(useConversation.getState().state, "complete");
});

it("retiring a voice generation rejects old transcripts and actions", async () => {
	const { allocateReviewTurn, externalVoiceTurn } = await import("./conversation");
	harness();
	const first = allocateReviewTurn();
	externalVoiceTurn.begin(first);
	await cancelActiveQuestion("push-to-talk");
	const second = allocateReviewTurn();
	externalVoiceTurn.begin(second);
	externalVoiceTurn.transcript(second, "Current question");
	externalVoiceTurn.transcript(first, "Old question");
	await externalVoiceTurn.action({
		...first,
		requestId: "old-voice-effect",
		screenSequence: 0,
		kind: "show-scenario",
		scenarioId: fixture.scenario.id,
	});
	assert.equal(useConversation.getState().question, "Current question");
	assert.equal(useReview.getState().panel, null);
});
