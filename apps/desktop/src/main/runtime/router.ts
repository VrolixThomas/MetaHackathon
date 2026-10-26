import { z } from "zod";
import {
	IdSchema,
	PreviewSchema,
	PullRequestSchema,
	RepositoryPathSchema,
	RevisionSchema,
	ScenarioTraceSchema,
} from "../../shared/contracts";
import { publicProcedure, router } from "../trpc";
import { credentialProviders } from "./credentials";
import type { RuntimeService } from "./service";

/** Integration registers this factory's result in the root router after app.whenReady(). */
export function createRuntimeRouter(getRuntime: () => RuntimeService) {
	return router({
		credentialStatus: publicProcedure.query(() => getRuntime().credentials.status()),
		setCredential: publicProcedure
			.input(
				z.strictObject({
					provider: z.enum(credentialProviders),
					secret: z.string().trim().min(1).max(16_384),
				})
			)
			.mutation(async ({ input }) => {
				await getRuntime().credentials.set(input.provider, input.secret);
				return getRuntime().credentials.status();
			}),
		deleteCredential: publicProcedure
			.input(z.strictObject({ provider: z.enum(credentialProviders) }))
			.mutation(async ({ input }) => {
				await getRuntime().credentials.delete(input.provider);
				return getRuntime().credentials.status();
			}),
		githubSignIn: publicProcedure.mutation(() => getRuntime().github.importGhToken()),
		githubAccount: publicProcedure.query(() => getRuntime().github.account()),
		reviewRequests: publicProcedure
			.output(z.array(PullRequestSchema))
			.query(() => getRuntime().github.reviewRequests()),
		prepareDemo: publicProcedure
			.output(z.array(PullRequestSchema))
			.mutation(() => getRuntime().prepareDemo()),
		changedFiles: publicProcedure
			.input(z.strictObject({ prId: IdSchema }))
			.output(z.array(RepositoryPathSchema))
			.query(({ input }) => getRuntime().changedFiles(input.prId)),
		source: publicProcedure
			.input(
				z.strictObject({ prId: IdSchema, revision: RevisionSchema, path: RepositoryPathSchema })
			)
			.query(({ input }) => getRuntime().source(input.prId, input.revision, input.path)),
		diff: publicProcedure
			.input(z.strictObject({ prId: IdSchema, path: RepositoryPathSchema }))
			.query(({ input }) => getRuntime().diff(input.prId, input.path)),
		runScenario: publicProcedure
			.input(
				z.strictObject({
					requestId: IdSchema,
					prId: IdSchema,
					scenarioId: z.enum(["A", "B", "C", "D"]),
				})
			)
			.output(
				z.object({
					trace: ScenarioTraceSchema,
					results: z.object({ base: z.unknown(), head: z.unknown() }),
				})
			)
			.mutation(({ input }) =>
				getRuntime().runScenario(input.requestId, input.prId, input.scenarioId)
			),
		startPreview: publicProcedure
			.input(
				z.strictObject({ requestId: IdSchema, prId: IdSchema, mode: z.enum(["phone", "desktop"]) })
			)
			.output(PreviewSchema)
			.mutation(({ input }) => getRuntime().startPreview(input.requestId, input.prId, input.mode)),
		stopPreview: publicProcedure
			.input(z.strictObject({ id: IdSchema }))
			.mutation(async ({ input }) => {
				await getRuntime().stopPreview(input.id);
				return { stopped: true };
			}),
		cancel: publicProcedure
			.input(z.strictObject({ requestId: IdSchema }))
			.mutation(({ input }) => getRuntime().cancel(input.requestId)),
	});
}
