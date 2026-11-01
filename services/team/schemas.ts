import { z } from "zod";
// Public wire contracts are integration-owned. Session credentials remain main/server-only.
export * from "../../apps/desktop/src/shared/contracts/team";
export const SessionSchema = z.object({
	access_token: z.string().min(1).max(32768),
	refresh_token: z.string().min(1).max(32768),
	expires_at: z.int().positive(),
	user: z.object({ id: z.uuid() }),
});
export type TeamSession = z.infer<typeof SessionSchema>;
