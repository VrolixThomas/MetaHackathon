import { router } from "..";
import { createAgentScreenRouter } from "../../agent/screen-context";
import { createCompositionRouters } from "../../composition";
import { createBrowserRouter } from "../../composition/browser-router";
import { createConfiguredVoiceRouter } from "../../composition/voice";
import { createRuntimeRouter } from "../../runtime/router";
import { agentComposition, getBrowser, getRuntime, getVoice, screenContexts } from "../../services";
import { bootstrapRouter } from "./bootstrap";

// Register feature routers here as the application grows.
export const appRouter = router({
	bootstrap: bootstrapRouter,
	runtime: createRuntimeRouter(getRuntime),
	browser: createBrowserRouter(getBrowser),
	voice: createConfiguredVoiceRouter(getVoice),
	screen: createAgentScreenRouter(screenContexts),
	...createCompositionRouters(agentComposition),
});
export type AppRouter = typeof appRouter;
