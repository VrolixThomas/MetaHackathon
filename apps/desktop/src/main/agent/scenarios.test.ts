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
