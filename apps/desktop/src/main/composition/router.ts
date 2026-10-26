import { z } from "zod";
import {
	CodeLocationSchema,
	DiagramSpecSchema,
	IdSchema,
	PRPreparationSchema,
	PreviewSchema,
	RepositoryPathSchema,
	ScenarioTraceSchema,
	ScreenContextSchema,
	SourceFileRequestSchema,
	SourceFileSchema,
} from "../../shared/contracts";
import { createAgentRouter } from "../agent/router";
import { publicProcedure, router } from "../trpc";
import { CatalogSnapshotSchema } from "./catalog";
import type { AgentComposition } from "./factory";

/** Parent registers these namespaces beside the complete existing runtime and screen routers. */
export function createCompositionRouters(composition: AgentComposition) {
	const prInput = z.strictObject({ prId: IdSchema });
	const artifactInput = z.strictObject({ id: IdSchema, prId: IdSchema.optional() });
	return {
		agent: createAgentRouter(composition.service, composition.drafts),
		review: router({
			prepare: publicProcedure
				.input(prInput)
				.output(PRPreparationSchema)
				.mutation(({ input }) => composition.review.prepare(input.prId)),
			source: publicProcedure
				.input(SourceFileRequestSchema)
				.output(SourceFileSchema)
				.query(({ input }) => composition.review.source(input)),
			explainIntent: publicProcedure
				.input(
					z.strictObject({
						requestId: IdSchema,
						sessionId: IdSchema,
						screenContext: ScreenContextSchema,
						locations: z.array(CodeLocationSchema).min(1).max(30),
					})
				)
				.output(PRPreparationSchema)
				.mutation(({ input }) => composition.explainIntent(input)),
			codeContext: publicProcedure
				.input(
					z.strictObject({
						prId: IdSchema,
						changed: z.array(CodeLocationSchema).min(1).max(100),
						paths: z.array(RepositoryPathSchema).max(1000),
					})
				)
				.output(DiagramSpecSchema)
				.mutation(
					async ({ input }) =>
						(await composition.review.codeContext(input.prId, input.changed, input.paths)).diagram
				),
		}),
		artifacts: router({
			getScenario: publicProcedure
				.input(artifactInput)
				.output(ScenarioTraceSchema)
				.query(({ input }) => composition.catalog.getScenario(input.id, input.prId)),
			getPreview: publicProcedure
				.input(artifactInput)
				.output(PreviewSchema)
				.query(({ input }) => composition.catalog.getPreview(input.id, input.prId)),
			getDiagram: publicProcedure
				.input(artifactInput)
				.output(DiagramSpecSchema)
				.query(({ input }) => composition.catalog.getDiagram(input.id, input.prId)),
			list: publicProcedure
				.input(prInput)
				.output(CatalogSnapshotSchema)
				.query(({ input }) => composition.catalog.available(input.prId)),
		}),
	};
}
