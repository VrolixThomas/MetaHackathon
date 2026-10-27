import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	BrowserCommand,
	BrowserState,
	ScenarioTrace,
	ScreenContext,
} from "../../shared/contracts";
import { type AgentBrowserPort, dispatchBrowserTool, observeBrowser } from "./browser";
import type { AgentModelClient, MetaItem, MetaRequest } from "./meta-client";
import { AgentService } from "./service";
import { call, completed, eventually, testContext } from "./test-support";
import { REVIEW_INSTRUCTIONS, selectAgentTools } from "./tool-loop";

// These are protocol test doubles, not a browser run or production fallback. The DTO's
// live-browser discriminator is fabricated ONLY here to exercise the runtime boundary.
function browserDouble(ctx: ReturnType<typeof testContext>) {
	const pr = ctx.fixture.preparation.pr;
	let state: BrowserState | null = null;
	const commands: BrowserCommand[] = [];
	const operations: string[] = [];
	const create = (revision: "head" | "base"): BrowserState => ({
		browserId: `test-browser-${revision}`,
		sessionId: ctx.fixture.agentTurn.sessionId,
		prId: pr.id,
		repository: pr.repository,
		commitSha: revision === "head" ? pr.headSha : pr.baseSha,
		revision,
		url: "http://127.0.0.1:43210/checkout",
		title: "TEST DOUBLE checkout",
		viewport: state?.viewport ?? { width: 1024, height: 768 },
		sequence: 1,
		observedAt: "2026-10-27T00:00:00Z",
		text: "TEST DOUBLE checkout: promo not applied",
		elements: [
			{
				id: "promo",
				role: "textbox",
				name: "Promo code",
				tag: "input",
				value: "",
				bounds: { x: 0, y: 100, width: 120, height: 30 },
				visible: true,
				enabled: true,
			},
			{
				id: "apply",
				role: "button",
				name: "Apply promo",
				tag: "button",
				bounds: { x: 130, y: 100, width: 60, height: 30 },
				visible: true,
				enabled: true,
			},
			{
				id: "pay",
				role: "button",
				name: "Payment",
				tag: "button",
				bounds: { x: 0, y: 1600, width: 120, height: 30 },
				visible: false,
				enabled: true,
			},
		],
		scroll: { x: 0, y: 0 },
		provenance: "live-browser",
	});
	const port: AgentBrowserPort = {
		observe: async (sessionId, signal) => {
			signal.throwIfAborted();
			assert.equal(sessionId, ctx.fixture.agentTurn.sessionId);
			operations.push("observe");
			return structuredClone(state);
		},
		execute: async (command, signal) => {
			signal.throwIfAborted();
			operations.push(command.kind);
			commands.push(structuredClone(command));
			assert.equal(command.sessionId, ctx.fixture.agentTurn.sessionId);
			if (command.kind === "open") state = create(command.revision);
			else {
				assert(state);
				assert.equal(command.browserId, state.browserId);
				if ("observationSequence" in command)
					assert.equal(command.observationSequence, state.sequence);
				if (command.kind === "type") {
					const element = state.elements.find((e) => e.id === command.elementId);
					assert(element);
					element.value = command.text;
				} else if (command.kind === "click") {
					assert.equal(command.elementId, "apply", "Never click the payment button to show it");
					state.text = `TEST DOUBLE ${state.revision}: promo submitted`;
				} else if (command.kind === "viewport") state.viewport = command.viewport;
				else if (command.kind === "scroll") {
					state.scroll.y = 1500;
					const pay = state.elements.find((e) => e.id === "pay");
					assert(pay);
					pay.visible = true;
					pay.bounds.y = 100;
				} else if (command.kind === "navigate") state.url = command.url;
				state.sequence++;
			}
			return structuredClone(state);
		},
	};
	return {
		port,
		commands,
		operations,
		get state() {
			return state;
		},
		set state(value) {
			state = value;
		},
		create,
	};
}

function currentScreen(request: MetaRequest): ScreenContext {
	for (const item of [...request.input].reverse()) {
		if (item["role"] !== "user") continue;
		const content = item["content"] as { text: string }[];
		const parsed = JSON.parse(content[0]?.text ?? "{}");
		if (parsed.currentScreenContext) return parsed.currentScreenContext;
	}
	throw new Error("Missing current screen in model request");
}
function script(choose: (request: MetaRequest) => MetaItem[]): AgentModelClient {
	return {
		async *stream(request, signal) {
			signal.throwIfAborted();
			yield {
				type: "completed",
				response: {
					id: "scripted-test-response",
					model: "muse-spark-1.3",
					output: choose(structuredClone(request)),
				},
			};
		},
	};
}
function identity(turn: ReturnType<AgentService["start"]>) {
	return { sessionId: turn.sessionId, turnId: turn.turnId, generation: turn.generation };
}
async function finish(service: AgentService, turn: ReturnType<AgentService["start"]>) {
	await eventually(() => service.poll(identity(turn)).status !== "running");
	const result = service.poll(identity(turn));
	assert.equal(result.status, "completed");
	return result;
}

test("capability selection exposes browser and trusted execution only when injected", () => {
	const ctx = testContext([]);
	assert(
		!selectAgentTools(ctx.ports).some(
			(tool) => tool.name.startsWith("browser_") || tool.name === "run_scenario"
		)
	);
	ctx.ports.browser = browserDouble(ctx).port;
	ctx.ports.runScenario = async () => ctx.fixture.scenario;
	assert.equal(
		selectAgentTools(ctx.ports).filter((tool) => tool.name.startsWith("browser_")).length,
		7
	);
	assert(selectAgentTools(ctx.ports).some((tool) => tool.name === "run_scenario"));
	assert(REVIEW_INSTRUCTIONS.includes("sourceContext"));
	assert(REVIEW_INSTRUCTIONS.includes("scrolling does not authorize paying"));
});

test("scripted seven-request conversation consumes fresh browser observations and pinned code", async () => {
	const ctx = testContext([]);
	const browser = browserDouble(ctx);
	ctx.ports.browser = browser.port;
	const location = ctx.fixture.screenContext.focusedLocation;
	assert(location);
	ctx.fixture.preparation.sourceContext = [
		{ location, text: "// test-only source excerpt", evidence: ctx.fixture.preparation.evidence },
	];
	const requests: MetaRequest[] = [];
	const client = script((request) => {
		requests.push(request);
		const screen = currentScreen(request);
		const page = screen.browser;
		const [step, roundText] = request.requestId.split(":");
		const round = Number(roundText);
		const ref = (elementId: string) => {
			assert(page);
			return { browserId: page.browserId, elementId, observationSequence: page.sequence };
		};
		let tool: MetaItem | undefined;
		if (step === "walk" && round === 0)
			tool = call("highlight_code", { location, note: "Test-only inferred explanation" });
		if (step === "checkout" && round === 0)
			tool = call("browser_open", { revision: "head", path: "/checkout" });
		if (step === "promo") {
			if (round === 0) tool = call("browser_type", { ...ref("promo"), text: "SAVE10" });
			if (round === 1) {
				assert.equal(page?.elements[0]?.value, "SAVE10");
				tool = call("browser_click", ref("apply"), "apply-new-reference");
			}
		}
		if (step === "phone" && round === 0)
			tool = call("browser_viewport", {
				browserId: page?.browserId,
				viewport: { width: 390, height: 844 },
			});
		if (step === "scroll" && round === 0) tool = call("browser_scroll", ref("pay"));
		if (step === "code" && round === 0) {
			assert.equal(page?.elements[2]?.visible, true);
			tool = call("highlight_code", { location, note: "Test-only source-grounded inference" });
		}
		if (step === "before") {
			if (round === 0) tool = call("browser_open", { revision: "base", path: "/checkout" });
			if (round === 1) {
				assert.equal(page?.revision, "base");
				assert.equal(page?.browserId, "test-browser-base");
				tool = call("browser_type", { ...ref("promo"), text: "SAVE10" }, "base-promo");
			}
			if (round === 2) tool = call("browser_click", ref("apply"), "base-apply");
		}
		return tool ? [tool] : [];
	});
	const service = new AgentService(client, ctx.ports);
	try {
		const steps = ["walk", "checkout", "promo", "phone", "scroll", "code", "before"];
		const effects = [];
		for (const [index, step] of steps.entries()) {
			const turn = service.start({
				...ctx.fixture.agentTurn,
				requestId: step,
				turnId: step,
				generation: index + 1,
				text: `SCRIPTED TEST: ${step}`,
			});
			effects.push(...(await finish(service, turn)).actions);
		}
		assert.deepEqual(
			browser.commands.map((c) => c.kind),
			["open", "type", "click", "viewport", "scroll", "open", "type", "click"]
		);
		assert.equal(new Set(browser.commands.map((c) => c.requestId)).size, 8);
		assert.equal(effects.filter((a) => a.kind === "show-browser").length, 8);
		assert.equal(effects.filter((a) => a.kind === "highlight-code").length, 2);
		assert.equal(new Set(effects.map((a) => a.requestId)).size, effects.length);
		assert.equal(browser.state?.revision, "base");
		assert.equal(browser.state?.text, "TEST DOUBLE base: promo submitted");
		assert.deepEqual(browser.state?.viewport, { width: 390, height: 844 });
		for (const [index, op] of browser.operations.entries()) {
			if (op !== "observe") assert.equal(browser.operations[index + 1], "observe");
		}
		for (const request of requests)
			assert(JSON.stringify(request.input[0]).includes("test-only source excerpt"));
		assert.equal(ctx.postCount(), 0);
	} finally {
		await service.dispose();
	}
});

test("runtime observation replaces stale renderer browser and removes a closed page", async () => {
	const ctx = testContext([]);
	const browser = browserDouble(ctx);
	ctx.ports.browser = browser.port;
	ctx.fixture.screenContext.browser = browser.create("head");
	const service = new AgentService(
		script((request) => {
			assert.equal(currentScreen(request).browser, undefined);
			return [];
		}),
		ctx.ports
	);
	try {
		await finish(service, service.start(ctx.fixture.agentTurn));
	} finally {
		await service.dispose();
	}
});

test("a page changed after inference rejects stale element refs before runtime mutation", async () => {
	const ctx = testContext([]);
	const browser = browserDouble(ctx);
	browser.state = browser.create("head");
	ctx.ports.browser = browser.port;
	let attempts = 0;
	const service = new AgentService(
		script((request) => {
			if (attempts++ > 0) {
				assert(JSON.stringify(request.input).includes("Tool request failed"));
				assert.equal(currentScreen(request).browser?.sequence, 2);
				return [];
			}
			const page = currentScreen(request).browser;
			assert(page && browser.state);
			browser.state.sequence++;
			return [
				call("browser_click", {
					browserId: page.browserId,
					elementId: "apply",
					observationSequence: page.sequence,
				}),
			];
		}),
		ctx.ports
	);
	try {
		assert.equal((await finish(service, service.start(ctx.fixture.agentTurn))).actions.length, 0);
		assert.equal(browser.commands.length, 0);
	} finally {
		await service.dispose();
	}
});

test("browser boundary rejects wrong session/PR/commit and stale or switched post-action observations", async () => {
	const ctx = testContext([]);
	const browser = browserDouble(ctx);
	const state = browser.create("head");
	const signal = new AbortController().signal;
	for (const patch of [
		{ sessionId: "other" },
		{ prId: "other" },
		{ repository: "other" },
		{ commitSha: "f".repeat(40) },
	]) {
		browser.state = { ...state, ...patch };
		await assert.rejects(
			observeBrowser(browser.port, state.sessionId, ctx.fixture.preparation, signal)
		);
	}
	for (const patch of [
		{ browserId: "other" },
		{ sequence: 0 },
		{ revision: "base" as const, commitSha: ctx.fixture.preparation.pr.baseSha },
	]) {
		const port: AgentBrowserPort = {
			execute: async () => state,
			observe: async () => ({ ...state, ...patch }),
		};
		await assert.rejects(
			dispatchBrowserTool("browser_open", { revision: "head" }, port, {
				turn: ctx.fixture.agentTurn,
				prep: ctx.fixture.preparation,
				browser: undefined,
				requestId: "test-request",
				signal,
			})
		);
	}
});

test("browser mutation cancellation propagates signal and discards late results and effects", async () => {
	const ctx = testContext([
		[completed([call("browser_open", { revision: "head" })])],
		[completed()],
	]);
	const browser = browserDouble(ctx);
	let resolve: ((state: BrowserState) => void) | undefined;
	let activeSignal: AbortSignal | undefined;
	browser.port.execute = (_command, signal) => {
		activeSignal = signal;
		return new Promise((done) => {
			resolve = done;
		});
	};
	ctx.ports.browser = browser.port;
	const service = new AgentService(ctx.client, ctx.ports);
	try {
		const first = service.start(ctx.fixture.agentTurn);
		await eventually(() => resolve !== undefined);
		assert.equal(service.cancel(ctx.fixture.cancellation).status, "cancelled");
		assert.equal(activeSignal?.aborted, true);
		assert.deepEqual(service.poll(identity(first)).actions, []);
		const second = service.start({
			...ctx.fixture.agentTurn,
			requestId: "next",
			turnId: "next",
			generation: 2,
		});
		resolve?.(browser.create("head"));
		assert.deepEqual((await finish(service, second)).actions, []);
		assert.equal(service.poll(identity(first)).status, "stale");
	} finally {
		await service.dispose();
	}
});

test("navigation during browser execution suppresses presentation while retaining actual observation", async () => {
	const ctx = testContext([
		[completed([call("browser_open", { revision: "head" })])],
		[completed()],
	]);
	const browser = browserDouble(ctx);
	const execute = browser.port.execute;
	browser.port.execute = async (...args) => {
		const result = await execute(...args);
		ctx.fixture.screenContext.sequence++;
		return result;
	};
	ctx.ports.browser = browser.port;
	const service = new AgentService(ctx.client, ctx.ports);
	try {
		assert.deepEqual((await finish(service, service.start(ctx.fixture.agentTurn))).actions, []);
		const history = JSON.stringify(ctx.requests[1]);
		assert(history.includes("screen-changed"));
		assert(history.includes("TEST DOUBLE checkout"));
	} finally {
		await service.dispose();
	}
});

test("browser tools reject manufactured identity, invisible clicks and cross-origin navigation", async () => {
	const ctx = testContext([]);
	const browser = browserDouble(ctx);
	const state = browser.create("head");
	browser.state = state;
	const context = {
		turn: ctx.fixture.agentTurn,
		prep: ctx.fixture.preparation,
		browser: state,
		requestId: "test",
		signal: new AbortController().signal,
	};
	await assert.rejects(
		dispatchBrowserTool(
			"browser_open",
			{ revision: "head", sessionId: "forged" },
			browser.port,
			context
		)
	);
	await assert.rejects(
		dispatchBrowserTool(
			"browser_click",
			{ browserId: state.browserId, elementId: "pay", observationSequence: 1 },
			browser.port,
			context
		)
	);
	await assert.rejects(
		dispatchBrowserTool(
			"browser_navigate",
			{ browserId: state.browserId, url: "https://example.com" },
			browser.port,
			context
		)
	);
	assert.equal(browser.commands.length, 0);
});

test("trusted scenario tool requires actual execution on both revisions; never upgrades fixtures", async () => {
	for (const mode of ["fixture", "execution", "wrong-commit", "invalid-success"] as const) {
		const ctx = testContext([[completed([call("run_scenario", {})])], [completed()]]);
		const trace: ScenarioTrace = structuredClone(ctx.fixture.scenario);
		if (mode !== "fixture") {
			for (const run of [trace.before, trace.after])
				run.evidence = {
					kind: "execution",
					runId: `test-double-${run.revision}`,
					commitSha: run.commitSha,
					command: ["test-double"],
					startedAt: "2026-10-27T00:00:00Z",
					completedAt: "2026-10-27T00:00:01Z",
					exitCode: 0,
					logUrl: "file:///test-only.log",
				};
		}
		if (mode === "wrong-commit") trace.after.commitSha = "e".repeat(40);
		if (mode === "invalid-success" && trace.after.evidence.kind === "execution") {
			trace.after.status = "completed";
			trace.after.evidence.exitCode = 1;
		}
		ctx.ports.runScenario = async (prId) => {
			assert.equal(prId, ctx.fixture.preparation.pr.id);
			return trace;
		};
		const service = new AgentService(ctx.client, ctx.ports);
		try {
			const result = await finish(service, service.start(ctx.fixture.agentTurn));
			assert.equal(result.actions.length, mode === "execution" ? 1 : 0);
			assert.equal(result.actions[0]?.kind, mode === "execution" ? "show-scenario" : undefined);
		} finally {
			await service.dispose();
		}
	}
});

test("post-action observation, not execute acknowledgement, supplies the model and presentation", async () => {
	const ctx = testContext([
		[completed([call("browser_open", { revision: "head" })])],
		[completed()],
	]);
	const browser = browserDouble(ctx);
	const execute = browser.port.execute;
	browser.port.execute = async (...args) => {
		const acknowledgement = await execute(...args);
		assert(browser.state);
		browser.state.text = "TEST DOUBLE: changed after execute acknowledgement";
		browser.state.sequence++;
		return acknowledgement;
	};
	ctx.ports.browser = browser.port;
	const service = new AgentService(ctx.client, ctx.ports);
	try {
		const result = await finish(service, service.start(ctx.fixture.agentTurn));
		const action = result.actions[0];
		assert(action?.kind === "show-browser");
		assert.equal(action.browser.text, "TEST DOUBLE: changed after execute acknowledgement");
		assert.equal(action.browser.sequence, 2);
		assert(JSON.stringify(ctx.requests[1]).includes("changed after execute acknowledgement"));
	} finally {
		await service.dispose();
	}
});

test("cancellation while observing after mutation emits no stale browser action", async () => {
	const ctx = testContext([[completed([call("browser_open", { revision: "head" })])]]);
	const browser = browserDouble(ctx);
	const observe = browser.port.observe;
	let resolve: ((state: BrowserState) => void) | undefined;
	let observeSignal: AbortSignal | undefined;
	browser.port.observe = (sessionId, signal) => {
		if (browser.commands.length === 0) return observe(sessionId, signal);
		observeSignal = signal;
		return new Promise((done) => {
			resolve = done;
		});
	};
	ctx.ports.browser = browser.port;
	const service = new AgentService(ctx.client, ctx.ports);
	try {
		const turn = service.start(ctx.fixture.agentTurn);
		await eventually(() => resolve !== undefined);
		service.cancel(ctx.fixture.cancellation);
		assert.equal(observeSignal?.aborted, true);
		resolve?.(browser.create("head"));
		await service.dispose();
		assert.equal(service.poll(identity(turn)).status, "stale");
		assert.equal(ctx.requests.length, 1);
	} finally {
		await service.dispose();
	}
});

test("browser tools without a runtime port fail without simulated state or effects", async () => {
	const ctx = testContext([
		[completed([call("browser_open", { revision: "head" })])],
		[completed()],
	]);
	const service = new AgentService(ctx.client, ctx.ports);
	try {
		const result = await finish(service, service.start(ctx.fixture.agentTurn));
		assert.deepEqual(result.actions, []);
		assert(JSON.stringify(ctx.requests[1]).includes("Tool request failed"));
		assert(!JSON.stringify(ctx.requests[1]).includes('"provenance":"live-browser"'));
	} finally {
		await service.dispose();
	}
});

test("an adapter cannot mutate command expectations to substitute another revision", async () => {
	const ctx = testContext([]);
	const browser = browserDouble(ctx);
	const head = browser.create("head");
	const base = browser.create("base");
	const port: AgentBrowserPort = {
		execute: async (command) => {
			if (command.kind === "open") command.revision = "base";
			return base;
		},
		observe: async () => base,
	};
	await assert.rejects(
		dispatchBrowserTool("browser_open", { revision: "head" }, port, {
			turn: ctx.fixture.agentTurn,
			prep: ctx.fixture.preparation,
			browser: head,
			requestId: "test",
			signal: new AbortController().signal,
		})
	);
});
