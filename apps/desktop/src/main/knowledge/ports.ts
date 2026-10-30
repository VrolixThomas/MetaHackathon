import type {
	AdmissionAudit,
	DirectAgentMessage,
	KnowledgeFact,
	KnowledgeScope,
	KnowledgeSource,
	SourceRef,
} from "./types";

export interface AuthorizationRequest {
	workspaceId: string;
	userIds: string[];
	agentIds: string[];
	sources: SourceRef[];
}

/** Bounded, current authority for only the requested identities. Unknown means denied. */
export interface AuthorizationSnapshot {
	workspaceId: string;
	memberUserIds: string[];
	agentOwners: { agentId: string; userId: string }[];
	sources: Omit<KnowledgeSource, "text" | "observedAt">[];
	// Opaque fence tied to account, membership, ownership and source/ACL generations.
	fence: string;
}

export interface KnowledgeAuthorizationPort {
	/** Must revalidate actual current membership/owner/source ACL, not reuse old grants. */
	resolve(request: AuthorizationRequest): Promise<AuthorizationSnapshot>;
	/** Synchronous final fence check inside the store transaction; false on uncertainty. */
	isCurrent(snapshot: AuthorizationSnapshot): boolean;
}

export interface FactQuery {
	scope: KnowledgeScope;
	// Literal case-sensitive substring, never SQL LIKE wildcards/regex/semantic search.
	text: string;
	limit: number;
}

/** All keys and queries are bound to the transaction's workspace, never global IDs. */
export interface KnowledgeTransaction {
	getSource(sourceId: string): KnowledgeSource | null;
	/** Replace current head; purge payloads on deleted/revoked and retain the fence. */
	putSource(source: KnowledgeSource): void;
	getFact(id: string): KnowledgeFact | null;
	insertFact(fact: KnowledgeFact): void;
	queryFacts(query: FactQuery): KnowledgeFact[];
	getMessageByRequest(senderAgentId: string, requestId: string): DirectAgentMessage | null;
	insertMessage(message: DirectAgentMessage): void;
	listMessages(recipientAgentId: string, limit: number): DirectAgentMessage[];
	appendAudit(audit: AdmissionAudit): void;
}

export interface KnowledgeStorePort {
	/**
	 * Durable serializable transaction. Invoke run synchronously against isolated data;
	 * commit in the same synchronous turn, roll back on throw, return detached values.
	 * Enforce unique workspace+fact ID and workspace+sender+message request ID.
	 * No process-memory/default fallback. SQLite adapter and migrations belong to root.
	 */
	transaction<T>(workspaceId: string, run: (tx: KnowledgeTransaction) => T): Promise<T>;
}

export interface KnowledgePorts {
	store: KnowledgeStorePort;
	authorization: KnowledgeAuthorizationPort;
	now?: () => string;
	id?: () => string;
}
