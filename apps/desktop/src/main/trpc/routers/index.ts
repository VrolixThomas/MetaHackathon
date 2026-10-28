import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { mergeRouters, publicProcedure, router } from "..";
import {
	AgentActionReceiptResultSchema,
	AgentActionSchema,
	GitHubRepositorySchema,
	IdSchema,
	WORKSPACE_GITHUB_REQUIRED,
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
	getBrowser,
	getConfiguration,
	getConfigurationPorts,
	getDiagnostics,
	getLocalBrowser,
	getReviews,
	getRuntime,
	getVoice,
	getWorkspace,
	pickReviewRepository,
	screenContexts,
} from "../../services";
import { bootstrapRouter } from "./bootstrap";

// Register feature routers here as the application grows.
export const appRouter = router({
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
