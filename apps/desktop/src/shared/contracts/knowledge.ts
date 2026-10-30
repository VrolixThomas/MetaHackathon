import { z } from "zod";
import { ChatCitationSchema } from "./chat";
import { DateTimeSchema, IdSchema } from "./common";

export const KnowledgeFactSchema = z
	.strictObject({
		id: IdSchema,
		revision: z.int().positive(),
		workspaceId: IdSchema,
		brain: z.enum(["private", "company"]),
		ownerUserId: IdSchema.nullable(),
		kind: z.enum(["decision", "intent", "convention", "ownership", "commitment", "context"]),
		title: z.string().min(1).max(300),
		text: z.string().min(1).max(12000),
		provenance: z.enum(["recorded", "inferred"]),
		explanation: z.string().max(4000),
		sources: z.array(ChatCitationSchema).min(1).max(30),
		state: z.enum(["active", "superseded", "retracted"]),
		supersededById: IdSchema.nullable(),
		createdAt: DateTimeSchema,
		updatedAt: DateTimeSchema,
	})
	.superRefine((row, ctx) => {
		const invalid = (message: string) => ctx.addIssue({ code: "custom", message });
		if (row.sources.some((c) => c.source.workspaceId !== row.workspaceId))
			invalid("Knowledge cannot cross workspace boundaries");
		if (row.brain === "private" && !row.ownerUserId) invalid("Private knowledge requires an owner");
		if (
			row.brain === "company" &&
			(row.ownerUserId !== null ||
				row.sources.some((c) => c.audience.visibility !== "public_channel"))
		)
			invalid("Company knowledge may use only public channel sources");
		if (row.provenance === "inferred" && !row.explanation.trim())
			invalid("Inferred knowledge requires an explanation");
	});
export const AgentCommunicationSchema = z
	.strictObject({
		id: IdSchema,
		workspaceId: IdSchema,
		fromUserId: IdSchema,
		toUserId: IdSchema,
		text: z.string().min(1).max(12000),
		sources: z.array(ChatCitationSchema).min(1).max(30),
		state: z.enum(["queued", "delivered", "rejected"]),
		createdAt: DateTimeSchema,
		deliveredAt: DateTimeSchema.nullable(),
	})
	.refine(
		(row) => row.sources.every((c) => c.source.workspaceId === row.workspaceId),
		"Agent communications cannot cross workspace source boundaries"
	);
export type KnowledgeFact = z.infer<typeof KnowledgeFactSchema>;
export type AgentCommunication = z.infer<typeof AgentCommunicationSchema>;
