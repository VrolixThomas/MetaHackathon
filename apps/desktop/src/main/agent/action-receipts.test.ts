import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	AgentAction,
	AgentActionReceipt,
	BrowserState,
	ScreenContext,
} from "../../shared/contracts";
import { createAgentRouter } from "./router";
import { ScreenContextStore } from "./screen-context";
import { AgentService } from "./service";
import { call, completed, eventually, testContext } from "./test-support";

function harness(responses: unknown[][], timeoutMs = 1000) {
	const ctx = testContext(responses);
	ctx.fixture.screenContext.sequence = 10;
	ctx.fixture.agentTurn.screenContext.sequence = 10;
	const screens = new ScreenContextStore();
	ctx.ports.getScreenContext = (sessionId, initial) => screens.get(sessionId, initial);
	const committed: AgentActionReceipt[] = [];
	const options = {
		actionReceipts: {
			timeoutMs,
			updateScreen: (receipt: AgentActionReceipt) => {
				screens.update({ sessionId: receipt.sessionId, screenContext: receipt.screenContext });
				committed.push(receipt);
			},
		},
	};
	const service = new AgentService(ctx.client, ctx.ports, options);
	const { sessionId, turnId, generation } = service.start(ctx.fixture.agentTurn);
	const identity = { sessionId, turnId, generation };
	const snapshot = () => service.poll(identity);
	const action = async (index = 0) => {
		await eventually(() => snapshot().actions.length > index);
		const value = snapshot().actions[index];
		assert(value);
		return value;
	};
	const receipt = (
		effect: AgentAction,
		screenContext: ScreenContext = {
			...ctx.fixture.screenContext,
			sequence: effect.screenSequence + 1,
		}
	): AgentActionReceipt => ({
		...identity,
		requestId: effect.requestId,
		status: "applied",
		screenContext,
	});
	return { ...ctx, service, screens, committed, identity, snapshot, action, receipt };
}
function latestScreen(request: Record<string, unknown> | undefined): ScreenContext {
	const items = request?.["input"] as { role?: string; content?: { text: string }[] }[];
	for (const item of [...items].reverse()) {
		if (item.role !== "user") continue;
		const data = JSON.parse(item.content?.[0]?.text ?? "{}");
		if (data.currentScreenContext) return data.currentScreenContext;
	}
	throw new Error("Current screen missing");
}
function browserState(h: ReturnType<typeof harness>): BrowserState {
	const pr = h.fixture.preparation.pr;
	return {
		browserId: "test-only-page",
		sessionId: h.identity.sessionId,
		prId: pr.id,
		repository: pr.repository,
		commitSha: pr.baseSha,
		revision: "base",
		url: "http://127.0.0.1:1234/checkout",
		title: "TEST DOUBLE",
		viewport: { width: 1024, height: 768 },
		sequence: 1,
		observedAt: "2026-10-27T00:00:00Z",
		text: "TEST DOUBLE checkout",
		elements: [],
		scroll: { x: 0, y: 0 },
		provenance: "live-browser",
	};
}

test("receipt barrier orders scenario effects and browser mutation after the final committed screen", async () => {
	const h = harness([
		[completed([call("show_scenario", { scenarioId: "scenario-c", stepId: "head-4" })])],
		[completed([call("browser_open", { revision: "base" }, "open-base")])],
		[completed()],
	]);
	let page: BrowserState | null = null;
	let mutations = 0;
	h.ports.browser = {
		observe: async () => page,
		execute: async () => {
			mutations++;
			assert.equal(h.committed.length, 2);
			page = browserState(h);
			return page;
		},
	};
	const caller = createAgentRouter(h.service, h.ports.drafts).createCaller({});
	try {
		const first = await h.action();
		// Simulate the scenario's intermediate UI writes while source focus is pending.
		h.screens.update({
			sessionId: h.identity.sessionId,
			screenContext: { ...h.fixture.screenContext, sequence: 11, panel: "scenario" },
		});
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(h.requests.length, 1);
		assert.equal(h.snapshot().actions.length, 1);
		assert.equal(mutations, 0);
		assert.deepEqual(
			await caller.actionApplied(
				h.receipt(first, { ...h.fixture.screenContext, sequence: 13, panel: "scenario" })
			),
			{ status: "accepted" }
		);
		const second = await h.action(1);
		assert.equal(second.kind, "highlight-code");
		assert.equal(second.screenSequence, 13);
		assert.equal(h.requests.length, 1);
		h.service.actionApplied(h.receipt(second, { ...h.fixture.screenContext, sequence: 14 }));
		const third = await h.action(2);
		assert.equal(mutations, 1);
		assert.equal(third.kind, "show-browser");
		assert.equal(third.screenSequence, 14);
		assert.equal(h.requests.length, 2);
		h.service.actionApplied(
			h.receipt(third, {
				...h.fixture.screenContext,
				sequence: 15,
				panel: "browser",
				browser: page ?? undefined,
			})
		);
		await eventually(() => h.snapshot().status === "completed");
		assert.equal(h.requests.length, 3);
		assert.equal(h.committed.length, 3);
		assert.equal(latestScreen(h.requests[2]).sequence, 15);
	} finally {
		await h.service.dispose();
	}
});

test("foreign, unknown, regressing and duplicate receipts never update or unlock a pending action", async () => {
	const h = harness([
		[completed([call("show_scenario", { scenarioId: "scenario-c" })])],
		[completed()],
	]);
	try {
		const first = await h.action();
		const receipt = h.receipt(first);
		for (const patch of [
			{ sessionId: "foreign" },
			{ turnId: "foreign" },
			{ generation: 99 },
			{ requestId: "unknown" },
			{ screenContext: { ...receipt.screenContext, prId: "foreign" } },
			{ screenContext: { ...receipt.screenContext, sequence: first.screenSequence - 1 } },
		])
			assert.deepEqual(h.service.actionApplied({ ...receipt, ...patch }), { status: "stale" });
		assert.equal(h.committed.length, 0);
		assert.equal(h.requests.length, 1);
		assert.deepEqual(h.service.actionApplied(receipt), { status: "accepted" });
		assert.deepEqual(h.service.actionApplied(receipt), { status: "stale" });
		await eventually(() => h.snapshot().status === "completed");
		assert.equal(h.committed.length, 1);
	} finally {
		await h.service.dispose();
	}
});

test("ignored receipt commits navigation and skips remaining effects/calls until fresh planning", async () => {
	const h = harness([
		[
			completed([
				call("show_scenario", { scenarioId: "scenario-c", stepId: "head-4" }),
				call("show_preview", { previewId: "preview-phone" }, "skip-preview"),
			]),
		],
		[completed()],
	]);
	try {
		const first = await h.action();
		h.service.actionApplied({
			...h.receipt(first, { ...h.fixture.screenContext, sequence: 20, panel: "diff" }),
			status: "ignored",
		});
		await eventually(() => h.snapshot().status === "completed");
		assert.equal(h.snapshot().actions.length, 1);
		assert.equal(h.requests.length, 2);
		assert.equal(latestScreen(h.requests[1]).sequence, 20);
	} finally {
		await h.service.dispose();
	}
});

test("navigation newer than an acknowledged effect cannot rebase the next effect", async () => {
	const h = harness([
		[completed([call("show_scenario", { scenarioId: "scenario-c", stepId: "head-4" })])],
		[completed()],
	]);
	try {
		const first = await h.action();
		h.service.actionApplied(h.receipt(first));
		// Arrives after acknowledgement, before the waiting loop resumes.
		h.screens.update({
			sessionId: h.identity.sessionId,
			screenContext: { ...h.fixture.screenContext, sequence: 30 },
		});
		await eventually(() => h.snapshot().status === "completed");
		assert.equal(h.snapshot().actions.length, 1);
	} finally {
		await h.service.dispose();
	}
});

test("receipt timeout ends the turn without another model request or mutation", async () => {
	const h = harness([[completed([call("show_scenario", { scenarioId: "scenario-c" })])]], 20);
	try {
		const first = await h.action();
		await eventually(() => h.snapshot().status === "error");
		assert(
			h
				.snapshot()
				.events.some(
					(event) =>
						event.kind === "error" &&
						event.message === "Workspace did not acknowledge the action; retry the review."
				)
		);
		assert.equal(h.requests.length, 1);
		assert.equal(h.committed.length, 0);
		assert.deepEqual(h.service.actionApplied(h.receipt(first)), { status: "stale" });
	} finally {
		await h.service.dispose();
	}
});

test("cancel, replacement generation, release and disposal clear pending receipt barriers", async () => {
	for (const mode of ["cancel", "replace", "release", "dispose"] as const) {
		const h = harness([
			[completed([call("show_scenario", { scenarioId: "scenario-c" })])],
			[completed()],
		]);
		try {
			const first = await h.action();
			if (mode === "cancel") h.service.cancel(h.fixture.cancellation);
			if (mode === "replace")
				h.service.start({
					...h.fixture.agentTurn,
					requestId: "next",
					turnId: "next",
					generation: h.identity.generation + 1,
				});
			if (mode === "release") h.service.releaseSession(h.identity.sessionId);
			if (mode === "dispose") await h.service.dispose();
			assert.deepEqual(h.service.actionApplied(h.receipt(first)), { status: "stale" });
			assert.equal(h.committed.length, 0);
			await h.service.dispose();
		} finally {
			await h.service.dispose();
		}
	}
});

test("screen commit failure ends receipt admission without continuing the model", async () => {
	const h = harness([[completed([call("show_scenario", { scenarioId: "scenario-c" })])]]);
	try {
		const first = await h.action();
		h.screens.update({
			sessionId: h.identity.sessionId,
			screenContext: {
				...h.fixture.screenContext,
				sequence: 11,
				panel: "browser",
				focusedLocation: null,
			},
		});
		assert.throws(() => h.service.actionApplied(h.receipt(first)), /receipt failed/);
		await eventually(() => h.snapshot().status === "error");
		assert.equal(h.requests.length, 1);
		assert.equal(h.committed.length, 0);
		assert.deepEqual(h.service.actionApplied(h.receipt(first)), { status: "stale" });
	} finally {
		await h.service.dispose();
	}
});
