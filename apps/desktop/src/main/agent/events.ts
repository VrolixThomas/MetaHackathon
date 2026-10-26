import { AgentTurnStatusSchema, TurnIdentitySchema } from "../../shared/contracts";

export { AgentEventSchema, type AgentEvent, PollTurnResultSchema } from "../../shared/contracts";
export const StartTurnResultSchema = TurnIdentitySchema.extend({
	status: AgentTurnStatusSchema,
});
