import { router } from "..";
import { createAgentScreenRouter } from "../../agent/screen-context";
import { createCompositionRouters } from "../../composition";
import { createRuntimeRouter } from "../../runtime/router";
import { agentComposition, getRuntime, screenContexts } from "../../services";
import { bootstrapRouter } from "./bootstrap";

// Register feature routers here as the application grows.
export const appRouter = router({
	bootstrap: bootstrapRouter,
	runtime: createRuntimeRouter(getRuntime),
	screen: createAgentScreenRouter(screenContexts),
	...createCompositionRouters(agentComposition),
});
export type AppRouter = typeof appRouter;
