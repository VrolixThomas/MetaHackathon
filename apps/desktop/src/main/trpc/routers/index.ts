import { router } from "..";
import { createAgentScreenRouter } from "../../agent/screen-context";
import { createRuntimeRouter } from "../../runtime/router";
import { getRuntime, screenContexts } from "../../services";
import { bootstrapRouter } from "./bootstrap";

// Register feature routers here as the application grows.
export const appRouter = router({
	bootstrap: bootstrapRouter,
	runtime: createRuntimeRouter(getRuntime),
	screen: createAgentScreenRouter(screenContexts),
});
export type AppRouter = typeof appRouter;
