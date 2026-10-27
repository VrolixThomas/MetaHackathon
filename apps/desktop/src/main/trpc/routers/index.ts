import { z } from "zod";
import { mergeRouters, publicProcedure, router } from "..";
import { GitHubRepositorySchema } from "../../../shared/contracts";
import { createConversationRouter } from "../../agent/conversation-router";
import { createAgentScreenRouter } from "../../agent/screen-context";
import { createCompositionRouters } from "../../composition";
import { createBrowserRouter } from "../../composition/browser-router";
import { createLocalBrowserRouter } from "../../composition/browser-surface";
import { createReviewRouter } from "../../composition/reviews-router";
import { createConfiguredVoiceRouter } from "../../composition/voice";
import { createAppConfigurationRouter } from "../../config/router";
import { createRuntimeRouter } from "../../runtime/router";
import {
	agentComposition,
	conversationService,
	getBrowser,
	getConfigurationPorts,
	getLocalBrowser,
	getReviews,
	getRuntime,
	getVoice,
	pickReviewRepository,
	screenContexts,
} from "../../services";
import { bootstrapRouter } from "./bootstrap";

// Register feature routers here as the application grows.
export const appRouter = router({
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
