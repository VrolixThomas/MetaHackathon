import { router } from "..";
import { bootstrapRouter } from "./bootstrap";

// Register feature routers here as the application grows.
export const appRouter = router({ bootstrap: bootstrapRouter });
export type AppRouter = typeof appRouter;
