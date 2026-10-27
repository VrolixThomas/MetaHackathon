import { z } from "zod";
import { ScenarioRequestSchema } from "./artifacts";
import { BrowserStateSchema } from "./browser";
import { CodeLocationSchema, IdSchema } from "./common";
import { ReviewNavigationSchema, ReviewScreenSchema } from "./prepared-review";
import { DraftedCommentSchema } from "./review";

export const ScreenContextSchema = z.strictObject({
	prId: IdSchema,
	sequence: z.int().nonnegative(),
	panel: z.enum([
		"briefing",
		"diff",
		"why",
		"scenario",
		"diagram",
		"preview",
		"sign-off",
		"browser",
	]),
	focusedLocation: CodeLocationSchema.nullable(),
	artifactId: IdSchema.optional(),
	scenarioStepId: IdSchema.optional(),
	previewMarkerId: IdSchema.optional(),
	browser: BrowserStateSchema.optional(),
});
export const TurnIdentitySchema = z.strictObject({
	sessionId: IdSchema,
	turnId: IdSchema,
	generation: z.int().nonnegative(),
});
export const ScreenContextUpdateSchema = z.strictObject({
	sessionId: IdSchema,
	screenContext: ScreenContextSchema,
});
export const AgentActionReceiptSchema = z.strictObject({
	...TurnIdentitySchema.shape,
	requestId: IdSchema,
	status: z.enum(["applied", "ignored"]),
	screenContext: ScreenContextSchema,
});
export const AgentActionReceiptResultSchema = z.strictObject({
	status: z.enum(["accepted", "stale"]),
});
export const ConversationActionReceiptSchema = z.strictObject({
	...TurnIdentitySchema.shape,
	requestId: IdSchema,
	status: z.enum(["applied", "ignored"]),
	screen: ReviewScreenSchema,
});
export const AgentTurnInputSchema = z.strictObject({
	...TurnIdentitySchema.shape,
	requestId: IdSchema,
	text: z.string().min(1),
	screenContext: ScreenContextSchema,
});

const actionFields = {
	...TurnIdentitySchema.shape,
	requestId: IdSchema,
	screenSequence: z.int().nonnegative(),
};
export const AgentActionSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		...actionFields,
		kind: z.literal("review-navigation"),
		navigation: ReviewNavigationSchema,
	}),
	z.strictObject({ ...actionFields, kind: z.literal("show-browser"), browser: BrowserStateSchema }),
	z.strictObject({
		...actionFields,
		kind: z.literal("highlight-code"),
		location: CodeLocationSchema,
		note: z.string(),
	}),
	z.strictObject({ ...actionFields, kind: z.literal("show-scenario"), scenarioId: IdSchema }),
	z.strictObject({
		...actionFields,
		kind: z.literal("run-scenario"),
		request: ScenarioRequestSchema,
	}),
	z.strictObject({ ...actionFields, kind: z.literal("show-diagram"), diagramId: IdSchema }),
	z.strictObject({ ...actionFields, kind: z.literal("show-preview"), previewId: IdSchema }),
	z.strictObject({
		...actionFields,
		kind: z.literal("draft-comment"),
		draft: DraftedCommentSchema,
	}),
]);

export const VoiceStateSchema = z
	.strictObject({
		sessionId: IdSchema,
		turnId: IdSchema.nullable(),
		generation: z.int().nonnegative(),
		phase: z.enum([
			"idle",
			"listening",
			"transcribing",
			"thinking",
			"speaking",
			"cancelled",
			"error",
		]),
		transcript: z.string(),
		transcriptFinal: z.boolean(),
		error: z.string().min(1).optional(),
	})
	.refine(
		(state) =>
			(state.phase === "idle" || state.phase === "error" || state.turnId !== null) &&
			(state.phase !== "error" || state.error !== undefined),
		"Active voice states require a turn; error states require a message"
	);

export const CancelTurnInputSchema = z.strictObject({
	...TurnIdentitySchema.shape,
	requestId: IdSchema,
	reason: z.enum(["push-to-talk", "escape", "navigation", "shutdown", "user"]),
});
export const CancelTurnResultSchema = z.strictObject({
	...TurnIdentitySchema.shape,
	requestId: IdSchema,
	status: z.enum(["cancelled", "stale", "not-found"]),
});

export type ScreenContext = z.infer<typeof ScreenContextSchema>;
export type ScreenContextUpdate = z.infer<typeof ScreenContextUpdateSchema>;
export type AgentActionReceipt = z.infer<typeof AgentActionReceiptSchema>;
export type AgentActionReceiptResult = z.infer<typeof AgentActionReceiptResultSchema>;
export type ConversationActionReceipt = z.infer<typeof ConversationActionReceiptSchema>;
export type TurnIdentity = z.infer<typeof TurnIdentitySchema>;
export type AgentTurnInput = z.infer<typeof AgentTurnInputSchema>;
export type AgentAction = z.infer<typeof AgentActionSchema>;
export type VoiceState = z.infer<typeof VoiceStateSchema>;
export type CancelTurnInput = z.infer<typeof CancelTurnInputSchema>;
export type CancelTurnResult = z.infer<typeof CancelTurnResultSchema>;
