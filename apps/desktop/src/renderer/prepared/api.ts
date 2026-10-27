import { z } from "zod";
import {
	AgentActionReceiptResultSchema,
	type ConversationActionReceipt,
	ConversationActionReceiptSchema,
	GitHubRepositorySchema,
	IdSchema,
	RepositoryPathSchema,
	ReviewDetailSchema,
	ReviewFileRequestSchema,
	ReviewFileSchema,
	ReviewInboxSchema,
	ReviewProgressSchema,
	type ReviewScreen,
	ReviewScreenSchema,
} from "../../shared/contracts";
import type { ConversationApi } from "../conversation/api";

export function createPreparedApi(call: ConversationApi["call"]) {
	return {
		chooseRepository: async () =>
			z
				.strictObject({ repository: GitHubRepositorySchema, localPath: z.string().min(1) })
				.nullable()
				.parse(await call("mutation", "reviews.chooseRepository")),
		connect: async (repository: string, localPath?: string) =>
			ReviewInboxSchema.parse(
				await call("mutation", "reviews.connect", {
					repository: GitHubRepositorySchema.parse(repository.trim()),
					...(localPath ? { localPath } : {}),
				})
			),
		inbox: async () => ReviewInboxSchema.parse(await call("query", "reviews.inbox")),
		refresh: async () => ReviewInboxSchema.parse(await call("mutation", "reviews.refresh")),
		prepare: async (prId: string) =>
			ReviewDetailSchema.parse(
				await call("mutation", "reviews.prepare", { prId: IdSchema.parse(prId) })
			),
		get: async (prId: string) =>
			ReviewDetailSchema.parse(await call("query", "reviews.get", { prId: IdSchema.parse(prId) })),
		file: async (input: { prId: string; reviewId: string; path: string }) =>
			ReviewFileSchema.parse(
				await call("query", "reviews.file", ReviewFileRequestSchema.parse(input))
			),
		progress: async (input: { prId: string; reviewId: string; path: string; paused: boolean }) =>
			ReviewProgressSchema.parse(
				await call(
					"mutation",
					"reviews.progress",
					z
						.strictObject({
							prId: IdSchema,
							reviewId: IdSchema,
							path: RepositoryPathSchema,
							paused: z.boolean(),
						})
						.parse(input)
				)
			),
		screen: async (sessionId: string, screen: ReviewScreen) => {
			ReviewScreenSchema.parse(
				await call("mutation", "reviews.screen", {
					sessionId: IdSchema.parse(sessionId),
					screen: ReviewScreenSchema.parse(screen),
				})
			);
		},
		actionApplied: async (input: ConversationActionReceipt) =>
			AgentActionReceiptResultSchema.parse(
				await call(
					"mutation",
					"conversation.actionApplied",
					ConversationActionReceiptSchema.parse(input)
				)
			),
	};
}
export type PreparedApi = ReturnType<typeof createPreparedApi>;
