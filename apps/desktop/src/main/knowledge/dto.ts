import { AgentCommunicationSchema, KnowledgeFactSchema } from "../../shared/contracts/knowledge";
import type { DirectAgentMessage, KnowledgeCitation, KnowledgeFactView } from "./types";

function citations(values: KnowledgeCitation[]) {
	return values.map((value) => {
		if (!value.citation)
			throw new Error("Knowledge source has no Slack citation; shared projection unavailable");
		return value.citation;
	});
}

/** Called only inside the service's final authorization fence. */
export function factDto(view: KnowledgeFactView) {
	const fact = view.fact;
	return KnowledgeFactSchema.parse({
		id: fact.id,
		revision: 1, // Immutable fact content, not a fabricated provider revision.
		workspaceId: fact.workspaceId,
		brain: fact.scope.kind,
		ownerUserId: fact.scope.kind === "private" ? fact.scope.ownerUserId : null,
		kind: fact.category,
		title: fact.title,
		text: fact.text,
		provenance: fact.basis.kind,
		explanation: fact.basis.kind === "inferred" ? fact.basis.explanation : "",
		sources: citations(view.citations),
		state: view.supersededByIds.length ? "superseded" : "active",
		supersededById: view.supersededByIds[0] ?? null,
		createdAt: fact.createdAt,
		updatedAt: view.updatedAt,
	});
}

/** Admission/inbox presence is queued evidence; it is not a delivery receipt. */
export function communicationDto(message: DirectAgentMessage, sources: KnowledgeCitation[]) {
	return AgentCommunicationSchema.parse({
		id: message.id,
		workspaceId: message.workspaceId,
		fromUserId: message.sender.userId,
		toUserId: message.recipientUserId,
		text: message.text,
		sources: citations(sources),
		state: "queued",
		createdAt: message.createdAt,
		deliveredAt: null,
	});
}
