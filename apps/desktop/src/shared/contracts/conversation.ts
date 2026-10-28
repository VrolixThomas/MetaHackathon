import { z } from "zod";
import { IdSchema } from "./common";
import { TurnIdentitySchema } from "./interaction";
import { ReviewScreenSchema } from "./prepared-review";
import { PullRequestSchema } from "./review";
import { WorkspaceSnapshotSchema } from "./workspace";

/** V1 conversation needs no review. Review AgentTurnInput remains screen-bound. */
export const ConversationTurnInputSchema = z.strictObject({
	...TurnIdentitySchema.shape,
	requestId: IdSchema,
	text: z.string().trim().min(1).max(32_000),
	prId: IdSchema.optional(),
	screen: ReviewScreenSchema.optional(),
	workspace: WorkspaceSnapshotSchema.optional(),
});
export const ConversationPRContextSchema = z.strictObject({
	pr: PullRequestSchema,
	description: z.string().max(32_000),
	files: z
		.array(
			z.strictObject({
				path: z.string().min(1),
				status: z.string(),
				additions: z.int().nonnegative(),
				deletions: z.int().nonnegative(),
				patch: z.string().max(20_000).optional(),
			})
		)
		.max(100),
	truncated: z.boolean(),
});
export const MicrophoneStatusSchema = z.enum([
	"not-determined",
	"granted",
	"denied",
	"restricted",
	"unknown",
]);
export const AppConfigurationSchema = z.strictObject({
	envPath: z.string().min(1),
	configured: z.strictObject({ meta: z.boolean(), elevenlabs: z.boolean(), github: z.boolean() }),
	voiceId: z.string().nullable(),
	microphone: MicrophoneStatusSchema,
	error: z.string().max(300).optional(),
});
export type ConversationTurnInput = z.infer<typeof ConversationTurnInputSchema>;
export type ConversationPRContext = z.infer<typeof ConversationPRContextSchema>;
export type AppConfiguration = z.infer<typeof AppConfigurationSchema>;
