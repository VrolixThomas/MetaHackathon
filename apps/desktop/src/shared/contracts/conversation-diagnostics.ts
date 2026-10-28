import { z } from "zod";
import { TurnIdentitySchema } from "./interaction";
import { VoiceDiagnosticSchema } from "./voice-diagnostics";

/** Local timing metadata only: no utterances, model output, source, URLs or credentials. */
export const ConversationDiagnosticSchema = z.strictObject({
	stage: z.enum([
		"speech-start",
		"speech-ended",
		"transcript-final",
		"agent-start",
		"first-answer",
		"first-audio",
		"turn-completed",
		"turn-cancelled",
		"turn-failed",
		"renderer-error",
	]),
	turn: TurnIdentitySchema.optional(),
	elapsedMs: z.number().nonnegative().max(3_600_000).optional(),
	releaseToAudioMs: z.number().nonnegative().max(3_600_000).optional(),
	failureSource: z.enum(["agent", "voice", "unknown"]).optional(),
	diagnostic: VoiceDiagnosticSchema.optional(),
});
export type ConversationDiagnostic = z.infer<typeof ConversationDiagnosticSchema>;
