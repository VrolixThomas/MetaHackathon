import { z } from "zod";
import {
	AgentActionReceiptResultSchema,
	AgentActionReceiptSchema,
	CancelTurnInputSchema,
	CancelTurnResultSchema,
	ConfirmCommentInputSchema,
	DraftedCommentSchema,
	IdSchema,
} from "../../shared/contracts";
import { publicProcedure, router } from "../trpc";
import type { CommentDrafts } from "./comments";
import { PollTurnResultSchema, StartTurnResultSchema } from "./events";
import { type AgentService, PollTurnSchema, StartTurnSchema } from "./service";

/** Integration registers this factory's router and owns service lifetime and trusted ports. */
export function createAgentRouter(service: AgentService, drafts: CommentDrafts) {
	return router({
		actionApplied: publicProcedure
			.input(AgentActionReceiptSchema)
			.output(AgentActionReceiptResultSchema)
			.mutation(({ input }) => service.actionApplied(input)),
		start: publicProcedure
			.input(StartTurnSchema)
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
		getDraft: publicProcedure
			.input(z.strictObject({ draftId: IdSchema }))
			.output(DraftedCommentSchema)
			.query(({ input }) => drafts.get(input.draftId)),
		editDraft: publicProcedure
			.input(z.strictObject({ draftId: IdSchema, body: z.string().min(1).max(20000) }))
			.output(DraftedCommentSchema)
			.mutation(({ input }) => drafts.edit(input.draftId, input.body)),
		confirmComment: publicProcedure
			.input(ConfirmCommentInputSchema)
			.output(z.strictObject({ url: z.url() }))
			.mutation(({ input }) => drafts.confirmAndPost(input, AbortSignal.timeout(30_000))),
	});
}
