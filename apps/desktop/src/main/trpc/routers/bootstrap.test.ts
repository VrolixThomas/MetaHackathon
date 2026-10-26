import assert from "node:assert/strict";
import { describe, it } from "node:test";
import superjson from "superjson";
import { appRouter } from ".";
import { DEMO_FIXTURE_ID, ReviewFixtureSchema } from "../../../shared/fixtures/review";

describe("integrated bootstrap router", () => {
	it("exposes discoverable, validated fixtures through the registered root router", async () => {
		const caller = appRouter.createCaller({});
		const contract = await caller.bootstrap.contract();
		assert.equal(contract.dataMode, "fixture");
		assert.equal(contract.supportsSubscriptions, false);
		const result = await caller.bootstrap.fixture({
			fixtureId: contract.fixtureIds[0] ?? DEMO_FIXTURE_ID,
		});
		assert.deepEqual(
			ReviewFixtureSchema.parse(superjson.deserialize(superjson.serialize(result))),
			result
		);
	});

	it("rejects unknown fixture inputs at the tRPC boundary", async () => {
		const caller = appRouter.createCaller({});
		await assert.rejects(
			// @ts-expect-error Exercise an untyped IPC consumer at runtime.
			caller.bootstrap.fixture({ fixtureId: "unknown" }),
			(error: unknown) => error instanceof Error && "code" in error && error.code === "BAD_REQUEST"
		);
	});
});
