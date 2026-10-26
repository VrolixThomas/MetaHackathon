import { z } from "zod";
import { AgentActionSchema, TurnIdentitySchema } from "../../shared/contracts";

const fields = { ...TurnIdentitySchema.shape, sequence: z.int().positive() };
export const AgentEventSchema = z.discriminatedUnion("kind", [
	z.strictObject({ ...fields, kind: z.literal("acknowledgement"), text: z.string() }),
	z.strictObject({ ...fields, kind: z.literal("text-delta"), delta: z.string() }),
	z.strictObject({ ...fields, kind: z.literal("action"), action: AgentActionSchema }),
	z.strictObject({ ...fields, kind: z.literal("completed") }),
	z.strictObject({ ...fields, kind: z.literal("cancelled") }),
	z.strictObject({ ...fields, kind: z.literal("error"), message: z.string() }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;
export const StartTurnResultSchema = TurnIdentitySchema.extend({
	status: z.enum(["running", "completed", "cancelled", "error"]),
});
export const PollTurnResultSchema = TurnIdentitySchema.extend({
	status: z.enum(["running", "completed", "cancelled", "error", "stale"]),
	sequence: z.int().nonnegative(),
	events: z.array(AgentEventSchema),
	text: z.string(),
	actions: z.array(AgentActionSchema),
});
