import { z } from "zod";
import {
	type ConfirmCommentInput,
	ConfirmCommentInputSchema,
	DraftedCommentSchema,
	IdSchema,
	PRCommentCreateInputSchema,
	PRCommentEditInputSchema,
} from "../../shared/contracts";

export type PRCommentCall = (
	type: "query" | "mutation",
	path: string,
	input?: unknown
) => Promise<unknown>;

// Integration owns the matching main boundary and shared-contract publication.
const CreateSchema = PRCommentCreateInputSchema;
export type CreatePRComment = z.infer<typeof CreateSchema>;

export function createPRCommentApi(call: PRCommentCall) {
	return {
		create: async (input: CreatePRComment) =>
			DraftedCommentSchema.parse(
				await call("mutation", "prComments.create", CreateSchema.parse(input))
			),
		edit: async (draftId: string, body: string) =>
			DraftedCommentSchema.parse(
				await call("mutation", "prComments.edit", PRCommentEditInputSchema.parse({ draftId, body }))
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
