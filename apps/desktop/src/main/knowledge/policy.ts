import { chatSourceId } from "./chat-source";
import type { AuthorizationSnapshot } from "./ports";
import type { KnowledgeActor, KnowledgeScope, KnowledgeSource, SourceRef } from "./types";

export class KnowledgeAccessError extends Error {
	constructor() {
		super("Knowledge access denied");
		this.name = "KnowledgeAccessError";
	}
}

export function requireAccess(condition: unknown): asserts condition {
	if (!condition) throw new KnowledgeAccessError();
}

export function sameScope(a: KnowledgeScope, b: KnowledgeScope): boolean {
	return (
		a.kind === b.kind &&
		(a.kind === "company" || (b.kind === "private" && a.ownerUserId === b.ownerUserId))
	);
}

export function actorAllowed(actor: KnowledgeActor, auth: AuthorizationSnapshot): boolean {
	const owners = auth.agentOwners.filter((owner) => owner.agentId === actor.agentId);
	return (
		auth.workspaceId === actor.workspaceId &&
		auth.memberUserIds.includes(actor.userId) &&
		owners.length === 1 &&
		owners[0]?.userId === actor.userId
	);
}

export function scopeAllowed(scope: KnowledgeScope, userIds: string[]): boolean {
	return scope.kind === "company" || userIds.every((id) => id === scope.ownerUserId);
}

export function sourceShapeAllowed(source: KnowledgeSource): boolean {
	if ((source.state === "active") !== (source.text !== null)) return false;
	if (source.citation) {
		const { source: identity, audience } = source.citation;
		if (
			source.kind === "private-note" ||
			source.sourceId !== chatSourceId(identity) ||
			source.workspaceId !== identity.workspaceId ||
			source.containerId !== identity.conversationId ||
			source.revision !== identity.revisionId ||
			source.observedAt !== audience.observedAt ||
			(source.kind === "slack-public-channel" && audience.visibility !== "public_channel") ||
			(source.kind === "slack-private-channel" && audience.visibility !== "private_channel") ||
			(source.kind === "slack-dm" &&
				audience.visibility !== "direct_message" &&
				audience.visibility !== "group_direct_message") ||
			(source.audience.kind === "users" &&
				JSON.stringify([...new Set(source.audience.userIds)].sort()) !==
					JSON.stringify([...new Set(audience.readerIds)].sort()))
		)
			return false;
	}
	if (source.kind === "slack-public-channel")
		return source.audience.kind === "workspace" && source.ownerUserId === null;
	if (source.audience.kind !== "users") return false;
	if (source.kind === "private-note")
		return source.ownerUserId !== null && source.audience.userIds.includes(source.ownerUserId);
	return source.ownerUserId === null;
}

export function sameSourceAuthority(
	a: Omit<KnowledgeSource, "text" | "observedAt">,
	b: Omit<KnowledgeSource, "text" | "observedAt">
): boolean {
	return (
		a.workspaceId === b.workspaceId &&
		a.sourceId === b.sourceId &&
		a.revision === b.revision &&
		a.sequence === b.sequence &&
		a.state === b.state &&
		a.kind === b.kind &&
		a.containerId === b.containerId &&
		a.authorUserId === b.authorUserId &&
		a.ownerUserId === b.ownerUserId &&
		a.audience.kind === b.audience.kind &&
		(a.audience.kind === "workspace" ||
			(b.audience.kind === "users" &&
				JSON.stringify([...new Set(a.audience.userIds)].sort()) ===
					JSON.stringify([...new Set(b.audience.userIds)].sort())))
	);
}

export function sourceAllowed(
	source: KnowledgeSource,
	ref: SourceRef,
	userIds: string[],
	auth: AuthorizationSnapshot,
	scope?: KnowledgeScope
): boolean {
	const live = auth.sources.filter((candidate) => candidate.sourceId === ref.sourceId);
	if (
		live.length !== 1 ||
		!live[0] ||
		!sameSourceAuthority(source, live[0]) ||
		!userIds.every((userId) => live[0]?.readableUserIds.includes(userId)) ||
		source.workspaceId !== auth.workspaceId ||
		source.sourceId !== ref.sourceId ||
		source.revision !== ref.revision ||
		source.state !== "active" ||
		!sourceShapeAllowed(source) ||
		!userIds.every((userId) => auth.memberUserIds.includes(userId)) ||
		(scope && !scopeAllowed(scope, userIds))
	)
		return false;
	if (scope?.kind === "company" && source.kind !== "slack-public-channel") return false;
	return userIds.every(
		(userId) =>
			(source.ownerUserId === null || source.ownerUserId === userId) &&
			(source.audience.kind === "workspace" || source.audience.userIds.includes(userId))
	);
}

/** One source cannot be pinned to two revisions. All dependency edges are restrictive. */
export function unionSources(...groups: SourceRef[][]): SourceRef[] {
	const refs = new Map<string, SourceRef>();
	for (const group of groups) {
		for (const ref of group) {
			const previous = refs.get(ref.sourceId);
			requireAccess(!previous || previous.revision === ref.revision);
			refs.set(ref.sourceId, { ...ref });
		}
	}
	requireAccess(refs.size > 0 && refs.size <= 30);
	return [...refs.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId));
}
