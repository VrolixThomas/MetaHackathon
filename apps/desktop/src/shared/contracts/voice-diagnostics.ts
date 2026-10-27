import { z } from "zod";

/** Fixed categories only: never carry provider bodies, URLs, audio, transcripts or credentials. */
export const VoiceDiagnosticSchema = z.strictObject({
	stage: z.enum(["microphone", "media", "setup", "meta", "elevenlabs"]),
	code: z.enum([
		"denied",
		"not-found",
		"busy",
		"auth",
		"access",
		"rate-limit",
		"unavailable",
		"network",
		"timeout",
		"protocol",
		"failed",
	]),
	httpStatus: z.int().min(100).max(599).optional(),
	closeCode: z.int().min(1000).max(4999).optional(),
});
export type VoiceDiagnostic = z.infer<typeof VoiceDiagnosticSchema>;
