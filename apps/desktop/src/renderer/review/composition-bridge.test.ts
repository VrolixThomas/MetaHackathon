import assert from "node:assert/strict";
import { it } from "node:test";
import superjson from "superjson";
import { getReviewFixture } from "../../shared/fixtures/review";
import { createCompositionBridge } from "./composition-bridge";

it("prepares the review and binds explicit exact-draft confirmation to composition routes", async () => {
	const fixture = getReviewFixture();
	const calls: Array<{ path: string; input: unknown }> = [];
	const bridge = createCompositionBridge(async (request) => {
		calls.push({ path: request.path, input: superjson.deserialize(request.input) });
		const value =
			request.path === "review.prepare"
				? fixture.preparation
				: request.path === "agent.editDraft"
					? fixture.draftComment
					: { url: "https://github.com/demo/shop-web/pull/1284#issuecomment-1" };
		return { result: { data: superjson.serialize(value) } };
	});
	assert.deepEqual(await bridge.review.prepare(fixture.preparation.pr.id), fixture.preparation);
	await bridge.drafts.edit(fixture.draftComment.id, "Edited review words");
	assert.deepEqual(
		calls.map((call) => call.path),
		["review.prepare", "agent.editDraft"]
	);
	await bridge.drafts.confirm(fixture.confirmation);
	assert.deepEqual(calls.at(-1), { path: "agent.confirmComment", input: fixture.confirmation });
	await assert.rejects(() =>
		bridge.drafts.confirm({ ...fixture.confirmation, confirmed: false } as never)
	);
	assert.equal(calls.length, 3);
});
