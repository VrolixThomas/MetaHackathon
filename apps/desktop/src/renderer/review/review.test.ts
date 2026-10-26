import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { getReviewFixture } from "../../shared/fixtures/review";
import {
	getScreenContext,
	highlightLocation,
	installPreparedReview,
	useReview,
} from "./controller";
import { parseDiff } from "./model";
import { fixtureSources, initialFiles } from "./workspace-data";

const fixture = getReviewFixture();
beforeEach(() =>
	useReview.setState({
		preparation: fixture.preparation,
		files: initialFiles,
		file: "pricing/applyDiscounts.ts",
		cursor: 0,
		seen: [],
		panel: null,
		selection: null,
		sequence: 0,
		scenario: fixture.scenario,
		scenarioStepId: undefined,
		previewMarkerId: undefined,
	})
);

describe("review navigation and source identity", () => {
	it("keeps cursor selection separate from opening a file and clamps the reading route", () => {
		const state = useReview.getState();
		state.moveCursor(1);
		assert.equal(useReview.getState().file, "pricing/applyDiscounts.ts");
		state.openCursor();
		assert.equal(useReview.getState().file, "orders/finalizeOrder.ts");
		state.moveCursor(100);
		state.openCursor();
		assert.equal(useReview.getState().file, "promo/PromoCache.ts");
		state.moveCursor(-100);
		state.openCursor();
		assert.equal(useReview.getState().file, "pricing/applyDiscounts.ts");
	});
	it("preserves the review location and coverage when an artifact opens and closes", () => {
		const state = useReview.getState();
		state.openFile("checkout/PromoField.tsx");
		state.markSeen();
		state.setPanel("preview");
		state.setPanel(null);
		assert.equal(useReview.getState().file, "checkout/PromoField.tsx");
		assert.deepEqual(useReview.getState().seen, ["checkout/PromoField.tsx"]);
	});
	it("targets the removed base line, and rejects wrong repository, stale SHA and unavailable lines", () => {
		const location = fixture.scenario.before.steps[3]?.location;
		assert.ok(location);
		assert.equal(highlightLocation(location, "Before this PR"), true);
		assert.equal(getScreenContext().focusedLocation?.revision, "base");
		assert.equal(useReview.getState().selection?.start, 12);
		assert.equal(highlightLocation({ ...location, commitSha: "f".repeat(40) }, "stale"), false);
		assert.equal(highlightLocation({ ...location, repository: "another/repo" }, "other"), false);
		assert.equal(highlightLocation({ ...location, endLine: 999 }, "missing"), false);
		assert.equal(getScreenContext().focusedLocation?.commitSha, fixture.preparation.pr.baseSha);
	});
	it("preserves caller source line numbers and scenario step identity", () => {
		const step = fixture.scenario.after.steps[4];
		assert.ok(step);
		useReview.getState().setPanel("scenario");
		assert.equal(highlightLocation(step.location, "Batch stops"), true);
		useReview.setState({ scenarioStepId: step.id });
		const screen = getScreenContext();
		assert.equal(screen.focusedLocation?.startLine, 44);
		assert.equal(screen.scenarioStepId, "head-5");
		assert.equal(screen.artifactId, "scenario-c");
	});
	it("requires matching source revisions and clears coverage when a new preparation installs", () => {
		useReview.getState().markSeen();
		assert.throws(
			() =>
				installPreparedReview(fixture.preparation, {
					repository: "other",
					baseSha: fixture.preparation.pr.baseSha,
					headSha: fixture.preparation.pr.headSha,
					files: fixtureSources(),
				}),
			/Source revisions/
		);
		installPreparedReview(fixture.preparation, {
			repository: fixture.preparation.pr.repository,
			baseSha: fixture.preparation.pr.baseSha,
			headSha: fixture.preparation.pr.headSha,
			files: [],
		});
		assert.deepEqual(useReview.getState().seen, []);
		assert.equal(useReview.getState().files[0]?.lines.length, 0);
		assert.equal(getScreenContext().focusedLocation, null);
	});
});

describe("unified diff source mapping", () => {
	it("keeps unchanged context around a large file's small change", () => {
		const before = Array.from({ length: 3000 }, (_, index) => `line ${index}`);
		const after = [...before];
		after[1500] = "changed";
		const diff = parseDiff(before.join("\n"), after.join("\n"));
		assert.equal(diff.filter((line) => line.kind === "add").length, 1);
		assert.equal(diff.filter((line) => line.kind === "remove").length, 1);
		assert.equal(diff.find((line) => line.kind === "add")?.newLine, 1501);
	});
	it("keeps old and new numbers accurate across an insert, replacement and removal", () => {
		const result = parseDiff("one\ntwo\nthree\nfour", "zero\none\nTWO\nfour");
		assert.deepEqual(
			result.filter((line) => line.kind !== "add").map((line) => [line.oldLine, line.text]),
			[
				[1, "one"],
				[2, "two"],
				[3, "three"],
				[4, "four"],
			]
		);
		assert.deepEqual(
			result.filter((line) => line.kind !== "remove").map((line) => [line.newLine, line.text]),
			[
				[1, "zero"],
				[2, "one"],
				[3, "TWO"],
				[4, "four"],
			]
		);
	});
	it("does not invent a removed empty line for a new file", () => {
		assert.deepEqual(
			parseDiff("", "new").map((line) => line.kind),
			["add"]
		);
		assert.deepEqual(parseDiff("", ""), []);
	});
});
