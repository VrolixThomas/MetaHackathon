import assert from "node:assert/strict";
import { beforeEach, it } from "node:test";
import type { BrowserBounds, BrowserState } from "../../shared/contracts";
import { getReviewFixture } from "../../shared/fixtures/review";
import { acceptBrowserState, createBrowserPresenter } from "./browser-session";
import { getScreenContext, useReview } from "./controller";
import { reviewSessionId } from "./conversation";
import type { BrowserAdapter } from "./services";

const fixture = getReviewFixture();
function browserSnapshot(sequence = 1): BrowserState {
	return {
		browserId: "browser-one",
		sessionId: reviewSessionId,
		prId: fixture.preparation.pr.id,
		repository: fixture.preparation.pr.repository,
		revision: "head",
		commitSha: fixture.preparation.pr.headSha,
		url: "http://127.0.0.1:1234/checkout",
		title: "Checkout",
		viewport: { width: 1024, height: 768 },
		sequence,
		observedAt: "2026-10-27T19:00:00Z",
		text: "Apply promo",
		elements: [],
		scroll: { x: 0, y: 0 },
		provenance: "live-browser",
	};
}
beforeEach(() =>
	useReview.setState({
		preparation: fixture.preparation,
		browser: null,
		panel: "browser",
		sequence: 0,
	})
);
it("only publishes browser observations pinned to the current session and PR revisions", () => {
	const browser = browserSnapshot();
	assert.equal(acceptBrowserState({ ...browser, sessionId: "another-session" }), false);
	assert.equal(acceptBrowserState({ ...browser, commitSha: "f".repeat(40) }), false);
	assert.equal(acceptBrowserState(browser), true);
	assert.equal(getScreenContext().browser?.browserId, browser.browserId);
	assert.equal(getScreenContext().panel, "browser");
	assert.equal(getScreenContext().focusedLocation, null);
	assert.equal(acceptBrowserState(browserSnapshot(0)), false);
	assert.equal(acceptBrowserState(browser), true);
	assert.equal(useReview.getState().sequence, 0);
	assert.equal(acceptBrowserState({ ...browserSnapshot(2), browserId: "other-page" }), false);
	assert.equal(
		acceptBrowserState(
			{
				...browserSnapshot(2),
				browserId: "other-page",
				revision: "base",
				commitSha: fixture.preparation.pr.baseSha,
			},
			true
		),
		true
	);
});
it("serializes late bounds before hide so a stale present cannot cover another surface", async () => {
	const calls: Array<BrowserBounds | null> = [];
	let release = () => {};
	const adapter: BrowserAdapter = {
		execute: async () => browserSnapshot(),
		observe: async () => browserSnapshot(),
		present: async (_session, bounds) => {
			calls.push(bounds);
			if (bounds)
				await new Promise<void>((done) => {
					release = done;
				});
		},
	};
	const present = createBrowserPresenter(adapter, reviewSessionId);
	const bounds = { x: 230, y: 150, width: 900, height: 640 };
	const showing = present(bounds);
	await Promise.resolve();
	await Promise.resolve();
	const hiding = present(null);
	assert.deepEqual(calls, [bounds]);
	release();
	await Promise.all([showing, hiding]);
	assert.deepEqual(calls, [bounds, null]);
});
