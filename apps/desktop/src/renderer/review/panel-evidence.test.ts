import assert from "node:assert/strict";
import { it } from "node:test";
import { getReviewFixture } from "../../shared/fixtures/review";
import { panelCopy } from "./panel-copy";

it("never reuses demo conclusions when a repository review has no artifacts", () => {
	const fixture = getReviewFixture();
	const preparation = structuredClone(fixture.preparation);
	preparation.summary = "Review the current repository changes.";
	preparation.evidence = {
		kind: "source",
		url: "https://example.com/pr/42",
		retrievedAt: "2026-10-26T00:00:00Z",
	};
	const conversation = { question: "", answer: "", state: "idle" };
	for (const mode of ["reference", "repository"] as const) {
		const copy = panelCopy(preparation, mode, "preview", conversation);
		assert.equal(copy.answer, preparation.summary);
		assert.doesNotMatch(JSON.stringify(copy), /Platinum|VIP30|below the fold|expired code/);
	}
	const seeded = panelCopy(fixture.preparation, "repository", "preview", conversation);
	assert.equal(seeded.answer, fixture.preparation.summary);
});
