import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getReviewFixture } from "../../../shared/fixtures/review";
import { ScenarioArtifact } from "./ScenarioArtifact";
import {
	scenarioLocation,
	scenarioRows,
	scenarioStepAt,
	scenarioValue,
	selectedScenarioIndex,
} from "./scenario-model";

describe("scenario trace presentation", () => {
	it("labels fixture output and keeps backend actions disabled without adapters", () => {
		const html = renderToStaticMarkup(
			createElement(ScenarioArtifact, {
				trace: getReviewFixture().scenario,
				selectedIndex: 3,
				onSelect: () => {
					throw new Error("Rendering must not navigate code");
				},
			})
		);
		assert.match(html, /Illustrative fixture · not executed/);
		assert.match(html, /disabled="">Keep as a test/);
		assert.match(html, /disabled="">Draft comment/);
		assert.match(html, /Before this PR: Skip expired code; pricing\/applyDiscounts.ts:12/);
		assert.match(html, /This PR: Throw PromoExpiredError; pricing\/applyDiscounts.ts:12/);
	});
	it("keeps scenario C common steps together and splits at the declared expired-code step", () => {
		const trace = getReviewFixture().scenario;
		const rows = scenarioRows(trace);
		assert.deepEqual(
			rows.map((row) => row.shared),
			[true, true, true, false, false]
		);
		assert.deepEqual(
			rows.filter((row) => row.divergesHere).map((row) => row.index),
			[3]
		);
		assert.equal(rows[3]?.before?.outcome, "return");
		assert.equal(rows[3]?.after?.outcome, "throw");
	});
	it("returns original pinned source locations for either side and preserves the preferred revision when stepping", () => {
		const trace = getReviewFixture().scenario;
		assert.equal(scenarioStepAt(trace, 3, "base"), trace.before.steps[3]);
		assert.equal(scenarioStepAt(trace, 3, "head"), trace.after.steps[3]);
		assert.equal(scenarioStepAt(trace, 4, "base")?.location.startLine, 45);
		assert.equal(scenarioStepAt(trace, 4, "head")?.location.startLine, 44);
	});
	it("never invents or hides entries when one version stops recording earlier", () => {
		const trace = getReviewFixture().scenario;
		trace.after.steps = trace.after.steps.slice(0, 4);
		const rows = scenarioRows(trace);
		assert.equal(rows.length, 5);
		assert.equal(rows[4]?.after, undefined);
		assert.equal(rows[4]?.before, trace.before.steps[4]);
		assert.equal(rows[4]?.shared, false);
		assert.equal(scenarioStepAt(trace, 4, "head"), trace.before.steps[4]);
	});
	it("does not infer a divergence or common path when the runtime supplied no split", () => {
		const trace = getReviewFixture().scenario;
		trace.divergenceIndex = undefined;
		assert.equal(
			scenarioRows(trace).some((row) => row.shared || row.divergesHere),
			false
		);
	});
	it("keeps unexpectedly different values visible before the declared split", () => {
		const trace = getReviewFixture().scenario;
		const step = trace.after.steps[1];
		assert.ok(step);
		step.values = { loyaltyPercent: 20 };
		assert.equal(scenarioRows(trace)[1]?.shared, false);
	});
	it("compares JSON object values without depending on property insertion order", () => {
		const trace = getReviewFixture().scenario;
		const before = trace.before.steps[0];
		const after = trace.after.steps[0];
		assert.ok(before && after);
		before.values = { cart: { code: "SPRING15", tags: ["gold", "expired"] }, subtotal: 120 };
		after.values = { subtotal: 120, cart: { tags: ["gold", "expired"], code: "SPRING15" } };
		assert.equal(scenarioRows(trace)[0]?.shared, true);
		after.values = { subtotal: 120, cart: { tags: ["expired", "gold"], code: "SPRING15" } };
		assert.equal(scenarioRows(trace)[0]?.shared, false);
	});
	it("supports empty traces and clamps stale selection without manufacturing a step", () => {
		const trace = getReviewFixture().scenario;
		trace.before.steps = [];
		trace.after.steps = [];
		trace.divergenceIndex = undefined;
		assert.deepEqual(scenarioRows(trace), []);
		assert.equal(selectedScenarioIndex(4, 0), null);
		assert.equal(scenarioStepAt(trace, 0, "head"), undefined);
		assert.equal(selectedScenarioIndex(99, 5), 4);
		assert.equal(selectedScenarioIndex(-3, 5), 0);
		assert.equal(selectedScenarioIndex(Number.NaN, 5), 0);
		assert.equal(scenarioStepAt(getReviewFixture().scenario, -1, "head"), undefined);
		assert.equal(scenarioStepAt(getReviewFixture().scenario, 1.5, "head"), undefined);
	});
	it("shows inclusive line ranges and lossless values without inventing monetary units", () => {
		const step = getReviewFixture().scenario.after.steps[3];
		assert.ok(step);
		step.location.endLine = 14;
		assert.equal(scenarioLocation(step), "pricing/applyDiscounts.ts:12-14");
		assert.equal(scenarioValue(12000), "12000");
		assert.equal(scenarioValue(false), "false");
		assert.equal(scenarioValue(null), "null");
		assert.equal(
			scenarioValue({ code: "SPRING15", expired: true }),
			'{"code":"SPRING15","expired":true}'
		);
	});
});
