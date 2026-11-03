import { z } from "zod";
import { ChatMessageSchema, ChatSourceSchema } from "../../shared/contracts/chat";
import { DateTimeSchema, IdSchema } from "../../shared/contracts/common";
import { DayActorSchema } from "../../shared/contracts/day";
import { ClarificationReadSchema } from "./clarification";
import { sha256, sourceKey } from "./model";

/** Main-only integration DTOs; not model arguments or a public RPC authorization surface. */
export const StandingRulePolicySchema = z.strictObject({
	id: IdSchema,
	revision: z.int().positive(),
	actor: DayActorSchema,
	connectionId: IdSchema,
	channelId: IdSchema,
	scope: z.string().min(1).max(1000),
	durationMinutes: z.int().min(5).max(30),
	maxThreads: z.int().min(1).max(5),
	messagesPerThread: z.int().min(1).max(3),
	globalMessageBudget: z.int().min(1).max(10),
	sendAuthority: z.literal("clarification-only-original-thread"),
});
export type StandingRulePolicy = z.infer<typeof StandingRulePolicySchema>;
const ConfirmationSchema = z.strictObject({
	kind: z.literal("explicit-standing-rule-confirmation"),
	requestId: IdSchema,
	actor: DayActorSchema,
	policyDigest: z.string().regex(/^[a-f0-9]{64}$/),
	confirmedAt: DateTimeSchema,
});
const RuleSchema = z.strictObject({
	policy: StandingRulePolicySchema,
	status: z.enum(["proposed", "active", "revoked"]),
	confirmation: ConfirmationSchema.nullable(),
	expiresAt: DateTimeSchema.nullable(),
});
export const StandingAdmissionSchema = z.strictObject({
	id: IdSchema,
	ruleId: IdSchema,
	ruleRevision: z.int().positive(),
	itemId: IdSchema,
	source: ChatSourceSchema,
	sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
	threadKey: z.string(),
	reservedMessages: z.int().min(1).max(3),
	admittedAt: DateTimeSchema,
	expiresAt: DateTimeSchema,
	authority: z.literal("standing-rule"),
});
export type StandingAdmission = z.infer<typeof StandingAdmissionSchema>;
const StateSchema = z.strictObject({
	version: z.literal(1),
	rules: z.array(RuleSchema).max(1000),
	admissions: z.array(StandingAdmissionSchema).max(5000),
});
export type StandingState = z.infer<typeof StateSchema>;
export const emptyStandingState = (): StandingState => ({ version: 1, rules: [], admissions: [] });
export const standingPolicyDigest = (raw: StandingRulePolicy) =>
	sha256(JSON.stringify(StandingRulePolicySchema.parse(raw)));
const sameActor = (a: z.infer<typeof DayActorSchema>, b: z.infer<typeof DayActorSchema>) =>
	a.workspaceId === b.workspaceId && a.userId === b.userId;
const threadKey = (source: z.infer<typeof ChatSourceSchema>) =>
	sha256(
		JSON.stringify([source.workspaceId, source.conversationId, source.threadId ?? source.messageId])
	);
const admissionId = (
	rule: StandingRulePolicy,
	itemId: string,
	source: z.infer<typeof ChatSourceSchema>
) =>
	`standing-${sha256(JSON.stringify([rule.id, rule.revision, itemId, sourceKey(source), source.revisionId]))}`;

/** Validate persisted bytes too: counters are derived from retained reservations, never refunded. */
export function parseStandingState(raw: unknown): StandingState {
	const state = StateSchema.parse(raw);
	const unique = (values: string[]) => {
		if (new Set(values).size !== values.length) throw new Error("Duplicate standing identity");
	};
	unique(state.rules.map((r) => r.policy.id));
	unique(state.admissions.map((a) => a.id));
	for (const rule of state.rules) {
		const p = rule.policy;
		const c = rule.confirmation;
		if (rule.status === "active" && !c) throw new Error("Standing confirmation missing");
		if (rule.status === "proposed" && (c || rule.expiresAt))
			throw new Error("Proposal has authority");
		if (
			c &&
			(!sameActor(c.actor, p.actor) ||
				c.policyDigest !== standingPolicyDigest(p) ||
				!rule.expiresAt ||
				Date.parse(rule.expiresAt) !== Date.parse(c.confirmedAt) + p.durationMinutes * 60000)
		)
			throw new Error("Standing confirmation mismatch");
		const admissions = state.admissions.filter((a) => a.ruleId === p.id);
		unique(admissions.map((a) => a.itemId));
		unique(admissions.map((a) => a.threadKey));
		if (
			admissions.length > p.maxThreads ||
			admissions.reduce((n, a) => n + a.reservedMessages, 0) > p.globalMessageBudget
		)
			throw new Error("Standing budget exceeded");
	}
	unique(
		state.admissions.map((a) => {
			const parent = state.rules.find((r) => r.policy.id === a.ruleId);
			return JSON.stringify([parent?.policy.actor, a.threadKey]);
		})
	);
	unique(
		state.admissions.map((a) => {
			const parent = state.rules.find((r) => r.policy.id === a.ruleId);
			return JSON.stringify([parent?.policy.actor, a.itemId]);
		})
	);
	for (const a of state.admissions) {
		const rule = state.rules.find((r) => r.policy.id === a.ruleId);
		if (
			!rule?.confirmation ||
			rule.policy.revision !== a.ruleRevision ||
			a.id !== admissionId(rule.policy, a.itemId, a.source) ||
			a.source.workspaceId !== rule.policy.actor.workspaceId ||
			a.source.conversationId !== rule.policy.channelId ||
			a.threadKey !== threadKey(a.source) ||
			a.reservedMessages !== rule.policy.messagesPerThread ||
			a.expiresAt !== rule.expiresAt ||
			Date.parse(a.admittedAt) < Date.parse(rule.confirmation.confirmedAt) ||
			Date.parse(a.admittedAt) >= Date.parse(a.expiresAt)
		)
			throw new Error("Standing admission mismatch");
	}
	return state;
}

/**
 * Root supplies durable, serializable transactions. Run mutate on a private copy, validate and
 * commit all bytes before returning. Roll back on errors. No async callback, provider calls,
 * in-memory fallback, retention pruning or budget refunds. Concurrent processes must serialize.
 * Child installation may be a later transaction: a crash burns the reservation and never replays it.
 */
export interface StandingClarificationStore {
	transaction<T>(mutate: (state: StandingState) => T): Promise<T>;
}
const CandidateSchema = z.strictObject({
	itemId: IdSchema,
	owner: DayActorSchema,
	message: ChatMessageSchema,
	/** Trusted classifier output bound to the exact captured source; eligibility, not authority. */
	classification: z.strictObject({
		kind: z.literal("incoming-request"),
		targetUserId: IdSchema,
		source: ChatSourceSchema,
	}),
	/** Fresh provider identity/membership, never reconstructed from the cached audience. */
	access: z.strictObject({
		actor: DayActorSchema,
		connectionId: IdSchema,
		channelId: IdSchema,
		joined: z.literal(true),
		canReply: z.literal(true),
		observedAt: DateTimeSchema,
	}),
	read: ClarificationReadSchema,
});
export type StandingCandidate = z.infer<typeof CandidateSchema>;

/** No send, coding, ownership or publication capability exists in this coordinator. */
export class StandingClarification {
	constructor(
		private readonly store: StandingClarificationStore,
		private readonly now = Date.now
	) {}
	private transact<T>(mutate: (state: StandingState) => T): Promise<T> {
		return this.store.transaction((raw) => {
			const state = parseStandingState(raw);
			const result = mutate(state);
			Object.assign(raw, parseStandingState(state));
			return structuredClone(result);
		});
	}
	propose(raw: StandingRulePolicy): Promise<void> {
		const policy = StandingRulePolicySchema.parse(raw);
		return this.transact((state) => {
			if (state.rules.some((r) => r.policy.id === policy.id))
				throw new Error("Standing rule already exists");
			state.rules.push({ policy, status: "proposed", confirmation: null, expiresAt: null });
		});
	}
	/** Only explicit app ingress may call this with the exact displayed policy digest. */
	confirm(ruleId: string, raw: z.infer<typeof ConfirmationSchema>): Promise<void> {
		const confirmation = ConfirmationSchema.parse(raw);
		return this.transact((state) => {
			const rule = state.rules.find((r) => r.policy.id === ruleId);
			if (
				!rule ||
				rule.status !== "proposed" ||
				!sameActor(rule.policy.actor, confirmation.actor) ||
				confirmation.policyDigest !== standingPolicyDigest(rule.policy) ||
				Date.parse(confirmation.confirmedAt) > this.now() ||
				this.now() - Date.parse(confirmation.confirmedAt) > 30000
			)
				throw new Error("Standing confirmation is stale or mismatched");
			rule.confirmation = confirmation;
			rule.expiresAt = new Date(
				Date.parse(confirmation.confirmedAt) + rule.policy.durationMinutes * 60000
			).toISOString();
			rule.status = "active";
		});
	}
	revoke(ruleId: string, actor: z.infer<typeof DayActorSchema>): Promise<void> {
		const parsed = DayActorSchema.parse(actor);
		return this.transact((state) => {
			const rule = state.rules.find((r) => r.policy.id === ruleId);
			if (!rule || !sameActor(rule.policy.actor, parsed))
				throw new Error("Standing rule unavailable");
			rule.status = "revoked";
		});
	}
	/** Returns only NEW reservations. Retries, restart and edited-source replay return null. */
	admit(ruleId: string, raw: StandingCandidate): Promise<StandingAdmission | null> {
		const c = CandidateSchema.parse(raw);
		return this.transact((state) => {
			const rule = state.rules.find((r) => r.policy.id === ruleId);
			const now = this.now();
			if (
				!rule ||
				rule.status !== "active" ||
				!rule.confirmation ||
				!rule.expiresAt ||
				Date.parse(rule.expiresAt) <= now
			)
				return null;
			const p = rule.policy;
			const source = c.message.citation.source;
			const exact = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
			if (
				!sameActor(p.actor, c.owner) ||
				!sameActor(p.actor, c.access.actor) ||
				c.access.connectionId !== p.connectionId ||
				c.read.connectionId !== p.connectionId ||
				c.access.channelId !== p.channelId ||
				source.conversationId !== p.channelId ||
				source.workspaceId !== p.actor.workspaceId ||
				c.classification.targetUserId !== p.actor.userId ||
				!exact(c.classification.source, source) ||
				c.message.authorId === p.actor.userId ||
				c.message.deletedAt ||
				c.message.truncated ||
				!c.message.text.trim() ||
				Date.parse(c.message.createdAt) <= Date.parse(rule.confirmation.confirmedAt) ||
				Date.parse(c.message.createdAt) > now ||
				c.message.updatedAt !== c.message.createdAt ||
				Date.parse(c.access.observedAt) > now ||
				now - Date.parse(c.access.observedAt) > 5000 ||
				!c.read.complete ||
				!c.read.messages.some((m) => exact(m, c.message)) ||
				c.read.messages.some(
					(m) =>
						m.deletedAt ||
						m.truncated ||
						threadKey(m.citation.source) !== threadKey(source) ||
						!m.citation.audience.readerIds.includes(p.actor.userId) ||
						!["public_channel", "private_channel"].includes(m.citation.audience.visibility)
				)
			)
				return null;
			// Never admit the same thread again under a replacement rule, another item or source edit.
			if (
				state.admissions.some((a) => {
					const parent = state.rules.find((r) => r.policy.id === a.ruleId);
					return (
						parent &&
						sameActor(parent.policy.actor, p.actor) &&
						(a.itemId === c.itemId || a.threadKey === threadKey(source))
					);
				})
			)
				return null;
			const reservations = state.admissions.filter((a) => a.ruleId === p.id);
			if (
				reservations.length >= p.maxThreads ||
				reservations.reduce((n, a) => n + a.reservedMessages, 0) + p.messagesPerThread >
					p.globalMessageBudget
			)
				return null;
			const admission: StandingAdmission = {
				id: admissionId(p, c.itemId, source),
				ruleId: p.id,
				ruleRevision: p.revision,
				itemId: c.itemId,
				source,
				sourceDigest: sha256(JSON.stringify(c.message)),
				threadKey: threadKey(source),
				reservedMessages: p.messagesPerThread,
				admittedAt: new Date(now).toISOString(),
				expiresAt: rule.expiresAt,
				authority: "standing-rule",
			};
			state.admissions.push(admission);
			return admission;
		});
	}
	/** Root must invoke at existing send clearance/reservation boundaries, in addition to fresh source reads. */
	authorize(
		admissionId: string,
		source: z.infer<typeof ChatSourceSchema>,
		connectionId: string,
		actor: z.infer<typeof DayActorSchema>,
		maxMessages: number
	): Promise<boolean> {
		const parsedSource = ChatSourceSchema.parse(source);
		const parsedActor = DayActorSchema.parse(actor);
		return this.transact((state) => {
			const a = state.admissions.find((a) => a.id === admissionId);
			const r = state.rules.find((r) => r.policy.id === a?.ruleId);
			return (
				!!a &&
				!!r &&
				r.status === "active" &&
				Date.parse(a.expiresAt) > this.now() &&
				sameActor(r.policy.actor, parsedActor) &&
				r.policy.connectionId === connectionId &&
				JSON.stringify(a.source) === JSON.stringify(parsedSource) &&
				Number.isInteger(maxMessages) &&
				maxMessages >= 1 &&
				maxMessages <= a.reservedMessages
			);
		});
	}
}
