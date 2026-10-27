import assert from "node:assert/strict";
import { it } from "node:test";
import superjson from "superjson";
import type { VoiceEvent } from "../../main/voice/protocol";
import {
	type AgentActionReceipt,
	AgentActionReceiptSchema,
	type AgentTurnInput,
	AgentTurnInputSchema,
	type BrowserState,
	TurnIdentitySchema,
} from "../../shared/contracts";
import { getReviewFixture } from "../../shared/fixtures/review";
import { type ReviewRequest, createCompositionBridge } from "./composition-bridge";
import { useReview } from "./controller";
import {
	cancelActiveQuestion,
	reviewSessionId,
	runAgentQuestion,
	useConversation,
} from "./conversation";
import { configureReviewServices, useServices } from "./services";
import { connectReviewVoice, useVoiceReadiness } from "./voice-binding";

async function until(predicate: () => boolean) {
	const deadline = Date.now() + 2000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, "Timed out");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
it("binds one voice start, transcript, answer and browser effect to the same typed review session", async () => {
	const fixture = getReviewFixture();
	useReview.setState({
		sourceMode: "repository",
		preparation: fixture.preparation,
		panel: "browser",
		browser: null,
		sequence: 0,
	});
	const starts: AgentTurnInput[] = [];
	const receipts: AgentActionReceipt[] = [];
	const events: VoiceEvent[] = [];
	let closed = 0;
	let requestCount = 0;
	const cancelled = { voice: 0, agent: 0 };
	const request: ReviewRequest = async (rpc) => {
		requestCount++;
		const input = superjson.deserialize<Record<string, unknown>>(rpc.input);
		let value: unknown;
		if (rpc.path === "voice.status")
			value = { phase: "ready", voiceId: "public-voice", missing: [] };
		if (rpc.path === "voice.offer") value = { type: "answer", sdp: "test-answer" };
		if (rpc.path === "voice.release") {
			const identity = TurnIdentitySchema.parse(input);
			events.push({
				...identity,
				kind: "transcript",
				text: "Show checkout",
				final: true,
				sequence: events.length + 1,
			});
			events.push({
				...identity,
				kind: "transcript",
				text: "Show checkout",
				final: true,
				sequence: events.length + 1,
			});
		}
		if (rpc.path === "voice.poll")
			value = { events: events.filter((event) => event.sequence > Number(input["afterSequence"])) };
		if (rpc.path === "voice.speak") {
			const identity = {
				sessionId: String(input["sessionId"]),
				turnId: String(input["turnId"]),
				generation: Number(input["generation"]),
			};
			events.push({
				...identity,
				kind: "speech-ended",
				speechId: String(input["speechId"]),
				sequence: events.length + 1,
			});
		}
		if (rpc.path === "screen.update") value = input["screenContext"];
		if (rpc.path === "agent.actionApplied") {
			receipts.push(AgentActionReceiptSchema.parse(input));
			value = { status: "accepted" };
		}
		if (rpc.path === "agent.start") {
			const start = AgentTurnInputSchema.parse(input);
			starts.push(start);
			value = {
				sessionId: start.sessionId,
				turnId: start.turnId,
				generation: start.generation,
				status: "running",
			};
		}
		if (rpc.path === "agent.poll") {
			const start = starts.at(-1);
			assert.ok(start);
			const identity = {
				sessionId: start.sessionId,
				turnId: start.turnId,
				generation: start.generation,
			};
			const browser: BrowserState = {
				browserId: "one-visible-page",
				sessionId: start.sessionId,
				prId: fixture.preparation.pr.id,
				repository: fixture.preparation.pr.repository,
				revision: "head",
				commitSha: fixture.preparation.pr.headSha,
				url: "http://127.0.0.1:1234/",
				title: "Checkout",
				viewport: { width: 1024, height: 768 },
				sequence: starts.length,
				observedAt: "2026-10-27T19:00:00Z",
				text: "Checkout",
				elements: [],
				scroll: { x: 0, y: 0 },
				provenance: "live-browser",
			};
			const action = {
				...identity,
				requestId: `show-${starts.length}`,
				screenSequence: start.screenContext.sequence,
				kind: "show-browser",
				browser,
			};
			const ignored = {
				...action,
				requestId: "filtered-voice-browser",
				screenSequence: Math.max(0, start.screenContext.sequence - 1),
			};
			value = {
				...identity,
				status: "completed",
				sequence: starts.length === 1 ? 4 : 3,
				text: "Checkout is open.",
				actions: starts.length === 1 ? [action, ignored] : [action],
				events: [
					{ ...identity, sequence: 1, kind: "text-delta", delta: "Checkout is open." },
					{ ...identity, sequence: 2, kind: "action", action },
					...(starts.length === 1
						? [{ ...identity, sequence: 3, kind: "action", action: ignored }]
						: []),
					{ ...identity, sequence: starts.length === 1 ? 4 : 3, kind: "completed" },
				],
			};
		}
		if (rpc.path === "voice.cancel") cancelled.voice++;
		if (rpc.path === "agent.cancel") {
			cancelled.agent++;
			value = {
				sessionId: input["sessionId"],
				turnId: input["turnId"],
				generation: input["generation"],
				requestId: input["requestId"],
				status: "cancelled",
			};
		}
		return { result: { data: superjson.serialize(value) } };
	};
	configureReviewServices(createCompositionBridge(request));
	const disconnect = connectReviewVoice(request, () => ({
		connect: async (offer) => {
			await offer({ type: "offer", sdp: "test-offer" });
		},
		stopCapture() {},
		drain: async () => {},
		close: () => {
			closed++;
		},
	}));
	try {
		await until(() => useVoiceReadiness.getState().status?.phase === "ready");
		const voice = useServices.getState().voice;
		assert.ok(voice);
		voice.beginCapture();
		await until(() => voice.getPhase() === "listening");
		voice.endCapture();
		await until(() => useConversation.getState().state === "complete");
		assert.equal(starts.length, 1);
		assert.equal(starts[0]?.sessionId, reviewSessionId);
		assert.equal(useConversation.getState().question, "Show checkout");
		assert.equal(useConversation.getState().answer, "Checkout is open.");
		assert.equal(useReview.getState().browser?.browserId, "one-visible-page");
		assert.ok(closed > 0);
		assert.deepEqual(
			receipts.map((receipt) => receipt.status),
			["applied", "ignored"]
		);
		assert.equal(receipts[1]?.requestId, "filtered-voice-browser");
		assert.ok(
			Number(receipts[1]?.screenContext.sequence) > Number(receipts[0]?.screenContext.sequence)
		);
		await runAgentQuestion("Now compare the PR");
		assert.equal(starts.length, 2);
		assert.equal(starts[1]?.sessionId, starts[0]?.sessionId);
		assert.ok(Number(starts[1]?.generation) > Number(starts[0]?.generation));
		assert.equal(useReview.getState().browser?.sequence, 2);
		assert.equal(receipts.length, 3);
		assert.equal(receipts[2]?.status, "applied");
		assert.equal(receipts[2]?.turnId, starts[1]?.turnId);
		assert.ok(requestCount > 5);
		useReview.getState().announce("");
		voice.beginCapture();
		await until(() => voice.getPhase() === "listening");
		voice.interrupt("escape");
		await until(() => cancelled.voice > 0 && cancelled.agent > 0);
		assert.equal(useConversation.getState().state, "cancelled");
		assert.equal(useReview.getState().status, "");
	} finally {
		disconnect();
		await cancelActiveQuestion();
		configureReviewServices({ agent: null });
	}
});

it("keeps capture disabled after config/key changes despite delayed ready status", async () => {
	let first = true;
	let failStatus = false;
	let resolveStatus: (status: unknown) => void = () => {};
	let mediaOpened = 0;
	const ready = { phase: "ready", voiceId: "public-voice", missing: [] };
	const request: ReviewRequest = async (rpc) => {
		let value: unknown;
		if (rpc.path === "voice.status") {
			if (failStatus) throw new Error("offline");
			value = first
				? await new Promise((resolve) => {
						first = false;
						resolveStatus = resolve;
					})
				: ready;
		} else if (rpc.path === "voice.configure") value = { ...ready, phase: "stopped" };
		else if (rpc.path === "voice.prepare") value = ready;
		return { result: { data: superjson.serialize(value) } };
	};
	const disconnect = connectReviewVoice(request, () => {
		mediaOpened++;
		throw new Error("Capture must remain gated");
	});
	try {
		const { voice, voiceSetup } = useServices.getState();
		assert.ok(voice);
		assert.ok(voiceSetup);
		await voiceSetup.configure("replacement-voice");
		resolveStatus(ready);
		await new Promise((resolve) => setTimeout(resolve, 5));
		await voiceSetup.status();
		voice.beginCapture();
		assert.equal(mediaOpened, 0);
		assert.equal(useVoiceReadiness.getState().status?.phase, "stopped");
		await voiceSetup.prepare();
		assert.equal(useVoiceReadiness.getState().status?.phase, "ready");
		const { createRuntimeBridge } = await import("./runtime-bridge");
		await createRuntimeBridge(request).settings.set("meta", "synthetic-test-key");
		await voiceSetup.status();
		voice.beginCapture();
		assert.equal(mediaOpened, 0);
		assert.equal(useVoiceReadiness.getState().status?.phase, "stopped");
		await voiceSetup.prepare();
		failStatus = true;
		await assert.rejects(() => voiceSetup.status());
		assert.equal(useVoiceReadiness.getState().status, null);
	} finally {
		disconnect();
	}
});
