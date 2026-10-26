import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { expiredReminderPlan } from "../../../../../tests/fixtures/agent/scenario-c";
import type { AgentTurnInput, ConfirmCommentInput, SourceFile } from "../../shared/contracts";
import { getReviewFixture } from "../../shared/fixtures/review";
import { generateScenario, requestScenarioExecution } from "../agent/scenarios";
import { ScreenContextStore } from "../agent/screen-context";
import { call, completed, transport } from "../agent/test-support";
import { createRuntimeRouter } from "../runtime/router";
import { type RuntimeOptions, RuntimeService } from "../runtime/service";
import { type AgentCompositionOptions, createAgentComposition } from "./factory";
import { createCompositionRouters } from "./router";

const signal = () => new AbortController().signal;
function identity(input: AgentTurnInput) {
	return { sessionId: input.sessionId, turnId: input.turnId, generation: input.generation };
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function until(predicate: () => boolean) {
	for (let i = 0; i < 500; i++) {
		if (predicate()) return;
		await delay(5);
	}
	throw new Error("Condition did not settle");
}
function runtimeOptions(root: string): RuntimeOptions {
	return {
		userDataPath: root,
		fixturesPath: resolve("fixtures/demo"),
		encryption: {
			isEncryptionAvailable: () => false,
			encryptString: () => {
				throw new Error("No real credentials in tests");
			},
			decryptString: () => {
				throw new Error("No real credentials in tests");
			},
		},
		submissionLedger: { reserve: () => undefined, complete: () => {} },
		createPreviewPage: () => {
			throw new Error("Preview UI is not used by this test");
		},
	};
}

class MockRuntime extends RuntimeService {
	readonly fixture = getReviewFixture();
	pr = this.fixture.preparation.pr;
	reads = 0;
	sourceOverride?: (prId: string, revision: "base" | "head", path: string) => Promise<SourceFile>;
	constructor(root: string) {
		super(runtimeOptions(root));
		this.credentials.get = async (provider) =>
			provider === "meta" ? "injected-test-key" : undefined;
		this.github.readPullRequest = async () => structuredClone(this.pr);
		this.github.postConfirmedComment = async () => {
			throw new Error("Unexpected GitHub write");
		};
	}
	override getPrepared(prId: string) {
		if (prId !== this.pr.id) throw new Error("PR is not prepared");
		return {
			pr: this.pr,
			worktrees: {
				runId: "mock",
				repositoryPath: "/mock/repo",
				base: { path: "/mock/base", sha: this.pr.baseSha },
				head: { path: "/mock/head", sha: this.pr.headSha },
			},
		};
	}
	override async changedFiles() {
		return ["pricing/applyDiscounts.ts"];
	}
	override async source(
		prId: string,
		revision: "base" | "head",
		path: string
	): Promise<SourceFile> {
		this.reads++;
		if (this.sourceOverride) return this.sourceOverride(prId, revision, path);
		return {
			prId,
			repository: this.pr.repository,
			revision,
			path,
			commitSha: revision === "base" ? this.pr.baseSha : this.pr.headSha,
			content: `export function price() { return ${revision === "base" ? 1 : 2}; }\n${"// inspected\n".repeat(100)}`,
		};
	}
}

async function mockHarness(extra: Partial<AgentCompositionOptions> = {}) {
	const root = await mkdtemp(join(tmpdir(), "composition-mock-"));
	const runtime = new MockRuntime(root);
	const screens = new ScreenContextStore();
	const composition = createAgentComposition({
		getRuntime: () => runtime,
		getDataDirectory: () => root,
		screenContexts: screens,
		fetch: async () => {
			throw new Error("Unexpected model request");
		},
		...extra,
	});
	return {
		root,
		runtime,
		screens,
		composition,
		async close() {
			await composition.dispose();
			await runtime.dispose();
			await rm(root, { recursive: true });
		},
	};
}

test("construction is lazy and registration preserves the supplied canonical screen store", async () => {
	const screens = new ScreenContextStore();
	const composition = createAgentComposition({
		screenContexts: screens,
		getRuntime: () => {
			throw new Error("Electron not ready");
		},
		getDataDirectory: () => {
			throw new Error("Electron not ready");
		},
	});
	assert.equal(composition.screenContexts, screens);
	const routers = createCompositionRouters(composition);
	assert.deepEqual(Object.keys(routers).sort(), ["agent", "artifacts", "review"]);
	await composition.dispose();
});

test("scenario and highlight use distinct effects, current screen, and retrievable catalog artifacts", async () => {
	const requests: string[] = [];
	const first = deferred<Response>();
	const fixture = getReviewFixture();
	let attempts = 0;
	const h = await mockHarness({
		fetch: async (_input, init) => {
			requests.push(String(init?.body));
			return attempts++ === 0 ? first.promise : transport([completed()]);
		},
	});
	try {
		await h.composition.catalog.saveScenario(fixture.scenario, signal());
		await h.composition.catalog.savePreview(fixture.preview, signal());
		await h.composition.catalog.saveDiagram(fixture.diagram, signal());
		const routers = createCompositionRouters(h.composition);
		const agent = routers.agent.createCaller({});
		const artifacts = routers.artifacts.createCaller({});
		await agent.start(fixture.agentTurn);
		await until(() => attempts === 1);
		const screen = {
			...fixture.screenContext,
			sequence: fixture.screenContext.sequence + 1,
			panel: "scenario" as const,
		};
		h.screens.update({ sessionId: fixture.agentTurn.sessionId, screenContext: screen });
		first.resolve(
			transport([
				completed([
					call("show_scenario", {
						scenarioId: fixture.scenario.id,
						stepId: fixture.scenario.after.steps[0]?.id,
					}),
				]),
			])
		);
		await until(() => h.composition.service.poll(identity(fixture.agentTurn)).status !== "running");
		const result = h.composition.service.poll(identity(fixture.agentTurn));
		assert.equal(result.status, "completed");
		assert.deepEqual(
			result.actions.map((action) => action.kind),
			["show-scenario", "highlight-code"]
		);
		assert.equal(new Set(result.actions.map((action) => action.requestId)).size, 2);
		assert(result.actions.every((action) => action.screenSequence === screen.sequence));
		assert.deepEqual(await artifacts.getScenario({ id: fixture.scenario.id }), fixture.scenario);
		assert.deepEqual(await artifacts.getPreview({ id: fixture.preview.id }), fixture.preview);
		assert.deepEqual(await artifacts.getDiagram({ id: fixture.diagram.id }), fixture.diagram);
		assert(requests[0]?.includes(fixture.scenario.id));
		assert(requests[1]?.includes(`\\"sequence\\":${screen.sequence}`));
		const log = await readFile(join(h.root, "agent/usage.jsonl"), "utf8");
		assert.equal(log.trim().split("\n").length, 2);
		for (const secret of [
			"injected-test-key",
			fixture.agentTurn.text,
			"function_call",
			"response-test",
		])
			assert(!log.includes(secret));
		assert.equal((await stat(join(h.root, "agent/usage.jsonl"))).mode & 0o777, 0o600);
		assert.equal(h.composition.usage.summary(fixture.preparation.pr.id).requests, 2);
		await agent.release({ sessionId: fixture.agentTurn.sessionId });
		assert.deepEqual(
			h.screens.get(fixture.agentTurn.sessionId, fixture.screenContext),
			fixture.screenContext
		);
	} finally {
		await h.close();
	}
});

test("no key and provider error paths fail without retries or sensitive output", async () => {
	let attempts = 0;
	const h = await mockHarness({
		fetch: async () => {
			attempts++;
			return new Response("private error body", { status: 401 });
		},
	});
	try {
		const input = h.runtime.fixture.agentTurn;
		h.runtime.credentials.get = async () => undefined;
		h.composition.service.start(input);
		await until(() => h.composition.service.poll(identity(input)).status === "error");
		assert.equal(attempts, 0);
		h.runtime.credentials.get = async () => "injected-test-key";
		const next = { ...input, requestId: "next", turnId: "next", generation: input.generation + 1 };
		h.composition.service.start(next);
		await until(() => h.composition.service.poll(identity(next)).status === "error");
		assert.equal(attempts, 1);
		assert(
			!JSON.stringify(h.composition.service.poll(identity(next))).includes("private error body")
		);
		assert.equal(h.composition.usage.summary(input.screenContext.prId).requests, 1);
	} finally {
		await h.close();
	}
});

test("explicit intent uses inspected excerpts and current context, retaining seeded fixture provenance", async () => {
	let payload = "";
	const terminal = completed();
	terminal.response.model = "muse-wonder-1.0";
	const h = await mockHarness({
		fetch: async (_input, init) => {
			payload = String(init?.body);
			return transport([
				{
					type: "response.output_text.delta",
					delta: JSON.stringify([
						{
							id: "0",
							text: "Likely adjusts pricing.",
							explanation: "Inferred from the inspected return expression.",
						},
					]),
				},
				terminal,
			]);
		},
		getIntentTrail: async () => {
			throw new Error("Seeded author intent must not be fetched as real");
		},
	});
	try {
		h.runtime.pr = { ...h.runtime.pr, url: "https://example.invalid/demo/shop-web/pull/1284" };
		const location = {
			repository: h.runtime.pr.repository,
			commitSha: h.runtime.pr.headSha,
			revision: "head" as const,
			path: "pricing/applyDiscounts.ts",
			startLine: 1,
			endLine: 1,
		};
		const initial = {
			prId: h.runtime.pr.id,
			sequence: 1,
			panel: "diff" as const,
			focusedLocation: location,
		};
		const current = { ...initial, sequence: 2, panel: "why" as const };
		h.screens.update({ sessionId: "intent", screenContext: current });
		const prep = await h.composition.explainIntent({
			requestId: "intent-request",
			sessionId: "intent",
			screenContext: initial,
			locations: [location],
		});
		assert.equal(prep.evidence.kind, "fixture");
		assert.equal(prep.whyNotes[0]?.provenance.kind, "inferred");
		assert.equal(prep.whyNotes[0]?.evidence.kind, "source");
		assert(payload.includes("return 2"));
		assert(payload.includes('\\"sequence\\":2'));
		assert.equal((await h.composition.review.prepare(h.runtime.pr.id)).whyNotes.length, 1);
		assert.equal(h.composition.usage.summary(h.runtime.pr.id).requests, 1);
	} finally {
		await h.close();
	}
});

test("mechanical candidates remain unverified without a trusted build command and source identity cannot drift", async () => {
	const h = await mockHarness();
	try {
		h.runtime.changedFiles = async () => ["settings.json"];
		h.runtime.sourceOverride = async (prId, revision, path) => ({
			prId,
			revision,
			path,
			repository: h.runtime.pr.repository,
			commitSha: revision === "base" ? h.runtime.pr.baseSha : h.runtime.pr.headSha,
			content: revision === "base" ? '{"a":1}' : '{ "a": 1 }',
		});
		h.runtime.scenarios.runBuilds = async () => {
			throw new Error("Unconfigured builds must not be executed");
		};
		const prep = await h.composition.review.prepare(h.runtime.pr.id);
		assert.equal(prep.files[0]?.category, "mechanical-candidate");
		assert.equal(prep.files[0]?.behaviorCheck, undefined);
		const source = await h.runtime.source(h.runtime.pr.id, "head", "settings.json");
		h.runtime.sourceOverride = async () => ({ ...source, path: "different.json" });
		await assert.rejects(
			h.composition.review.source({
				prId: h.runtime.pr.id,
				revision: "head",
				path: "settings.json",
			}),
			/pinned request/
		);
	} finally {
		await h.close();
	}
});

test("cancel rejects late provider effects and disposal waits for ignored transport abort", async () => {
	const response = deferred<Response>();
	let dispatched = false;
	let transportSignal: AbortSignal | null | undefined;
	const h = await mockHarness({
		fetch: async (_input, init) => {
			dispatched = true;
			transportSignal = init?.signal;
			return response.promise;
		},
	});
	try {
		const input = h.runtime.fixture.agentTurn;
		h.composition.service.start(input);
		await until(() => dispatched);
		h.composition.service.cancel({ ...identity(input), requestId: "cancel", reason: "navigation" });
		await until(() => Boolean(transportSignal?.aborted));
		assert.equal(h.composition.service.poll(identity(input)).status, "cancelled");
		let disposed = false;
		const disposal = h.composition.dispose().then(() => {
			disposed = true;
		});
		await delay(10);
		assert.equal(disposed, false);
		response.resolve(transport([completed([call("draft_comment", { body: "Late draft" })])]));
		await disposal;
		assert.equal(h.composition.service.poll(identity(input)).actions.length, 0);
		assert.throws(
			() => h.composition.service.start({ ...input, generation: input.generation + 1 }),
			/disposed|shut down/
		);
	} finally {
		response.resolve(transport([completed()]));
		await h.close();
	}
});

for (const cleanup of ["never settles", "rejects"] as const) {
	test(`disposal completes after a late fetch when body cancellation ${cleanup}`, async () => {
		const response = deferred<Response>();
		let dispatched = false;
		let cancellationStarted = false;
		let transportSignal: AbortSignal | null | undefined;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const h = await mockHarness({
			fetch: async (_input, init) => {
				dispatched = true;
				transportSignal = init?.signal;
				return response.promise;
			},
		});
		try {
			h.composition.service.start(h.runtime.fixture.agentTurn);
			await until(() => dispatched);
			let disposed = false;
			const disposal = h.composition.dispose().then(() => {
				disposed = true;
			});
			await delay(10);
			assert(transportSignal?.aborted);
			assert.equal(disposed, false, "Shutdown still awaits the ignored-abort fetch");
			response.resolve(
				new Response(
					new ReadableStream<Uint8Array>({
						cancel() {
							cancellationStarted = true;
							return cleanup === "never settles"
								? new Promise<void>(() => {})
								: Promise.reject(new Error("Body cleanup failed"));
						},
					})
				)
			);
			await Promise.race([
				disposal,
				new Promise<never>((_resolve, reject) => {
					timeout = setTimeout(() => reject(new Error("Body cleanup blocked disposal")), 1000);
				}),
			]);
			assert(cancellationStarted, "Late body cleanup was attempted");
			assert.equal(disposed, true);
			await delay(0); // Let any unobserved cleanup rejection reach the test runner.
		} finally {
			clearTimeout(timeout);
			response.resolve(transport([completed()]));
			// A regression must fail promptly even when its cleanup promise never settles.
			void h.composition.dispose().catch(() => {});
			await h.runtime.dispose();
			await rm(h.root, { recursive: true });
		}
	});
}

test("catalog rejects foreign identity, out-of-bounds lines, stale revisions and cancelled late validation", async () => {
	const h = await mockHarness();
	try {
		const fixture = h.runtime.fixture;
		await h.composition.catalog.saveScenario(fixture.scenario, signal());
		const bad = structuredClone(fixture.scenario);
		bad.id = "foreign";
		const step = bad.after.steps[0];
		assert(step);
		step.location.repository = "wrong/repository";
		await assert.rejects(h.composition.catalog.saveScenario(bad, signal()), /another revision/);
		const location = fixture.scenario.after.steps[0]?.location;
		assert(location);
		assert.equal(
			await h.composition.review.validateLocation(h.runtime.pr.id, { ...location, endLine: 10000 }),
			false
		);
		assert.equal(
			await h.composition.review.validateLocation(h.runtime.pr.id, {
				...location,
				path: "../outside",
			}),
			false
		);
		const gate = deferred<void>();
		let reading = false;
		const source = h.runtime.source.bind(h.runtime);
		const snapshot = await source(
			h.runtime.pr.id,
			"head",
			fixture.preview.markers[0]?.location.path ?? "a.ts"
		);
		h.runtime.sourceOverride = async () => {
			reading = true;
			await gate.promise;
			return snapshot;
		};
		const controller = new AbortController();
		const saving = h.composition.catalog.savePreview(fixture.preview, controller.signal);
		await until(() => reading);
		controller.abort();
		gate.resolve();
		await assert.rejects(saving);
		assert.throws(() => h.composition.catalog.getPreview(fixture.preview.id), /not found/);
		h.runtime.pr = { ...h.runtime.pr, headSha: "f".repeat(40) };
		assert.throws(() => h.composition.catalog.getScenario(fixture.scenario.id), /revision changed/);
	} finally {
		await h.close();
	}
});

function confirm(
	draft: ReturnType<ReturnType<typeof createAgentComposition>["drafts"]["get"]>,
	requestId = "confirm-original"
): ConfirmCommentInput {
	return {
		requestId,
		draftId: draft.id,
		draftRevision: draft.revision,
		body: draft.body,
		headSha: draft.headSha,
		confirmed: true,
	};
}
test("fixture posting is rejected before any GitHub read, including forged non-fixture seed drafts", async () => {
	const h = await mockHarness();
	try {
		h.runtime.pr = { ...h.runtime.pr, url: "https://example.invalid/demo/shop-web/pull/1284" };
		let reads = 0;
		h.runtime.github.readPullRequest = async () => {
			reads++;
			return h.runtime.pr;
		};
		const prep = await h.composition.review.prepare(h.runtime.pr.id);
		assert.equal(prep.evidence.kind, "fixture");
		for (const evidence of [
			prep.evidence,
			{
				kind: "source" as const,
				url: "https://github.com/example/repo",
				retrievedAt: new Date().toISOString(),
			},
		]) {
			const draft = h.composition.drafts.create({
				prId: h.runtime.pr.id,
				headSha: h.runtime.pr.headSha,
				body: "Draft",
				originalWords: "Draft",
				evidence,
			});
			await assert.rejects(
				h.composition.drafts.confirmAndPost(confirm(draft), signal()),
				/cannot be posted/
			);
		}
		assert.equal(reads, 0);
	} finally {
		await h.close();
	}
});

test("confirmation preserves exact identity, retryable preflight, ambiguous lock and shutdown awaiting", async () => {
	const h = await mockHarness();
	const late = deferred<{ id: number; url: string }>();
	try {
		h.runtime.pr = { ...h.runtime.pr, url: "https://github.com/demo/shop-web/pull/1284" };
		const draft = h.composition.drafts.create({
			prId: h.runtime.pr.id,
			headSha: h.runtime.pr.headSha,
			body: "Exact body",
			originalWords: "Original",
			evidence: { kind: "source", url: h.runtime.pr.url, retrievedAt: new Date().toISOString() },
		});
		const input = confirm(draft);
		await assert.rejects(
			h.composition.drafts.confirmAndPost({ ...input, body: "changed" }, signal()),
			/stale/
		);
		h.runtime.github.readPullRequest = async () => ({ ...h.runtime.pr, headSha: "f".repeat(40) });
		await assert.rejects(h.composition.drafts.confirmAndPost(input, signal()), /changed/);
		let posts = 0;
		let receivedSignal: AbortSignal | undefined;
		h.runtime.github.readPullRequest = async () => h.runtime.pr;
		h.runtime.github.postConfirmedComment = async (pr, saved, confirmation, active) => {
			posts++;
			receivedSignal = active;
			assert.deepEqual(pr, h.runtime.pr);
			assert.deepEqual(saved, draft);
			assert.deepEqual(confirmation, input);
			return late.promise;
		};
		const controller = new AbortController();
		const pending = h.composition.drafts.confirmAndPost(input, controller.signal);
		const rejected = assert.rejects(pending);
		await until(() => posts === 1);
		controller.abort();
		await rejected;
		assert(receivedSignal?.aborted);
		await assert.rejects(
			h.composition.drafts.confirmAndPost({ ...input, requestId: "new-id" }, signal()),
			/reconcile/
		);
		await assert.rejects(h.composition.drafts.confirmAndPost(input, signal()));
		assert.equal(posts, 1);
		let disposed = false;
		const disposal = h.composition.dispose().then(() => {
			disposed = true;
		});
		await delay(10);
		assert.equal(disposed, false);
		late.resolve({ id: 1, url: "https://github.com/demo/shop-web/pull/1284#comment" });
		await disposal;
	} finally {
		late.resolve({ id: 1, url: "https://github.com/example/repo" });
		await h.close();
	}
});

test("real local Scenario C and generated execution share the runtime catalog and pinned source", async () => {
	const root = await mkdtemp(join(tmpdir(), "composition-local-"));
	let runtime: RuntimeService;
	const composition = createAgentComposition({
		getRuntime: () => runtime,
		getDataDirectory: () => root,
		screenContexts: new ScreenContextStore(),
		fetch: async () => {
			throw new Error("No live provider calls");
		},
		scenarioTargets: async () => [],
	});
	let previewClosed = false;
	runtime = composition.createRuntime({
		...runtimeOptions(root),
		// Geometry is mocked here; the server, readiness execution and source validation are real.
		createPreviewPage: () => ({
			async loadURL() {},
			async setViewport() {},
			async measure() {
				return [
					{ id: "cap-note", x: 1, y: 1, width: 10, height: 10 },
					{ id: "pay-button", x: 1, y: 20, width: 10, height: 10 },
				];
			},
			close() {
				previewClosed = true;
			},
		}),
	});
	try {
		const caller = createRuntimeRouter(() => runtime).createCaller({});
		const prs = await caller.prepareDemo();
		const pr = prs.find((p) => p.repository === "demo/shop-web");
		assert(pr);
		const prep = await composition.review.prepare(pr.id);
		assert.equal(prep.evidence.kind, "fixture");
		const result = await caller.runScenario({ requestId: "local-C", prId: pr.id, scenarioId: "C" });
		assert.deepEqual(composition.catalog.getScenario(result.trace.id, pr.id), result.trace);
		assert.equal(result.trace.after.evidence.kind, "execution");
		assert.equal((result.results.head as { batchStopped: boolean }).batchStopped, true);
		for (const step of [...result.trace.before.steps, ...result.trace.after.steps])
			assert(await composition.review.validateLocation(pr.id, step.location));
		const authoring = composition.ports.scenarioAuthoring;
		assert(authoring);
		const generated = generateScenario(expiredReminderPlan(pr));
		await authoring.saveGenerated(generated, signal());
		const execution = await requestScenarioExecution(
			await authoring.getGenerated(pr.id, "C", signal()),
			authoring.runtime,
			signal()
		);
		await authoring.saveTrace(execution.trace, signal());
		assert.equal(
			composition.catalog.getScenario(execution.trace.id).after.evidence.kind,
			"execution"
		);
		assert.equal(execution.trace.after.status, "failed");
		assert.equal(composition.catalog.available(pr.id).scenarios.length, 2);
		const location = {
			repository: pr.repository,
			revision: "head" as const,
			commitSha: pr.headSha,
			path: "pricing/applyDiscounts.ts",
			startLine: 1,
			endLine: 20,
		};
		const context = await composition.review.codeContext(pr.id, [location], ["pricing/price.ts"]);
		assert.deepEqual(composition.catalog.getDiagram(context.diagram.id), context.diagram);
		assert.equal(context.diagram.evidence.kind, "source");
		const preview = await caller.startPreview({
			requestId: "local-preview",
			prId: pr.id,
			mode: "phone",
		});
		assert.equal(preview.evidence.kind, "execution");
		assert.deepEqual(composition.catalog.getPreview(preview.id), preview);
		await caller.stopPreview({ id: preview.id });
		assert(previewClosed);
		assert.throws(() => composition.catalog.getPreview(preview.id), /not found/);
		await assert.rejects(fetch(preview.url, { signal: AbortSignal.timeout(2000) }));
	} finally {
		await composition.dispose();
		await runtime.dispose();
		await rm(root, { recursive: true });
	}
});
