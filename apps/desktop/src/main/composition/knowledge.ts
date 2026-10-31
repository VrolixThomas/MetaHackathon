import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { ChatMessageSchema } from "../../shared/contracts/chat";
import {
	ActorSchema,
	type AuthorizationSnapshot,
	KnowledgeAccessError,
	type KnowledgeAuthorizationPort,
	KnowledgeService,
	type KnowledgeSource,
	type KnowledgeStorePort,
	type KnowledgeTransaction,
	SourceRefSchema,
	SourceSchema,
	chatSourceId,
} from "../knowledge";
import { sourceShapeAllowed } from "../knowledge/policy";
import type { SlackClient } from "../slack/client";
import {
	type SlackCredential,
	SlackCredentialSchema,
	SlackIdSchema,
	SlackTsSchema,
} from "../slack/types";

const Id = ActorSchema.shape.userId;
const DirectorySchema = z.strictObject({
	memberUserIds: z.array(Id).max(512),
	agentOwners: z.array(z.strictObject({ agentId: Id, userId: Id })).max(256),
});
export type KnowledgeDirectorySnapshot = z.infer<typeof DirectorySchema>;
export interface KnowledgeDirectoryPort {
	/** Root authority, not caller assertions. Include current members among resolved agent owners. */
	resolveDirectory(
		workspaceId: string,
		userIds: string[],
		agentIds: string[]
	): Promise<KnowledgeDirectorySnapshot>;
}
export interface KnowledgeCompositionOptions {
	store: KnowledgeStorePort;
	/** Real sourceMessage guarantees complete fresh membership or rejects; never a captured-row client. */
	client: Pick<SlackClient, "sourceMessage" | "credential">;
	getCredential(): Promise<SlackCredential | undefined>;
	/** Synchronous monotonic root generation for account/service/directory/ACL invalidation; never reuse. */
	getEpoch(): string | number;
	directory: KnowledgeDirectoryPort;
}
const RequestSchema = z.strictObject({
	workspaceId: Id,
	userIds: z.array(Id).max(256),
	agentIds: z.array(Id).max(256),
	sources: z.array(SourceRefSchema).max(10_000),
});
const unique = (ids: string[]) => [...new Set(ids)].sort();
const requireAccess = (condition: unknown): void => {
	if (!condition) throw new KnowledgeAccessError();
};
function canonical(value: unknown): string {
	return JSON.stringify(value, (_key, row) =>
		row && typeof row === "object" && !Array.isArray(row)
			? Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)))
			: row
	);
}
function credentialIdentity(credential: SlackCredential) {
	return [
		credential.connectionId,
		credential.workspaceId,
		credential.userId,
		credential.appId,
		credential.tokenKind,
		unique(credential.scopes),
	];
}

/**
 * Main-only factory. Root binds authenticated actors and publishes independently verified
 * source heads into the durable store. This never registers actors or ingests model text.
 */
export function createKnowledgeService(options: KnowledgeCompositionOptions): KnowledgeService {
	const { store, client, getCredential, getEpoch, directory } = options;
	const sealKey = randomBytes(32); // Per-instance authentication, never a grant cache.
	let active: { workspaceId: string; tx: KnowledgeTransaction } | null = null;
	const epoch = () => {
		const value = getEpoch();
		requireAccess(
			(typeof value === "string" && value.length > 0) ||
				(typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
		);
		return value;
	};
	const heads = (tx: KnowledgeTransaction, workspaceId: string, ids: string[]) =>
		unique(ids).map((id) => {
			const source = SourceSchema.parse(tx.getSource(id));
			requireAccess(
				source.workspaceId === workspaceId && source.sourceId === id && sourceShapeAllowed(source)
			);
			return source;
		});
	const seal = (
		snapshot: Omit<AuthorizationSnapshot, "fence">,
		sources: KnowledgeSource[],
		generation: string | number
	) =>
		createHmac("sha256", sealKey)
			.update(canonical({ snapshot, sources, generation }))
			.digest("hex");
	const readDirectory = async (workspaceId: string, userIds: string[], agentIds: string[]) => {
		const result = DirectorySchema.parse(
			await directory.resolveDirectory(workspaceId, [...userIds], [...agentIds])
		);
		requireAccess(
			new Set(result.agentOwners.map((owner) => owner.agentId)).size ===
				result.agentOwners.length &&
				result.agentOwners.every((owner) => agentIds.includes(owner.agentId))
		);
		const requested = new Set([...userIds, ...result.agentOwners.map((owner) => owner.userId)]);
		requireAccess(result.memberUserIds.every((id) => requested.has(id)));
		return {
			memberUserIds: unique(result.memberUserIds),
			agentOwners: result.agentOwners.sort((a, b) => a.agentId.localeCompare(b.agentId)),
		};
	};
	const authorization: KnowledgeAuthorizationPort = {
		async resolve(value) {
			try {
				// Capture BEFORE any await; a late response cannot adopt a newer root generation.
				const generation = epoch();
				const current = () => requireAccess(Object.is(epoch(), generation));
				const request = RequestSchema.parse(value);
				const userIds = unique(request.userIds);
				const agentIds = unique(request.agentIds);
				const directoryBefore = await readDirectory(request.workspaceId, userIds, agentIds);
				current();
				const sourceIds = unique(request.sources.map((source) => source.sourceId));
				const sources = await store.transaction(request.workspaceId, (tx) =>
					heads(tx, request.workspaceId, sourceIds)
				);
				current();
				const hasSlack = sources.some((source) => source.kind !== "private-note");
				const credentials = async () => {
					const root = SlackCredentialSchema.parse(await getCredential());
					current();
					const service = SlackCredentialSchema.parse(await client.credential());
					current();
					requireAccess(
						root.workspaceId === request.workspaceId &&
							isDeepStrictEqual(credentialIdentity(root), credentialIdentity(service))
					);
					return credentialIdentity(root);
				};
				const identityBefore = hasSlack ? await credentials() : null;
				current();
				const grants: AuthorizationSnapshot["sources"] = [];
				for (const source of sources) {
					let readableUserIds: string[] = [];
					if (source.state === "active") {
						if (source.kind === "private-note") {
							readableUserIds = directoryBefore.memberUserIds.filter(
								(id) => id === source.ownerUserId
							);
						} else {
							const citation = source.citation;
							if (!citation) throw new KnowledgeAccessError();
							// Only persisted Slack identity reaches the fixed-origin provider client, never a URL.
							SlackIdSchema.parse(citation.source.workspaceId);
							SlackIdSchema.parse(citation.source.conversationId);
							SlackTsSchema.parse(citation.source.messageId);
							SlackTsSchema.parse(citation.source.revisionId);
							if (citation.source.threadId) SlackTsSchema.parse(citation.source.threadId);
							const fresh = ChatMessageSchema.parse(await client.sourceMessage(citation.source));
							current();
							requireAccess(
								!fresh.deletedAt &&
									!fresh.truncated &&
									chatSourceId(fresh.citation.source) === source.sourceId &&
									fresh.citation.source.revisionId === source.revision &&
									fresh.citation.source.threadId === citation.source.threadId &&
									fresh.citation.audience.visibility === citation.audience.visibility &&
									fresh.text === source.text &&
									fresh.authorId === source.authorUserId
							);
							const readers = new Set(fresh.citation.audience.readerIds);
							readableUserIds = directoryBefore.memberUserIds.filter(
								(id) =>
									readers.has(id) &&
									(source.audience.kind === "workspace" || source.audience.userIds.includes(id))
							);
						}
					}
					const { text: _text, observedAt: _observedAt, ...metadata } = source;
					grants.push({ ...metadata, readableUserIds });
				}
				const directoryAfter = await readDirectory(request.workspaceId, userIds, agentIds);
				current();
				requireAccess(isDeepStrictEqual(directoryBefore, directoryAfter));
				const snapshot = { workspaceId: request.workspaceId, ...directoryBefore, sources: grants };
				const fence = await store.transaction(request.workspaceId, (tx) => {
					current();
					requireAccess(isDeepStrictEqual(sources, heads(tx, request.workspaceId, sourceIds)));
					return seal(snapshot, sources, generation);
				});
				current();
				if (hasSlack) requireAccess(isDeepStrictEqual(identityBefore, await credentials()));
				current();
				return { ...snapshot, fence };
			} catch {
				throw new KnowledgeAccessError();
			}
		},
		isCurrent(snapshot) {
			try {
				if (
					!active ||
					active.workspaceId !== snapshot.workspaceId ||
					!/^[a-f0-9]{64}$/.test(snapshot.fence)
				)
					return false;
				const { fence, ...data } = snapshot;
				const sources = heads(
					active.tx,
					snapshot.workspaceId,
					snapshot.sources.map((source) => source.sourceId)
				);
				const expected = seal(data, sources, epoch());
				return timingSafeEqual(Buffer.from(fence, "hex"), Buffer.from(expected, "hex"));
			} catch {
				return false;
			}
		},
	};
	const guardedStore: KnowledgeStorePort = {
		transaction(workspaceId, run) {
			return store.transaction(workspaceId, (tx) => {
				const previous = active;
				active = { workspaceId, tx };
				try {
					return run(tx);
				} finally {
					active = previous;
				}
			});
		},
	};
	return new KnowledgeService({ store: guardedStore, authorization });
}
