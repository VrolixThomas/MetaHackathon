import { z } from "zod";
import {
	IdSchema,
	ReviewDetailSchema,
	ReviewFileRequestSchema,
	ReviewFileSchema,
	ReviewInboxSchema,
	ReviewProgressSchema,
	ReviewScreenSchema,
} from "../../shared/contracts";
import { publicProcedure, router } from "../trpc";
import {
	ConnectReviewSchema,
	type ReviewCoordinator,
	ReviewProgressInputSchema,
	UpdateReviewScreenSchema,
} from "./reviews";

/** Root supplies the lazy coordinator and owns native repository selection. */
export function createReviewRouter(resolveCoordinator: () => ReviewCoordinator) {
	const getCoordinator = () => {
		try {
			return resolveCoordinator();
		} catch {
			throw new Error("Review service is unavailable. Restart the application.");
		}
	};
	const pr = z.strictObject({ prId: IdSchema });
	return router({
		connect: publicProcedure
			.input(ConnectReviewSchema)
			.output(ReviewInboxSchema)
			.mutation(({ input }) => getCoordinator().connect(input)),
		disconnect: publicProcedure
			.output(ReviewInboxSchema)
			.mutation(() => getCoordinator().disconnect()),
		inbox: publicProcedure.output(ReviewInboxSchema).query(() => getCoordinator().inbox()),
		refresh: publicProcedure.output(ReviewInboxSchema).mutation(() => getCoordinator().refresh()),
		get: publicProcedure
			.input(pr)
			.output(ReviewDetailSchema)
			.query(({ input }) => getCoordinator().get(input.prId)),
		prepare: publicProcedure
			.input(pr.extend({ force: z.boolean().optional() }))
			.output(ReviewDetailSchema)
			.mutation(({ input }) => getCoordinator().prepareReview(input.prId, input.force)),
		file: publicProcedure
			.input(ReviewFileRequestSchema)
			.output(ReviewFileSchema)
			.query(({ input }) => getCoordinator().file(input)),
		progress: publicProcedure
			.input(ReviewProgressInputSchema)
			.output(ReviewProgressSchema)
			.mutation(({ input }) => getCoordinator().progress(input)),
		screen: publicProcedure
			.input(UpdateReviewScreenSchema)
			.output(ReviewScreenSchema)
			.mutation(({ input }) => getCoordinator().updateScreen(input)),
	});
}
