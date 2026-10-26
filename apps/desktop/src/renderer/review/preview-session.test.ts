import assert from "node:assert/strict";
import { it } from "node:test";
import { getReviewFixture } from "../../shared/fixtures/review";
import { useReview } from "./controller";
import { resizeActivePreview } from "./preview-session";

const fixture = getReviewFixture();
it("does not publish a late preview after the reviewer closes the panel", async () => {
	useReview.setState({
		preparation: fixture.preparation,
		panel: "preview",
		preview: fixture.preview,
	});
	let finish = (value: typeof fixture.preview) => {
		void value;
	};
	let signal: AbortSignal | undefined;
	const resized = resizeActivePreview(
		{
			resizePreview: async (_preview, _mode, abort) => {
				signal = abort;
				return new Promise((resolve) => {
					finish = resolve;
				});
			},
		},
		"desktop"
	);
	useReview.getState().setPanel(null);
	finish({ ...fixture.preview, id: "late" });
	await assert.rejects(() => resized);
	assert.equal(signal?.aborted, true);
	assert.equal(useReview.getState().preview?.id, fixture.preview.id);
});
it("rejects mismatched viewport results before mutating shared state", async () => {
	useReview.setState({
		preparation: fixture.preparation,
		panel: "preview",
		preview: fixture.preview,
	});
	await assert.rejects(() =>
		resizeActivePreview(
			{ resizePreview: async () => ({ ...fixture.preview, prId: "another/pr" }) },
			"desktop"
		)
	);
	assert.equal(useReview.getState().preview?.prId, fixture.preparation.pr.id);
});

it("does not resurrect a prior PR preview after installing a different head", async () => {
	useReview.setState({
		preparation: fixture.preparation,
		panel: "preview",
		preview: fixture.preview,
	});
	let finish = (value: typeof fixture.preview) => {
		void value;
	};
	const resized = resizeActivePreview(
		{
			resizePreview: () =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		},
		"desktop"
	);
	const next = structuredClone(fixture.preparation);
	next.pr.headSha = "a".repeat(40);
	useReview.setState({ preparation: next, preview: null });
	finish(fixture.preview);
	await assert.rejects(() => resized);
	assert.equal(useReview.getState().preview, null);
	assert.equal(useReview.getState().preparation.pr.headSha, next.pr.headSha);
});
