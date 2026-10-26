import { router } from "..";
import { createRuntimeRouter } from "../../runtime/router";
import { getRuntime } from "../../services";
import { bootstrapRouter } from "./bootstrap";

// Register feature routers here as the application grows.
export const appRouter = router({
	bootstrap: bootstrapRouter,
	runtime: createRuntimeRouter(getRuntime),
});
export type AppRouter = typeof appRouter;
