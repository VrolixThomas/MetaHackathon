import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { communicationDto, factDto } from "./dto";
import {
	KnowledgeAccessError,
	actorAllowed,
	requireAccess,
	sameScope,
	sameSourceAuthority,
	scopeAllowed,
	sourceAllowed,
	sourceShapeAllowed,
	unionSources,
} from "./policy";
import type { AuthorizationSnapshot, KnowledgePorts, KnowledgeTransaction } from "./ports";
import {
	ActorSchema,
	type AdmissionResult,
	type DirectAgentMessage,
	FactInputSchema,
	FactSchema,
	type KnowledgeActor,
	type KnowledgeCitation,
	type KnowledgeFact,
	type KnowledgeFactView,
	type KnowledgeScope,
	MessageInputSchema,
	MessageSchema,
	SearchInputSchema,
	type SourceRef,
	SourceSchema,
} from "./types";

const AuthorizationSchema = z
	.object({
		workspaceId: z.string().min(1),
		memberUserIds: z.array(z.string().min(1)),
		agentOwners: z.array(
			z.object({ agentId: z.string().min(1), userId: z.string().min(1) }).strict()
		),
		sources: z.array(
			SourceSchema.omit({ text: true, observedAt: true })
				.extend({ readableUserIds: z.array(z.string().min(1)) })
				.strict()
		),
		fence: z.string().min(1),
	})
	.strict();
const unique = (ids: string[]) => [...new Set(ids)];
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class KnowledgeService {
	private readonly now: () => string;
	private readonly id: () => string;
	constructor(private readonly ports: KnowledgePorts) {
		this.now = ports.now ?? (() => new Date().toISOString());
		this.id = ports.id ?? randomUUID;
	}

	private async authorize(
		workspaceId: string,
		actors: KnowledgeActor[],
		refs: SourceRef[],
		extraAgentIds: string[] = []
	): Promise<AuthorizationSnapshot> {
		try {
			const auth = AuthorizationSchema.parse(
				await this.ports.authorization.resolve({
					workspaceId,
					userIds: unique(actors.map((actor) => actor.userId)),
					agentIds: unique([...actors.map((actor) => actor.agentId), ...extraAgentIds]),
					sources: refs,
				})
			);
			requireAccess(
				auth.workspaceId === workspaceId && actors.every((actor) => actorAllowed(actor, auth))
			);
			return auth;
		} catch {
			throw new KnowledgeAccessError();
		}
	}

	private fenced<T>(
		workspaceId: string,
		auth: AuthorizationSnapshot,
		run: (tx: KnowledgeTransaction) => T
	): Promise<T> {
		return this.ports.store.transaction(workspaceId, (tx) => {
			requireAccess(this.ports.authorization.isCurrent(auth));
			const result = run(tx);
			requireAccess(this.ports.authorization.isCurrent(auth));
			return structuredClone(result);
		});
	}

	private parents(
		tx: KnowledgeTransaction,
		workspaceId: string,
		ids: string[],
		scope?: KnowledgeScope
	): KnowledgeFact[] {
		return unique(ids).map((id) => {
			const value = tx.getFact(id);
			requireAccess(value);
			const fact = FactSchema.parse(value);
			requireAccess(
				fact.id === id &&
					fact.workspaceId === workspaceId &&
					(!scope || sameScope(scope, fact.scope))
			);
			return fact;
		});
	}

	private readable(
		tx: KnowledgeTransaction,
		refs: SourceRef[],
		users: string[],
		auth: AuthorizationSnapshot,
		scope?: KnowledgeScope
	): boolean {
		return refs.every((ref) => {
			const value = tx.getSource(ref.sourceId);
			if (!value) return false;
			const source = SourceSchema.parse(value);
			return sourceAllowed(source, ref, users, auth, scope);
		});
	}

	/** Trusted connector only. Tombstones retain their monotonic sequence; deleted IDs stay deleted. */
	async applySource(value: unknown): Promise<void> {
		const source = SourceSchema.parse(value);
		requireAccess(sourceShapeAllowed(source));
		const auth = await this.authorize(
			source.workspaceId,
			[],
			[{ sourceId: source.sourceId, revision: source.revision }]
		);
		const live = auth.sources.filter((candidate) => candidate.sourceId === source.sourceId);
		requireAccess(live.length === 1 && live[0] && sameSourceAuthority(source, live[0]));
		await this.fenced(source.workspaceId, auth, (tx) => {
			const previous = tx.getSource(source.sourceId);
			if (previous) {
				const head = SourceSchema.parse(previous);
				requireAccess(head.workspaceId === source.workspaceId && head.sourceId === source.sourceId);
				requireAccess(source.sequence >= head.sequence);
				if (source.sequence === head.sequence) {
					requireAccess(digest(source) === digest(head));
					return;
				}
				requireAccess(head.state !== "deleted" || source.state === "deleted");
				// A revision identifies exact source text; ACL-only updates cannot rewrite it.
				if (
					head.state === "active" &&
					source.state === "active" &&
					head.revision === source.revision
				)
					requireAccess(head.text === source.text);
			}
			tx.putSource(source);
		});
	}

	async recordFact(actorValue: unknown, value: unknown): Promise<KnowledgeFact> {
		const actor = ActorSchema.parse(actorValue);
		const input = FactInputSchema.parse(value);
		requireAccess(scopeAllowed(input.scope, [actor.userId]));
		const parentIds = unique([...input.parentFactIds, ...input.supersedes, ...input.contradicts]);
		requireAccess(!parentIds.includes(input.id));
		const parents = await this.ports.store.transaction(actor.workspaceId, (tx) =>
			this.parents(tx, actor.workspaceId, parentIds, input.scope)
		);
		const refs = unionSources(input.sources, ...parents.map((parent) => parent.sources));
		const auth = await this.authorize(actor.workspaceId, [actor], refs);
		return this.fenced(actor.workspaceId, auth, (tx) => {
			requireAccess(!tx.getFact(input.id));
			const currentParents = this.parents(tx, actor.workspaceId, parentIds, input.scope);
			requireAccess(digest(currentParents) === digest(parents));
			requireAccess(this.readable(tx, refs, [actor.userId], auth, input.scope));
			if (input.basis.kind === "recorded") {
				const cited = input.basis.source;
				requireAccess(
					refs.some((ref) => ref.sourceId === cited.sourceId && ref.revision === cited.revision)
				);
				const source = tx.getSource(cited.sourceId);
				requireAccess(source?.text?.includes(input.text));
			}
			const fact = FactSchema.parse({
				...input,
				sources: refs,
				workspaceId: actor.workspaceId,
				createdBy: actor,
				createdAt: this.now(),
			});
			tx.insertFact(fact);
			return fact;
		});
	}

	async searchExact(actorValue: unknown, value: unknown): Promise<KnowledgeFactView[]> {
		return this.readFactViews(actorValue, value, (view) => view);
	}

	async searchSharedExact(actorValue: unknown, value: unknown) {
		return this.readFactViews(actorValue, value, factDto);
	}

	private citations(tx: KnowledgeTransaction, refs: SourceRef[]): KnowledgeCitation[] {
		return refs.map((ref) => {
			const source = SourceSchema.parse(tx.getSource(ref.sourceId));
			return {
				...ref,
				kind: source.kind,
				containerId: source.containerId,
				authorUserId: source.authorUserId,
				observedAt: source.observedAt,
				citation: source.citation,
			};
		});
	}

	private relatedIds(tx: KnowledgeTransaction, id: string) {
		const relation = z
			.object({
				supersededBy: z.array(z.string().min(1)).max(256),
				contradictedBy: z.array(z.string().min(1)).max(256),
			})
			.strict()
			.parse(tx.getRelatedFactIds(id));
		return {
			supersededBy: unique(relation.supersededBy).sort(),
			contradictedBy: unique(relation.contradictedBy).sort(),
		};
	}

	private async readFactViews<T>(
		actorValue: unknown,
		value: unknown,
		project: (view: KnowledgeFactView) => T
	): Promise<T[]> {
		const actor = ActorSchema.parse(actorValue);
		const input = SearchInputSchema.parse(value);
		requireAccess(scopeAllowed(input.scope, [actor.userId]));
		const snapshot = await this.ports.store.transaction(actor.workspaceId, (tx) => {
			const candidates = tx
				.queryFacts({ ...input, limit: 50 })
				.slice(0, 50)
				.map((fact) => FactSchema.parse(fact));
			const relations = candidates.map((fact) => ({
				id: fact.id,
				...this.relatedIds(tx, fact.id),
			}));
			const ids = unique(
				relations.flatMap((relation) => [...relation.supersededBy, ...relation.contradictedBy])
			);
			requireAccess(ids.length <= 256);
			const related = this.parents(tx, actor.workspaceId, ids, input.scope);
			return { candidates, relations, related };
		});
		const { candidates, relations, related } = snapshot;
		requireAccess(
			candidates.every(
				(fact) => fact.workspaceId === actor.workspaceId && sameScope(fact.scope, input.scope)
			)
		);
		const refs = this.requestRefs([...candidates, ...related].map((fact) => fact.sources));
		const auth = await this.authorize(actor.workspaceId, [actor], refs);
		return this.fenced(actor.workspaceId, auth, (tx) => {
			const result: T[] = [];
			const visibleRelated = related
				.filter((fact) => {
					const current = tx.getFact(fact.id);
					return (
						current &&
						digest(FactSchema.parse(current)) === digest(fact) &&
						this.readable(tx, fact.sources, [actor.userId], auth, input.scope)
					);
				})
				.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
			for (const candidate of candidates) {
				const value = tx.getFact(candidate.id);
				if (!value || digest(FactSchema.parse(value)) !== digest(candidate)) continue;
				if (
					!candidate.text.includes(input.text) ||
					!this.readable(tx, candidate.sources, [actor.userId], auth, input.scope)
				)
					continue;
				const relation = relations.find((row) => row.id === candidate.id);
				requireAccess(
					relation &&
						digest(this.relatedIds(tx, candidate.id)) ===
							digest({
								supersededBy: relation.supersededBy,
								contradictedBy: relation.contradictedBy,
							})
				);
				const superseding = visibleRelated.filter(
					(fact) =>
						relation.supersededBy.includes(fact.id) && fact.supersedes.includes(candidate.id)
				);
				result.push(
					project({
						fact: candidate,
						citations: this.citations(tx, candidate.sources),
						supersededByIds: superseding.map((fact) => fact.id),
						contradictedByIds: visibleRelated
							.filter(
								(fact) =>
									relation.contradictedBy.includes(fact.id) &&
									fact.contradicts.includes(candidate.id)
							)
							.map((fact) => fact.id),
						updatedAt: superseding.reduce(
							(time, fact) => (fact.createdAt > time ? fact.createdAt : time),
							candidate.createdAt
						),
					})
				);
				if (result.length === input.limit) break;
			}
			return result;
		});
	}

	private requestRefs(groups: SourceRef[][]): SourceRef[] {
		// Read requests may include conflicting historical revisions; authority returns one current head.
		const refs = new Map<string, SourceRef>();
		for (const ref of groups.flat()) refs.set(JSON.stringify(ref), ref);
		return [...refs.values()];
	}

	async admitDirectMessage(actorValue: unknown, value: unknown): Promise<AdmissionResult> {
		const actor = ActorSchema.parse(actorValue);
		const input = MessageInputSchema.parse(value);
		const payloadDigest = digest(input);
		let auth: AuthorizationSnapshot | null = null;
		let parents: KnowledgeFact[] = [];
		let refs: SourceRef[] = input.sources;
		let recipient: KnowledgeActor | null = null;
		try {
			parents = await this.ports.store.transaction(actor.workspaceId, (tx) =>
				this.parents(tx, actor.workspaceId, input.parentFactIds)
			);
			refs = unionSources(input.sources, ...parents.map((parent) => parent.sources));
			// The port resolves current owner membership for requested agents as well as users.
			auth = await this.authorize(actor.workspaceId, [actor], refs, [input.recipientAgentId]);
			const owners = auth.agentOwners.filter((owner) => owner.agentId === input.recipientAgentId);
			const userId = owners[0]?.userId;
			requireAccess(owners.length === 1 && userId);
			recipient = { workspaceId: actor.workspaceId, userId, agentId: input.recipientAgentId };
			requireAccess(actorAllowed(recipient, auth));
		} catch (error) {
			if (!(error instanceof KnowledgeAccessError)) throw error;
		}
		return this.ports.store.transaction(actor.workspaceId, (tx) => {
			let result: AdmissionResult = { status: "rejected", reason: "not-authorized" };
			if (auth && recipient && this.ports.authorization.isCurrent(auth)) {
				const users = [actor.userId, recipient.userId];
				const currentParents = this.parents(tx, actor.workspaceId, input.parentFactIds);
				const allowed =
					digest(currentParents) === digest(parents) &&
					parents.every((parent) => scopeAllowed(parent.scope, users)) &&
					this.readable(tx, refs, users, auth) &&
					parents.every((parent) => this.readable(tx, parent.sources, users, auth, parent.scope));
				if (allowed) {
					const existingValue = tx.getMessageByRequest(actor.agentId, input.requestId);
					const existing = existingValue ? MessageSchema.parse(existingValue) : null;
					if (existing) {
						requireAccess(
							existing.workspaceId === actor.workspaceId &&
								existing.sender.userId === actor.userId &&
								existing.sender.agentId === actor.agentId
						);
						result =
							existing.payloadDigest === payloadDigest &&
							existing.recipientUserId === recipient.userId
								? { status: "admitted", messageId: existing.id }
								: { status: "rejected", reason: "request-conflict" };
					} else {
						const message = MessageSchema.parse({
							...input,
							sources: refs,
							id: this.id(),
							workspaceId: actor.workspaceId,
							sender: actor,
							recipientUserId: recipient.userId,
							createdAt: this.now(),
							contentRole: "untrusted-evidence",
							payloadDigest,
						});
						tx.insertMessage(message);
						result = { status: "admitted", messageId: message.id };
					}
				}
			}
			tx.appendAudit({
				workspaceId: actor.workspaceId,
				sender: actor,
				requestId: input.requestId,
				recipientAgentId: input.recipientAgentId,
				at: z.iso.datetime().parse(this.now()),
				result,
				payloadDigest,
			});
			// If the fence failed during mutation the adapter must roll back message AND audit.
			if (result.status === "admitted")
				requireAccess(auth && this.ports.authorization.isCurrent(auth));
			return result;
		});
	}

	async readInbox(actorValue: unknown, limit = 20): Promise<DirectAgentMessage[]> {
		return this.readMessages(actorValue, limit, (message) => message);
	}

	async readSharedInbox(actorValue: unknown, limit = 20) {
		return this.readMessages(actorValue, limit, communicationDto);
	}

	private async readMessages<T>(
		actorValue: unknown,
		limit: number,
		project: (message: DirectAgentMessage, sources: KnowledgeCitation[]) => T
	): Promise<T[]> {
		const actor = ActorSchema.parse(actorValue);
		z.number().int().min(1).max(50).parse(limit);
		const messages = await this.ports.store.transaction(actor.workspaceId, (tx) =>
			tx
				.listMessages(actor.agentId, 50)
				.slice(0, 50)
				.map((message) => MessageSchema.parse(message))
		);
		requireAccess(
			messages.every(
				(message) =>
					message.workspaceId === actor.workspaceId && message.recipientAgentId === actor.agentId
			)
		);
		const auth = await this.authorize(
			actor.workspaceId,
			[actor],
			this.requestRefs(messages.map((message) => message.sources)),
			unique(messages.map((message) => message.sender.agentId))
		);
		return this.fenced(actor.workspaceId, auth, (tx) =>
			messages
				.filter((message) => {
					if (message.recipientUserId !== actor.userId) return false;
					if (!actorAllowed(message.sender, auth)) return false;
					const stored = tx.getMessageByRequest(message.sender.agentId, message.requestId);
					if (!stored || digest(MessageSchema.parse(stored)) !== digest(message)) return false;
					const users = [actor.userId, message.sender.userId];
					const parents = this.parents(tx, actor.workspaceId, message.parentFactIds);
					return (
						this.readable(tx, message.sources, users, auth) &&
						parents.every((parent) => this.readable(tx, parent.sources, users, auth, parent.scope))
					);
				})
				.slice(0, limit)
				.map((message) => project(message, this.citations(tx, message.sources)))
		);
	}
}
