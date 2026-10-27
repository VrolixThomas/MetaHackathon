import { z } from "zod";

// Voice ID is a public provider identifier, not a credential. API keys stay in CredentialStore.
export const VoiceSetupInputSchema = z.strictObject({ voiceId: z.string().trim().min(1).max(200) });
export const VoiceSetupStatusSchema = z.strictObject({
	phase: z.enum(["unconfigured", "stopped", "preparing", "ready", "error"]),
	voiceId: z.string().max(200).nullable(),
	missing: z.array(z.enum(["meta", "elevenlabs", "voiceId", "executable"])),
	error: z.string().max(500).optional(),
});
export type VoiceSetupInput = z.infer<typeof VoiceSetupInputSchema>;
export type VoiceSetupStatus = z.infer<typeof VoiceSetupStatusSchema>;
