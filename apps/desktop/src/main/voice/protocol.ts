import { z } from "zod";
import { TurnIdentitySchema, VoiceDiagnosticSchema } from "../../shared/contracts";

/** Voice-owned transport contract; no credentials cross this boundary. */
export const VoiceOfferSchema = TurnIdentitySchema.extend({
	sdp: z.string().min(1).max(100_000),
	type: z.literal("offer"),
	keywords: z.array(z.string().min(1).max(100)).max(100).default([]),
});
export const VoiceAnswerSchema = z.strictObject({
	sdp: z.string().min(1).max(100_000),
	type: z.literal("answer"),
});
export const SpeakSchema = TurnIdentitySchema.extend({
	speechId: z.string().min(1).max(200),
	text: z.string().min(1).max(4000),
});
const eventFields = { ...TurnIdentitySchema.shape, sequence: z.int().positive() };
export const VoiceEventSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		...eventFields,
		kind: z.literal("transcript"),
		text: z.string().max(32000),
		final: z.boolean(),
	}),
	z.strictObject({ ...eventFields, kind: z.literal("speech-started"), speechId: z.string() }),
	z.strictObject({ ...eventFields, kind: z.literal("speech-ended"), speechId: z.string() }),
	z.strictObject({
		...eventFields,
		kind: z.literal("error"),
		message: z.string().max(500),
		diagnostic: VoiceDiagnosticSchema.optional(),
	}),
]);
export const VoicePollSchema = TurnIdentitySchema.extend({ afterSequence: z.int().nonnegative() });
export const VoicePollResultSchema = z.strictObject({ events: z.array(VoiceEventSchema).max(100) });
export type VoiceOffer = z.infer<typeof VoiceOfferSchema>;
export type VoiceAnswer = z.infer<typeof VoiceAnswerSchema>;
export type SpeakInput = z.infer<typeof SpeakSchema>;
export type VoiceEvent = z.infer<typeof VoiceEventSchema>;
export type VoicePoll = z.infer<typeof VoicePollSchema>;
export type VoicePollResult = z.infer<typeof VoicePollResultSchema>;
