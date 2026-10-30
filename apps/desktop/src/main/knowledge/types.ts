import { z } from "zod";

// Provisional main-only schemas. Root owns migration to shared IPC contracts.
const Id = z.string().trim().min(1).max(256);
const Text = z.string().min(1).max(16_384);
const Time = z.iso.datetime();
export const SourceRefSchema = z.object({ sourceId: Id, revision: Id }).strict();
export type SourceRef = z.infer<typeof SourceRefSchema>;
export const ActorSchema = z.object({ workspaceId: Id, userId: Id, agentId: Id }).strict();
export type KnowledgeActor = z.infer<typeof ActorSchema>;
export const ScopeSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("company") }).strict(),
	z.object({ kind: z.literal("private"), ownerUserId: Id }).strict(),
]);
export type KnowledgeScope = z.infer<typeof ScopeSchema>;
export const AudienceSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("workspace") }).strict(),
	z.object({ kind: z.literal("users"), userIds: z.array(Id).min(1).max(256) }).strict(),
]);
export const SourceKindSchema = z.enum([
	"slack-public-channel",
	"slack-private-channel",
	"slack-dm",
	"private-note",
]);
export const SourceSchema = z
	.object({
		workspaceId: Id,
		sourceId: Id,
		revision: Id,
		// Connector-assigned monotonic sequence, including ACL changes/tombstones.
		sequence: z.number().int().positive(),
		kind: SourceKindSchema,
		containerId: Id,
		authorUserId: Id,
		ownerUserId: Id.nullable(),
		audience: AudienceSchema,
		observedAt: Time,
		state: z.enum(["active", "deleted", "revoked"]),
		text: Text.nullable(),
	})
	.strict();
export type KnowledgeSource = z.infer<typeof SourceSchema>;
const Refs = z.array(SourceRefSchema).min(1).max(32);
export const FactInputSchema = z
	.object({
		id: Id,
		scope: ScopeSchema,
		category: z.enum(["decision", "intent", "convention", "ownership", "commitment", "other"]),
		text: Text,
		basis: z.discriminatedUnion("kind", [
			z.object({ kind: z.literal("recorded"), source: SourceRefSchema }).strict(),
			z.object({ kind: z.literal("inferred"), explanation: Text }).strict(),
		]),
		sources: Refs,
		parentFactIds: z.array(Id).max(32),
		supersedes: z.array(Id).max(32),
		contradicts: z.array(Id).max(32),
	})
	.strict();
export type FactInput = z.infer<typeof FactInputSchema>;
export const FactSchema = FactInputSchema.extend({
	workspaceId: Id,
	createdBy: ActorSchema,
	createdAt: Time,
	// Computed union of source and all fact dependencies; never caller-selected ACL.
	sources: Refs,
}).strict();
export type KnowledgeFact = z.infer<typeof FactSchema>;
export const SearchInputSchema = z
	.object({
		scope: ScopeSchema,
		text: z.string().min(1).max(256),
		limit: z.number().int().min(1).max(50).default(20),
	})
	.strict();
export type SearchInput = z.input<typeof SearchInputSchema>;
export const MessageInputSchema = z
	.object({
		requestId: Id,
		recipientAgentId: Id,
		text: Text,
		sources: Refs,
		parentFactIds: z.array(Id).max(32),
	})
	.strict();
export type MessageInput = z.infer<typeof MessageInputSchema>;
export const MessageSchema = MessageInputSchema.extend({
	id: Id,
	workspaceId: Id,
	sender: ActorSchema,
	recipientUserId: Id,
	createdAt: Time,
	contentRole: z.literal("untrusted-evidence"),
	payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type DirectAgentMessage = z.infer<typeof MessageSchema>;
export type AdmissionResult =
	| { status: "admitted"; messageId: string }
	| { status: "rejected"; reason: "not-authorized" | "request-conflict" };
export interface AdmissionAudit {
	workspaceId: string;
	sender: KnowledgeActor;
	requestId: string;
	recipientAgentId: string;
	at: string;
	result: AdmissionResult;
	// Hash only: a rejected attempt must not persist the submitted private text.
	payloadDigest: string;
}

export interface KnowledgeCitation extends SourceRef {
	kind: KnowledgeSource["kind"];
	containerId: string;
	authorUserId: string;
	observedAt: string;
}

export interface KnowledgeFactView {
	fact: KnowledgeFact;
	citations: KnowledgeCitation[];
}
