import { router } from "..";
import { createConversationRouter } from "../../agent/conversation-router";
import { createAgentScreenRouter } from "../../agent/screen-context";
import { createCompositionRouters } from "../../composition";
import { createBrowserRouter } from "../../composition/browser-router";
import { createConfiguredVoiceRouter } from "../../composition/voice";
import { createAppConfigurationRouter } from "../../config/router";
import { createRuntimeRouter } from "../../runtime/router";
import {
	agentComposition,
	conversationService,
	getBrowser,
	getConfigurationPorts,
	getRuntime,
	getVoice,
	screenContexts,
} from "../../services";
import { bootstrapRouter } from "./bootstrap";

// Register feature routers here as the application grows.
export const appRouter = router({
	app: createAppConfigurationRouter(getConfigurationPorts),
	conversation: createConversationRouter(conversationService),
	bootstrap: bootstrapRouter,
	runtime: createRuntimeRouter(getRuntime),
	browser: createBrowserRouter(getBrowser),
	voice: createConfiguredVoiceRouter(getVoice),
	screen: createAgentScreenRouter(screenContexts),
	...createCompositionRouters(agentComposition),
});
export type AppRouter = typeof appRouter;
