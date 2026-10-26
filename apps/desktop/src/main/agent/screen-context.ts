import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { IdSchema, type ScreenContext, ScreenContextSchema } from "../../shared/contracts";
import { publicProcedure, router } from "../trpc";

export const UpdateScreenContextSchema = z.strictObject({
	sessionId: IdSchema,
	screenContext: ScreenContextSchema,
});

/** Renderer is the source of screen state. Main retains monotonically ordered snapshots. */
export class ScreenContextStore {
	private readonly contexts = new Map<string, ScreenContext>();

	update(raw: unknown): ScreenContext {
		const { sessionId, screenContext } = UpdateScreenContextSchema.parse(raw);
		const current = this.contexts.get(sessionId);
		if (current && screenContext.sequence < current.sequence) return structuredClone(current);
		if (
			current &&
			screenContext.sequence === current.sequence &&
			!isDeepStrictEqual(current, screenContext)
		) {
			throw new Error("Different screen contents cannot share a sequence");
		}
		if (!current && this.contexts.size >= 100) throw new Error("Screen session limit reached");
		this.contexts.set(sessionId, screenContext);
		return structuredClone(screenContext);
	}

	get(sessionId: string, initialContext: ScreenContext): ScreenContext {
		IdSchema.parse(sessionId);
		const current = this.contexts.get(sessionId);
		return current
			? structuredClone(current)
			: this.update({ sessionId, screenContext: initialContext });
	}

	release(sessionId: string): void {
		this.contexts.delete(IdSchema.parse(sessionId));
	}
	clear(): void {
		this.contexts.clear();
	}
}

/** Integration registers this beside agent; UI sends updates after navigation and applied effects. */
export function createAgentScreenRouter(store: ScreenContextStore) {
	return router({
		update: publicProcedure
			.input(UpdateScreenContextSchema)
			.output(ScreenContextSchema)
			.mutation(({ input }) => store.update(input)),
		release: publicProcedure
			.input(z.strictObject({ sessionId: IdSchema }))
			.output(z.void())
			.mutation(({ input }) => store.release(input.sessionId)),
	});
}
