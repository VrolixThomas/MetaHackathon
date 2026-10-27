import assert from "node:assert/strict";
import { test } from "node:test";
import { getReviewFixture } from "../../shared/fixtures/review";
import { MetaClient } from "./meta-client";
import { proposeScenarios } from "./scenario-proposals";
import { generateScenario, requestScenarioExecution } from "./scenarios";
import { completed, transport } from "./test-support";

function scenarioPlan() {
	const fixture = getReviewFixture();
	return {
		id: "C",
		pr: fixture.preparation.pr,
		title: "Expired promo must not stop later reminders",
		origin: {
			kind: "reviewer" as const,
			requestId: "voice-1",
			originalWords: "What if a promo expires before the nightly reminder?",
		},
		inputs: { expired: true, numberOfCarts: 2 },
		modulePath: "jobs/cartReminder.ts",
		exportName: "cartReminder",
		anchor: "export function cartReminder(",
		arguments: [
			[
				{ id: "first", subtotal: 120, code: "SPRING15", shopper: { loyalty: { percent: 10 } } },
				{ id: "second", subtotal: 80, shopper: { loyalty: { percent: 10 } } },
			],
			[],
			{ expired: true },
		],
		expectation: {
			path: ["arguments", 1, "length"],
			equals: 2,
			description: "Both carts receive reminders",
		},
	};
}

test("generated tests retain provenance and not-run state; runtime fixtures cannot become execution", async () => {
	const generated = generateScenario(scenarioPlan());
	assert.equal(generated.execution, "not-run");
	assert.equal(generated.plan.origin.kind, "reviewer");
	assert(generated.source.includes("METAHACKATHON_TRACE"));
	assert(generated.source.includes("METAHACKATHON_RESULT"));
	const fixture = getReviewFixture();
	await assert.rejects(
		requestScenarioExecution(
			generated,
			{
				runGeneratedTest: async () => ({
					trace: fixture.scenario,
					results: { base: null, head: null },
				}),
			},
			new AbortController().signal
		),
		/execution evidence/
	);
	let executed = false;
	await assert.rejects(
		requestScenarioExecution(
			{ ...generated, source: `${generated.source}\n// modified` },
			{
				runGeneratedTest: async () => {
					executed = true;
					throw new Error("Must not reach runtime");
				},
			},
			new AbortController().signal
		),
		/changed/
	);
	assert.equal(executed, false);
	await assert.rejects(
		requestScenarioExecution(
			{ ...generated, filename: "other.mjs" },
			{
				runGeneratedTest: async () => {
					executed = true;
					throw new Error("Must not reach runtime");
				},
			},
			new AbortController().signal
		),
		/changed/
	);
	assert.equal(executed, false);
	assert.throws(() => generateScenario({ ...scenarioPlan(), modulePath: "../private.ts" }));
	assert.throws(() =>
		generateScenario({
			...scenarioPlan(),
			expectation: { path: ["constructor"], equals: null, description: "unsafe" },
		})
	);
});

test("deep scenario proposals bind target and provenance to trusted briefs instead of model claims", async () => {
	const fixture = getReviewFixture();
	const plan = scenarioPlan();
	const client = new MetaClient({
		getApiKey: async () => "test-key",
		recordUsage: () => {},
		fetch: async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			assert.equal(body.model, "muse-wonder-1.0");
			assert(JSON.stringify(body.input).includes("screenContext"));
			const end = completed();
			end.response.model = "muse-wonder-1.0";
			return transport([
				{
					type: "response.output_text.delta",
					delta: JSON.stringify([
						{
							briefId: "C",
							targetId: "reminder",
							title: plan.title,
							inputs: plan.inputs,
							arguments: plan.arguments,
							expectation: plan.expectation,
						},
					]),
				},
				end,
			]);
		},
	});
	const generated = await proposeScenarios(
		client,
		{
			requestId: "proposal",
			pr: plan.pr,
			screenContext: fixture.screenContext,
			briefs: [{ id: "C", text: plan.origin.originalWords, origin: plan.origin }],
			targets: [
				{
					id: "reminder",
					location: {
						repository: plan.pr.repository,
						revision: "head",
						commitSha: plan.pr.headSha,
						path: plan.modulePath,
						startLine: 1,
						endLine: 1,
					},
					modulePath: plan.modulePath,
					exportName: plan.exportName,
					anchor: plan.anchor,
					sourceText: "export function cartReminder(carts, sent, state) {}",
				},
			],
		},
		new AbortController().signal
	);
	assert.equal(generated[0]?.execution, "not-run");
	assert.deepEqual(generated[0]?.plan.origin, plan.origin);
});

function executionResult() {
	const generated = generateScenario(scenarioPlan());
	const trace = getReviewFixture().scenario;
	trace.title = generated.plan.title;
	trace.inputs = generated.plan.inputs;
	trace.after.status = "failed";
	for (const run of [trace.before, trace.after]) {
		run.evidence = {
			kind: "execution",
			runId: `mock-${run.revision}`,
			commitSha: run.commitSha,
			command: ["node", generated.filename],
			startedAt: "2026-10-26T20:00:00Z",
			completedAt: "2026-10-26T20:00:01Z",
			exitCode: run.status === "completed" ? 0 : 1,
			logUrl: "file:///mock-scenario-log",
		};
	}
	return { trace, results: { base: null, head: null } };
}

test("runtime traces bind to the generated inputs, title and repository, with consistent success", async () => {
	const generated = generateScenario(scenarioPlan());
	for (const change of [
		(result: ReturnType<typeof executionResult>) => {
			result.trace.title = "Different scenario";
		},
		(result: ReturnType<typeof executionResult>) => {
			result.trace.inputs = { expired: false };
		},
		(result: ReturnType<typeof executionResult>) => {
			const step = result.trace.after.steps[0];
			assert(step);
			step.location.repository = "other/repository";
		},
		(result: ReturnType<typeof executionResult>) => {
			assert(result.trace.before.evidence.kind === "execution");
			result.trace.before.evidence.exitCode = 1;
		},
	]) {
		const result = executionResult();
		change(result);
		await assert.rejects(
			requestScenarioExecution(
				generated,
				{ runGeneratedTest: async () => result },
				new AbortController().signal
			)
		);
	}
	const result = executionResult();
	const accepted = await requestScenarioExecution(
		generated,
		{ runGeneratedTest: async () => result },
		new AbortController().signal
	);
	assert.deepEqual(accepted.trace, result.trace);
	assert.equal(accepted.generated.execution, "not-run");
	assert.equal(accepted.trace.after.status, "failed");
});

test("pre-cancelled scenario execution never enters the runtime", async () => {
	const controller = new AbortController();
	controller.abort();
	let executions = 0;
	await assert.rejects(
		requestScenarioExecution(
			generateScenario(scenarioPlan()),
			{
				runGeneratedTest: async () => {
					executions++;
					return executionResult();
				},
			},
			controller.signal
		),
		{ name: "AbortError" }
	);
	assert.equal(executions, 0);
});

test("runtime adapters cannot mutate the generated plan used to validate their result", async () => {
	const generated = generateScenario(scenarioPlan());
	await assert.rejects(
		requestScenarioExecution(
			generated,
			{
				runGeneratedTest: async (input) => {
					input.inputs["expired"] = false;
					const result = executionResult();
					result.trace.inputs = input.inputs;
					return result;
				},
			},
			new AbortController().signal
		),
		/does not match/
	);
	assert.deepEqual(generated.plan, scenarioPlan());
});
