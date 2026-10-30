import { createHash } from "node:crypto";
import { ChatMessageSchema, type ChatSource, ChatSourceSchema } from "../../shared/contracts/chat";
import { type KnowledgeSource, SourceSchema } from "./types";

/** Stable app-local key derived from the complete provider message identity. */
export function chatSourceId(value: ChatSource): string {
	const source = ChatSourceSchema.parse(value);
	const identity = [source.provider, source.workspaceId, source.conversationId, source.messageId];
	return `slack:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

/** Capture adapter only: applySource still requires independent current authorization. */
export function sourceFromChatMessage(value: unknown, sequence: number): KnowledgeSource {
	const message = ChatMessageSchema.parse(value);
	const { source, audience } = message.citation;
	if (message.truncated)
		throw new Error("Truncated Slack text cannot become a complete knowledge source");
	const kind =
		audience.visibility === "public_channel"
			? "slack-public-channel"
			: audience.visibility === "private_channel"
				? "slack-private-channel"
				: "slack-dm";
	return SourceSchema.parse({
		workspaceId: source.workspaceId,
		sourceId: chatSourceId(source),
		revision: source.revisionId,
		sequence,
		kind,
		containerId: source.conversationId,
		authorUserId: message.authorId,
		ownerUserId: null,
		audience:
			audience.visibility === "public_channel"
				? { kind: "workspace" }
				: { kind: "users", userIds: audience.readerIds },
		observedAt: audience.observedAt,
		state: message.deletedAt ? "deleted" : "active",
		text: message.deletedAt ? null : message.text,
		citation: message.citation,
	});
}
