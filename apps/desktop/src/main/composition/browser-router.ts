import { z } from "zod";
import {
	type BrowserCommand,
	BrowserCommandSchema,
	BrowserObserveInputSchema,
	type BrowserPresentInput,
	BrowserPresentInputSchema,
	type BrowserState,
	BrowserStateSchema,
} from "../../shared/contracts";
import { publicProcedure, router } from "../trpc";

export interface VisibleBrowser {
	execute(command: BrowserCommand, signal: AbortSignal): Promise<BrowserState>;
	observe(sessionId: string, signal: AbortSignal): Promise<BrowserState | null>;
	present(input: BrowserPresentInput): void;
	close(sessionId: string): Promise<void>;
}

/** UI and agent use the same main-owned browser. This router never allocates another page. */
export function createBrowserRouter(getBrowser: () => VisibleBrowser) {
	return router({
		execute: publicProcedure
			.input(BrowserCommandSchema)
			.output(BrowserStateSchema)
			.mutation(({ input }) => getBrowser().execute(input, AbortSignal.timeout(60_000))),
		observe: publicProcedure
			.input(BrowserObserveInputSchema)
			.output(BrowserStateSchema.nullable())
			.query(({ input }) => getBrowser().observe(input.sessionId, AbortSignal.timeout(15_000))),
		present: publicProcedure
			.input(BrowserPresentInputSchema)
			.output(z.void())
			.mutation(({ input }) => getBrowser().present(input)),
		close: publicProcedure
			.input(BrowserObserveInputSchema)
			.output(z.void())
			.mutation(({ input }) => getBrowser().close(input.sessionId)),
	});
}
