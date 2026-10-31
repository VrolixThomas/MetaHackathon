import { z } from "zod";
import {
	CodeLocationSchema,
	CommitShaSchema,
	type ConfirmCommentInput,
	ConfirmCommentInputSchema,
	DraftedCommentSchema,
	IdSchema,
} from "../../shared/contracts";

export type PRCommentCall = (
	type: "query" | "mutation",
	path: string,
	input?: unknown
) => Promise<unknown>;

// Integration owns the matching main boundary and shared-contract publication.
const CreateSchema = z.strictObject({
	requestId: IdSchema,
	prId: IdSchema,
	reviewId: IdSchema,
	headSha: CommitShaSchema,
	body: z.string().min(1).max(20000),
	location: CodeLocationSchema.optional(),
});
export type CreatePRComment = z.infer<typeof CreateSchema>;

export function createPRCommentApi(call: PRCommentCall) {
	return {
		create: async (input: CreatePRComment) =>
			DraftedCommentSchema.parse(
				await call("mutation", "prComments.create", CreateSchema.parse(input))
			),
		edit: async (draftId: string, body: string) =>
			DraftedCommentSchema.parse(
				await call(
					"mutation",
					"prComments.edit",
					z
						.strictObject({
							draftId: IdSchema,
							body: z.string().min(1).max(20000),
						})
						.parse({ draftId, body })
				)
			),
		confirm: async (input: ConfirmCommentInput) =>
			z
				.strictObject({ url: z.url() })
				.parse(
					await call("mutation", "prComments.confirm", ConfirmCommentInputSchema.parse(input))
				),
		cancel: async (requestId: string) => {
			await call(
				"mutation",
				"prComments.cancel",
				z.strictObject({ requestId: IdSchema }).parse({ requestId })
			);
		},
	};
}
export type PRCommentApi = ReturnType<typeof createPRCommentApi>;
