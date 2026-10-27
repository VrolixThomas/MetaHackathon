import { z } from "zod";
import {
	AgentActionReceiptResultSchema,
	CancelTurnInputSchema,
	CancelTurnResultSchema,
	ConversationActionReceiptSchema,
	ConversationTurnInputSchema,
	IdSchema,
	PollTurnResultSchema,
	PollTurnSchema,
} from "../../shared/contracts";
import { publicProcedure, router } from "../trpc";
import type { ConversationService } from "./conversation";
import { StartTurnResultSchema } from "./events";

/** Root registers this separate from the legacy screen-bound review agent. */
export function createConversationRouter(service: ConversationService) {
	return router({
		actionApplied: publicProcedure
			.input(ConversationActionReceiptSchema)
			.output(AgentActionReceiptResultSchema)
			.mutation(({ input }) => service.actionApplied(input)),
		start: publicProcedure
			.input(ConversationTurnInputSchema)
			.output(StartTurnResultSchema)
			.mutation(({ input }) => service.start(input)),
		poll: publicProcedure
			.input(PollTurnSchema)
			.output(PollTurnResultSchema)
			.query(({ input }) => service.poll(input)),
		cancel: publicProcedure
			.input(CancelTurnInputSchema)
			.output(CancelTurnResultSchema)
			.mutation(({ input }) => service.cancel(input)),
		release: publicProcedure
			.input(z.strictObject({ sessionId: IdSchema }))
			.output(z.void())
			.mutation(({ input }) => service.releaseSession(input.sessionId)),
	});
}
