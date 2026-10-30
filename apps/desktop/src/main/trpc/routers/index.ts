import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { mergeRouters, publicProcedure, router } from "..";
import {
	AgentActionReceiptResultSchema,
	AgentActionSchema,
	AttentionPollResultSchema,
	AttentionPresenceSchema,
	AttentionReceiptResultSchema,
	AttentionReleaseInputSchema,
	AttentionSettleInputSchema,
	GitHubRepositorySchema,
	HUB_ERROR_MESSAGES,
	HubOperationResultSchema,
	HubOperationSchema,
	HubSnapshotSchema,
	IdSchema,
	LinearScopeSchema,
	LinearTicketSchema,
	PinnedSourceSchema,
	PullRequestFeedbackSchema,
	RepositoryChoiceSchema,
	SourceRangeRequestSchema,
	SourceSearchRequestSchema,
	WORKSPACE_GITHUB_REQUIRED,
	WorkJobSchema,
	WorkLogPageSchema,
	WorkReviewSchema,
	WorkspaceActionReceiptSchema,
	WorkspaceCommandSchema,
	WorkspaceObservationSchema,
} from "../../../shared/contracts";
import { createConversationRouter } from "../../agent/conversation-router";
import { createAgentScreenRouter } from "../../agent/screen-context";
import { createCompositionRouters } from "../../composition";
import { createBrowserRouter } from "../../composition/browser-router";
import { createLocalBrowserRouter } from "../../composition/browser-surface";
import { createDiagnosticsRouter } from "../../composition/diagnostics";
import { createReviewRouter } from "../../composition/reviews-router";
import { createConfiguredVoiceRouter } from "../../composition/voice";
import { createAppConfigurationRouter } from "../../config/router";
import { createRuntimeRouter } from "../../runtime/router";
import {
	agentComposition,
	conversationService,
	getAttention,
	getBrowser,
	getConfiguration,
	getConfigurationPorts,
	getDiagnostics,
	getHub,
	getLocalBrowser,
	getReviews,
	getRuntime,
	getVoice,
	getWorkJobs,
	getWorkspace,
	pickReviewRepository,
	screenContexts,
} from "../../services";
import { HubFailure } from "../../work/hub";
import { bootstrapRouter } from "./bootstrap";

const hubCall = async <T>(work: () => Promise<T>): Promise<T> => {
	try {
		return await work();
	} catch (error) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: error instanceof HubFailure ? error.message : HUB_ERROR_MESSAGES.failed,
		});
	}
};
// Register feature routers here as the application grows.
export const appRouter = router({
	attention: router({
		poll: publicProcedure
			.input(AttentionPresenceSchema)
			.output(AttentionPollResultSchema)
			.mutation(({ input }) => hubCall(() => getAttention().poll(input))),
		settle: publicProcedure
			.input(AttentionSettleInputSchema)
			.output(AttentionReceiptResultSchema)
			.mutation(({ input }) => hubCall(() => getAttention().settle(input))),
		release: publicProcedure
			.input(AttentionReleaseInputSchema)
			.output(AttentionReceiptResultSchema)
			.mutation(({ input }) => getAttention().release(input)),
	}),
	hub: router({
		snapshot: publicProcedure
			.input(z.strictObject({}).optional())
			.output(HubSnapshotSchema)
			.query(() => hubCall(() => getHub().snapshot())),
		operate: publicProcedure
			.input(z.strictObject({ requestId: IdSchema, operation: HubOperationSchema }))
			.output(HubOperationResultSchema)
			.mutation(({ input }) => hubCall(() => getHub().operate(input.operation, input.requestId))),
		ticket: publicProcedure
			.input(z.strictObject({ id: IdSchema }))
			.output(LinearTicketSchema)
			.query(({ input }) => hubCall(() => getHub().ticket(input.id))),
		job: publicProcedure
			.input(z.strictObject({ id: IdSchema }))
			.output(WorkJobSchema)
			.query(({ input }) => hubCall(() => getHub().job(input.id))),
		jobLog: publicProcedure
			.input(
				z.strictObject({
					jobId: IdSchema,
					cursor: z.int().nonnegative().default(0),
					limit: z.int().min(1).max(200).default(100),
				})
			)
			.output(WorkLogPageSchema)
			.query(({ input }) =>
				hubCall(() => getWorkJobs().log(input.jobId, input.cursor, input.limit))
			),
		reviewWork: publicProcedure
			.input(z.strictObject({ jobId: IdSchema }))
			.output(WorkReviewSchema)
			.query(({ input }) => hubCall(() => getWorkJobs().review(input.jobId))),
		feedback: publicProcedure
			.input(z.strictObject({ prId: IdSchema }))
			.output(z.array(PullRequestFeedbackSchema).max(1000))
			.query(({ input }) => hubCall(() => getHub().feedback(input.prId))),
		repositories: publicProcedure
			.input(z.strictObject({}).optional())
			.output(z.array(RepositoryChoiceSchema).max(1000))
			.query(() => hubCall(() => getHub().repositories())),
		linearScopes: publicProcedure
			.input(z.strictObject({}).optional())
			.output(z.array(LinearScopeSchema).max(1000))
			.query(() => hubCall(() => getHub().linearScopes())),
		source: publicProcedure
			.input(SourceRangeRequestSchema)
			.output(PinnedSourceSchema)
			.query(({ input }) => hubCall(() => getHub().source(input))),
		search: publicProcedure
			.input(SourceSearchRequestSchema)
			.output(z.array(PinnedSourceSchema).max(12))
			.query(({ input }) => hubCall(() => getHub().search(input))),
	}),
	workspace: router({
		observe: publicProcedure
			.input(z.strictObject({ sessionId: IdSchema }))
			.output(WorkspaceObservationSchema)
			.query(({ input }) => getWorkspace().observe(input.sessionId)),
		prepare: publicProcedure
			.input(
				z.strictObject({
					sessionId: IdSchema,
					requestId: IdSchema,
					expectedSequence: z.int().nonnegative(),
					command: WorkspaceCommandSchema,
				})
			)
			.output(AgentActionSchema)
			.mutation(async ({ input }) => {
				if (input.command.kind === "show-review" && !(await getConfiguration().get("github")))
					throw new TRPCError({ code: "UNAUTHORIZED", message: WORKSPACE_GITHUB_REQUIRED });
				return getWorkspace().prepare(input);
			}),
		applied: publicProcedure
			.input(WorkspaceActionReceiptSchema)
			.output(AgentActionReceiptResultSchema)
			.mutation(({ input }) => getWorkspace().applied(input)),
		release: publicProcedure
			.input(z.strictObject({ sessionId: IdSchema }))
			.output(z.void())
			.mutation(({ input }) => getWorkspace().release(input.sessionId)),
	}),
	diagnostics: createDiagnosticsRouter(getDiagnostics),
	app: createAppConfigurationRouter(getConfigurationPorts),
	conversation: createConversationRouter(conversationService),
	reviews: mergeRouters(
		createReviewRouter(getReviews),
		router({
			chooseRepository: publicProcedure
				.output(
					z
						.strictObject({ repository: GitHubRepositorySchema, localPath: z.string().min(1) })
						.nullable()
				)
				.mutation(pickReviewRepository),
		})
	),
	bootstrap: bootstrapRouter,
	runtime: createRuntimeRouter(getRuntime),
	browser: createBrowserRouter(getBrowser),
	localBrowser: createLocalBrowserRouter(getLocalBrowser),
	voice: createConfiguredVoiceRouter(getVoice),
	screen: createAgentScreenRouter(screenContexts),
	...createCompositionRouters(agentComposition),
});
export type AppRouter = typeof appRouter;
