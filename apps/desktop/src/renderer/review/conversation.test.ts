import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import type {
	AgentAction,
	AgentActionReceipt,
	AgentTurnInput,
	BrowserState,
	ScreenContext,
} from "../../shared/contracts";
import { getReviewFixture } from "../../shared/fixtures/review";
import { refreshReviewBrowser } from "./browser-session";
import { useReview } from "./controller";
import {
	cancelActiveQuestion,
	reviewSessionId,
	runAgentQuestion,
	useConversation,
} from "./conversation";
import { type AgentAdapter, configureReviewServices } from "./services";
import { initialFiles } from "./workspace-data";

const fixture = getReviewFixture();
beforeEach(() =>
	useReview.setState({
		preparation: fixture.preparation,
		browser: null,
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
	configureReviewServices({ agent: null, sources: null, browser: null });
});

function harness(overrides: Partial<AgentAdapter> = {}) {
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
		...overrides,
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
		screenSequence: useReview.getState().sequence,
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

it("a new voice capture cannot be interrupted by retiring the old sink", async () => {
	const { allocateReviewTurn, externalVoiceTurn } = await import("./conversation");
	harness();
	let interrupts = 0;
	configureReviewServices({
		voice: {
			beginCapture() {},
			endCapture() {},
			interrupt() {
				interrupts++;
			},
			getPhase: () => "listening",
			subscribe: () => () => {},
		},
	});
	const old = allocateReviewTurn();
	externalVoiceTurn.begin(old);
	const current = allocateReviewTurn();
	externalVoiceTurn.begin(current);
	externalVoiceTurn.finish(old, "cancelled");
	externalVoiceTurn.transcript(current, "Still listening to this capture");
	assert.equal(interrupts, 0);
	assert.equal(useConversation.getState().question, "Still listening to this capture");
	externalVoiceTurn.finish(current, "complete");
	assert.equal(externalVoiceTurn.begin(current), false);
	configureReviewServices({ voice: null });
});

it("cancelling while a source read is pending prevents its eventual code effect", async () => {
	const h = harness();
	const reads: Array<() => void> = [];
	configureReviewServices({
		sources: {
			read: (input) =>
				new Promise((resolve) =>
					reads.push(() =>
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
	const running = runAgentQuestion("Show caller");
	await Promise.resolve();
	await Promise.resolve();
	const input = h.input();
	const pending = h.observer().action({
		sessionId: input.sessionId,
		turnId: input.turnId,
		generation: input.generation,
		requestId: "read-before-cancel",
		screenSequence: input.screenContext.sequence,
		kind: "highlight-code",
		location: {
			repository: fixture.preparation.pr.repository,
			revision: "head",
			commitSha: fixture.preparation.pr.headSha,
			path: "new/caller.ts",
			startLine: 1,
			endLine: 1,
		},
		note: "Caller",
	});
	await cancelActiveQuestion();
	for (const read of reads) read();
	await pending;
	assert.equal(useReview.getState().file, "pricing/applyDiscounts.ts");
	h.finish();
	await running;
});

for (const [timing, actionObservedAt] of [
	["older", "2026-10-27T19:00:01Z"],
	["newer", "2026-10-27T19:00:03Z"],
] as const) {
	it(`a passive browser poll in code view preserves a show-browser action whose observation time is ${timing}`, async () => {
		const browser: BrowserState = {
			browserId: "browser-checkout",
			sessionId: reviewSessionId,
			prId: fixture.preparation.pr.id,
			repository: fixture.preparation.pr.repository,
			revision: "head",
			commitSha: fixture.preparation.pr.headSha,
			url: "http://127.0.0.1:1234/checkout",
			title: "Checkout",
			viewport: { width: 1024, height: 768 },
			sequence: 1,
			observedAt: "2026-10-27T19:00:00Z",
			text: "Apply promo",
			elements: [],
			scroll: { x: 0, y: 0 },
			provenance: "live-browser",
		};
		useReview.setState({ panel: "code", browser });
		const polled = {
			...browser,
			sequence: 2,
			text: "Promo applied",
			observedAt: "2026-10-27T19:00:02Z",
		};
		configureReviewServices({
			browser: {
				observe: async () => polled,
				execute: async () => polled,
				present: async () => {},
			},
		});
		const h = harness();
		const running = runAgentQuestion("Show the checkout again");
		await Promise.resolve();
		await Promise.resolve();
		try {
			const input = h.input();
			await refreshReviewBrowser();
			assert.equal(useReview.getState().panel, "code");
			assert.equal(useReview.getState().sequence, input.screenContext.sequence);
			assert.deepEqual(useReview.getState().browser, polled);
			await h.observer().action({
				sessionId: input.sessionId,
				turnId: input.turnId,
				generation: input.generation,
				requestId: `restore-browser-${timing}`,
				screenSequence: input.screenContext.sequence,
				kind: "show-browser",
				browser: { ...polled, observedAt: actionObservedAt },
			});
			assert.equal(useReview.getState().panel, "browser");
			assert.equal(useReview.getState().sequence, input.screenContext.sequence + 1);
			assert.deepEqual(useReview.getState().browser, {
				...polled,
				observedAt: timing === "older" ? polled.observedAt : actionObservedAt,
			});
		} finally {
			h.finish();
			await running;
		}
	});
}

it("awaits a settled effect and its receipt, deduplicating concurrent delivery before the next effect", async () => {
	const receipts: AgentActionReceipt[] = [];
	const updates: ScreenContext[] = [];
	let releaseDiagram = () => {};
	let releaseReceipt = () => {};
	let reads = 0;
	const ack = new Promise<{ status: "accepted" }>((resolve) => {
		releaseReceipt = () => resolve({ status: "accepted" });
	});
	const h = harness({
		updateScreen: async (_session, screen) => {
			updates.push(screen);
		},
		getDiagram: () => {
			reads++;
			return new Promise((resolve) => {
				releaseDiagram = () => resolve(fixture.diagram);
			});
		},
		actionApplied: async (receipt) => {
			receipts.push(receipt);
			return ack;
		},
	});
	const running = runAgentQuestion("Show callers");
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	const input = h.input();
	const action: AgentAction = {
		sessionId: input.sessionId,
		turnId: input.turnId,
		generation: input.generation,
		requestId: "settled-diagram",
		screenSequence: input.screenContext.sequence,
		kind: "show-diagram",
		diagramId: fixture.diagram.id,
	};
	let finished = false;
	const applying = h
		.observer()
		.action(action)
		.then(() => {
			finished = true;
		});
	const duplicate = h.observer().action(action);
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(reads, 1);
	assert.equal(receipts.length, 0);
	releaseDiagram();
	for (let i = 0; i < 8; i++) await Promise.resolve();
	assert.equal(useReview.getState().panel, "diagram");
	assert.equal(receipts.length, 1);
	const receipt = receipts[0];
	assert.ok(receipt);
	assert.equal(receipt.status, "applied");
	assert.equal(receipt.requestId, action.requestId);
	assert.equal(receipt.screenContext.panel, "diagram");
	assert.equal(receipt.screenContext.sequence, input.screenContext.sequence + 2);
	assert.ok(updates.every((screen) => screen.sequence < receipt.screenContext.sequence));
	assert.equal(finished, false);
	releaseReceipt();
	await Promise.all([applying, duplicate]);
	const node = fixture.diagram.nodes[0];
	assert.ok(node);
	await h.observer().action({
		sessionId: action.sessionId,
		turnId: action.turnId,
		generation: action.generation,
		requestId: "following-highlight",
		screenSequence: receipt.screenContext.sequence,
		kind: "highlight-code",
		location: node.location,
		note: "Call site",
	});
	assert.equal(receipts.length, 2);
	assert.equal(receipts[1]?.status, "applied");
	assert.equal(useReview.getState().panel, "code");
	h.finish();
	await running;
});

it("acknowledges ignored stale and cancelled effects without moving the reviewer", async () => {
	const receipts: AgentActionReceipt[] = [];
	const h = harness({
		actionApplied: async (receipt) => {
			receipts.push(receipt);
			return { status: "stale" };
		},
	});
	const running = runAgentQuestion("Show callers");
	await Promise.resolve();
	await Promise.resolve();
	const input = h.input();
	useReview.getState().openFile("checkout/PromoField.tsx");
	const leftSequence = useReview.getState().sequence;
	const action: AgentAction = {
		sessionId: input.sessionId,
		turnId: input.turnId,
		generation: input.generation,
		requestId: "stale-context-effect",
		screenSequence: input.screenContext.sequence,
		kind: "show-diagram",
		diagramId: fixture.diagram.id,
	};
	await h.observer().action(action);
	assert.equal(receipts[0]?.status, "ignored");
	assert.equal(receipts[0]?.screenContext.sequence, leftSequence + 1);
	assert.equal(useReview.getState().file, "checkout/PromoField.tsx");
	await cancelActiveQuestion();
	await h.observer().action({ ...action, requestId: "cancelled-effect" });
	assert.equal(receipts[1]?.status, "ignored");
	assert.equal(receipts[1]?.generation, input.generation);
	assert.equal(useReview.getState().panel, "code");
	h.finish();
	await running;
});

it("acknowledges an async effect ignored after navigation and a failed highlight truthfully", async () => {
	const receipts: AgentActionReceipt[] = [];
	let releaseDiagram = () => {};
	const h = harness({
		getDiagram: () =>
			new Promise((resolve) => {
				releaseDiagram = () => resolve(fixture.diagram);
			}),
		actionApplied: async (receipt) => {
			receipts.push(receipt);
			return { status: "accepted" };
		},
	});
	const running = runAgentQuestion("Show callers");
	await Promise.resolve();
	await Promise.resolve();
	const input = h.input();
	const action: AgentAction = {
		sessionId: input.sessionId,
		turnId: input.turnId,
		generation: input.generation,
		requestId: "late-diagram",
		screenSequence: input.screenContext.sequence,
		kind: "show-diagram",
		diagramId: fixture.diagram.id,
	};
	const pending = h.observer().action(action);
	await Promise.resolve();
	await Promise.resolve();
	useReview.getState().setPanel("browser");
	releaseDiagram();
	await pending;
	assert.equal(receipts[0]?.status, "ignored");
	assert.equal(useReview.getState().panel, "browser");
	const node = fixture.diagram.nodes[0];
	assert.ok(node);
	await h.observer().action({
		sessionId: action.sessionId,
		turnId: action.turnId,
		generation: action.generation,
		kind: "highlight-code",
		requestId: "missing-source",
		screenSequence: useReview.getState().sequence,
		location: { ...node.location, startLine: 99999, endLine: 99999 },
		note: "Unavailable",
	});
	assert.equal(receipts[1]?.status, "ignored");
	assert.equal(useReview.getState().panel, "browser");
	h.finish();
	await running;
});

it("external ignored voice actions use the same receipt sink without executing the effect", async () => {
	const { allocateReviewTurn, externalVoiceTurn } = await import("./conversation");
	const receipts: AgentActionReceipt[] = [];
	harness({
		actionApplied: async (receipt) => {
			receipts.push(receipt);
			return { status: "accepted" };
		},
	});
	const identity = allocateReviewTurn();
	externalVoiceTurn.begin(identity);
	const sequence = useReview.getState().sequence;
	const action: AgentAction = {
		...identity,
		requestId: "voice-filtered",
		screenSequence: sequence,
		kind: "show-diagram",
		diagramId: fixture.diagram.id,
	};
	assert.equal(await externalVoiceTurn.ignoreAction(action), "ignored");
	assert.equal(receipts[0]?.status, "ignored");
	assert.equal(receipts[0]?.screenContext.sequence, sequence + 1);
	assert.equal(useReview.getState().panel, null);
	assert.equal(await externalVoiceTurn.action(action), "ignored");
	assert.equal(receipts.length, 1);
	externalVoiceTurn.finish(identity, "complete");
});

it("a retired asynchronous effect acknowledges ignored without changing the new turn's screen", async () => {
	const receipts: AgentActionReceipt[] = [];
	let release = () => {};
	const first = harness({
		getDiagram: () =>
			new Promise((resolve) => {
				release = () => resolve(fixture.diagram);
			}),
		actionApplied: async (receipt) => {
			receipts.push(receipt);
			return { status: "stale" };
		},
	});
	const firstRunning = runAgentQuestion("Old question");
	await Promise.resolve();
	await Promise.resolve();
	const old = first.input();
	const effect = first.observer().action({
		sessionId: old.sessionId,
		turnId: old.turnId,
		generation: old.generation,
		requestId: "retired-diagram",
		screenSequence: old.screenContext.sequence,
		kind: "show-diagram",
		diagramId: fixture.diagram.id,
	});
	await Promise.resolve();
	await Promise.resolve();
	await cancelActiveQuestion();
	const second = harness();
	const secondRunning = runAgentQuestion("Current question");
	await Promise.resolve();
	await Promise.resolve();
	const current = second.input();
	const before = useReview.getState();
	release();
	await effect;
	assert.equal(receipts[0]?.status, "ignored");
	assert.equal(receipts[0]?.turnId, old.turnId);
	assert.equal(receipts[0]?.screenContext.sequence, current.screenContext.sequence);
	assert.equal(useReview.getState(), before);
	assert.equal(useConversation.getState().identity?.turnId, current.turnId);
	first.finish();
	second.finish();
	await Promise.all([firstRunning, secondRunning]);
});
