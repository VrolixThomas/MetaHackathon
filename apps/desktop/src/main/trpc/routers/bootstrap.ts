import { z } from "zod";
import { publicProcedure, router } from "..";
import { CONTRACT_VERSION } from "../../../shared/contracts";
import {
	DEMO_FIXTURE_ID,
	ReviewFixtureSchema,
	getReviewFixture,
} from "../../../shared/fixtures/review";

// Development data only. No external services, processes, microphone or GitHub mutations.
export const bootstrapRouter = router({
	contract: publicProcedure
		.output(
			z.strictObject({
				contractVersion: z.literal(CONTRACT_VERSION),
				dataMode: z.literal("fixture"),
				supportsSubscriptions: z.literal(false),
				fixtureIds: z.array(z.literal(DEMO_FIXTURE_ID)),
			})
		)
		.query(() => ({
			contractVersion: CONTRACT_VERSION,
			dataMode: "fixture" as const,
			supportsSubscriptions: false as const,
			fixtureIds: [DEMO_FIXTURE_ID],
		})),
	fixture: publicProcedure
		.input(z.strictObject({ fixtureId: z.literal(DEMO_FIXTURE_ID) }))
		.output(ReviewFixtureSchema)
		.query(() => getReviewFixture()),
});
