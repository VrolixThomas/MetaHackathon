import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { ConversationTurnInput, WorkspaceSnapshot } from "../../shared/contracts";
import { decodeSlackViewTarget } from "../../shared/contracts/chat";
import { type ChatMessage, ChatMessageSchema } from "../../shared/contracts/chat";
import { IdSchema } from "../../shared/contracts/common";
import { type DayActor, DayActorSchema } from "../../shared/contracts/day";
import { type DayIntakeClassification, dayIntakeSourceBinding } from "../agent/day-intake";
import {
	type StandingAccess,
	StandingAccessSchema,
	type StandingCandidate,
	type StandingClarification,
	type StandingRulePolicy,
	StandingRulePolicySchema,
	standingPolicyDigest,
} from "../day/standing-clarification";
import type { SlackClient } from "../slack/client";

export const StandingProposalInputSchema = StandingRulePolicySchema.pick({
	scope: true,
	durationMinutes: true,
	maxThreads: true,
	messagesPerThread: true,
	globalMessageBudget: true,
});
export type StandingProposalInput = z.infer<typeof StandingProposalInputSchema>;
const IngressSchema = z.strictObject({
	sessionId: IdSchema,
	turnId: IdSchema,
	requestId: IdSchema,
	actor: DayActorSchema,
	connectionId: IdSchema,
	/** Explicitly selected by the human, never resolved from model arguments. */
	channelId: IdSchema,
	channelLabel: z.string().min(1).max(100),
	text: z.string().min(1).max(32000),
	inputMode: z.enum(["text", "voice"]),
});
export type StandingUserIngress = z.infer<typeof IngressSchema>;
/** Opaque in-process capability: JSON copies and model-created objects are rejected. */
export interface StandingIngress {
	readonly requestId: string;
}
export interface StandingProposal {
	kind: "standing-clarification-proposal";
	id: string;
	policy: StandingRulePolicy;
	policyDigest: string;
	text: string;
	sessionId: string;
	turnId: string;
	requestId: string;
}
export interface StandingPublicationReceipt {
	kind: "spoken" | "displayed";
	proposalId: string;
	policyDigest: string;
	text: string;
	sessionId: string;
	turnId: string;
	requestId: string;
}
interface Pending {
	proposal: StandingProposal;
	ingress: StandingUserIngress;
	publishedAt: number;
	delivery: StandingPublicationReceipt["kind"];
	confirmationRequestId?: string;
}
export interface StandingConversationPorts {
	controller: StandingClarification;
	readAccess(channelId: string, signal: AbortSignal): Promise<StandingAccess>;
	/** Resolve ONLY after this exact text is published in the actual conversation.
	 * Tool output/model history is not publication. Reject on cancellation or failed publication. */
	publish(proposal: StandingProposal, signal: AbortSignal): Promise<StandingPublicationReceipt>;
}
const affirmative =
	/^(?:yes|yes,? (?:please|activate (?:this|that|the) rule)|(?:i )?confirm (?:this|that|the) rule|activate (?:this|that|the) rule)[.!]?$/i;

export function standingConfirmationReply(text: string): boolean {
	return affirmative.test(text.trim());
}

/** Conservative actual-ingress grammar; provider text never enters this check. */
export function standingProposalRequested(text: string): boolean {
	const value = text.trim();
	return (
		/^(?:please )?(?:propose|draft|set up) (?:a |the )?(?:standing |slack )?clarification rule\b/i.test(
			value
		) ||
		(/^(?:(?:please|can you|could you)\s+)?(?:let (?:Muse|you) |go ahead and )?ask\b/i.test(
			value
		) &&
			/\bclarif\w*\b/i.test(value) &&
			/\b(?:fresh|new) mentions?\b|\b(?:new|fresh) requests?\b/i.test(value) &&
			!/\b(?:not|don't|never|unless)\b/i.test(value))
	);
}
export function standingManagementRequested(text: string): boolean {
	return (
		standingProposalRequested(text) ||
		/^(?:please )?(?:list|show|revoke|stop)\b[^.!?\n]*\brules?\b/i.test(text.trim())
	);
}

/** Root owns one instance per authenticated conversation session; dispose on account/session change.
 * No sender exists here. Only root calls userIngress, once per actual user event before model work. */
export class StandingClarificationConversation {
	private readonly ingresses = new WeakMap<
		StandingIngress,
		{ value: StandingUserIngress; at: number }
	>();
	private readonly seen = new Set<string>();
	private current?: StandingIngress;
	private pending?: Pending;
	private readonly observed = new Set<string>();
	private busy = false;
	constructor(
		private readonly ports: StandingConversationPorts,
		private readonly now = Date.now
	) {}

	userIngress(raw: StandingUserIngress, admittedAt = this.now()): StandingIngress {
		const value = IngressSchema.parse(raw);
		// A repeated request or turn cannot manufacture a distinct confirmation event.
		const keys = [`request:${value.requestId}`, `turn:${value.sessionId}:${value.turnId}`];
		if (keys.some((key) => this.seen.has(key)) || this.seen.size >= 2000)
			throw new Error("Start a fresh conversation before managing rules again.");
		for (const key of keys) this.seen.add(key);
		if (
			this.pending &&
			(this.pending.confirmationRequestId !== undefined ||
				!affirmative.test(value.text.trim()) ||
				(value.inputMode === "voice" && this.pending.delivery !== "spoken") ||
				value.sessionId !== this.pending.ingress.sessionId ||
				!isDeepStrictEqual(value.actor, this.pending.ingress.actor) ||
				value.connectionId !== this.pending.ingress.connectionId ||
				value.channelId !== this.pending.ingress.channelId)
		)
			this.pending = undefined;
		if (this.pending) this.pending.confirmationRequestId = value.requestId;
		const token = Object.freeze({ requestId: value.requestId });
		this.ingresses.set(token, { value, at: admittedAt });
		this.current = token;
		this.observed.clear();
		return token;
	}
	/** Retire the previous turn immediately, before asynchronous credential/view capture. */
	beginUserTurn(text: string) {
		this.current = undefined;
		this.observed.clear();
		if (this.pending?.confirmationRequestId || !affirmative.test(text.trim()))
			this.pending = undefined;
	}
	get pendingConfirmation() {
		return !!this.pending;
	}
	dispose() {
		this.current = undefined;
		this.pending = undefined;
		this.observed.clear();
	}
	private user(token: StandingIngress, signal: AbortSignal, maxAge = 30000) {
		signal.throwIfAborted();
		const entry = this.ingresses.get(token);
		if (!entry || token !== this.current || this.now() - entry.at > maxAge || this.now() < entry.at)
			throw new Error("A fresh user request is required.");
		return entry.value;
	}
	private async access(token: StandingIngress, signal: AbortSignal, maxAge = 30000) {
		const user = this.user(token, signal, maxAge);
		let access: StandingAccess;
		try {
			access = StandingAccessSchema.parse(await this.ports.readAccess(user.channelId, signal));
		} catch (error) {
			this.pending = undefined;
			throw error;
		}
		this.user(token, signal, maxAge);
		if (
			!isDeepStrictEqual(access.actor, user.actor) ||
			access.connectionId !== user.connectionId ||
			access.channelId !== user.channelId ||
			Date.parse(access.observedAt) > this.now() ||
			this.now() - Date.parse(access.observedAt) > 5000
		) {
			this.pending = undefined;
			throw new Error("The Slack account or channel access changed.");
		}
		return user;
	}
	private async exclusive<T>(work: () => Promise<T>) {
		if (this.busy) throw new Error("A rule operation is already in progress.");
		this.busy = true;
		try {
			return await work();
		} finally {
			this.busy = false;
		}
	}
	propose(token: StandingIngress, raw: StandingProposalInput, signal: AbortSignal) {
		return this.exclusive(async () => {
			const user = await this.access(token, signal);
			if (!standingProposalRequested(user.text))
				throw new Error("Ask me to propose a clarification rule first.");
			const input = StandingProposalInputSchema.parse(raw);
			const policy = StandingRulePolicySchema.parse({
				...input,
				id: randomUUID(),
				revision: 1,
				actor: user.actor,
				connectionId: user.connectionId,
				channelId: user.channelId,
				sendAuthority: "clarification-only-original-thread",
			});
			this.pending = undefined;
			await this.ports.controller.propose(policy);
			this.user(token, signal);
			const text = `For ${policy.durationMinutes} minutes after you confirm, I can ask clarification questions about “${policy.scope}” in ${user.channelLabel}, only for new requests that mention you. I can reply in up to ${policy.maxThreads} original threads, with at most ${policy.messagesPerThread} messages per thread and ${policy.globalMessageBudget} messages total. Older requests are excluded. This does not accept work, start work, or send final answers. You can revoke the rule at any time. Activate this rule?`;
			const proposal: StandingProposal = {
				kind: "standing-clarification-proposal",
				id: policy.id,
				policy,
				policyDigest: standingPolicyDigest(policy),
				text,
				sessionId: user.sessionId,
				turnId: user.turnId,
				requestId: user.requestId,
			};
			const receipt = await this.ports.publish(structuredClone(proposal), signal);
			// The already admitted canonical voice proposal may take longer than 30s to drain.
			await this.access(token, signal, 300000);
			const expected: StandingPublicationReceipt = {
				kind: user.inputMode === "voice" ? "spoken" : "displayed",
				proposalId: proposal.id,
				policyDigest: proposal.policyDigest,
				text,
				sessionId: user.sessionId,
				turnId: user.turnId,
				requestId: user.requestId,
			};
			if (!isDeepStrictEqual(receipt, expected))
				throw new Error("Rule presentation was not verified.");
			this.pending = {
				proposal: structuredClone(proposal),
				ingress: user,
				publishedAt: this.now(),
				delivery: receipt.kind,
			};
			return {
				proposal,
				presentation: receipt.kind,
				confirmation: "separate-user-turn-required" as const,
			};
		});
	}
	confirm(token: StandingIngress, signal: AbortSignal) {
		return this.exclusive(async () => {
			const user = await this.access(token, signal);
			const pending = this.pending;
			if (
				!pending ||
				(user.inputMode === "voice" && pending.delivery !== "spoken") ||
				!affirmative.test(user.text.trim()) ||
				user.sessionId !== pending.ingress.sessionId ||
				user.turnId === pending.ingress.turnId ||
				user.requestId === pending.ingress.requestId ||
				pending.confirmationRequestId !== user.requestId ||
				!isDeepStrictEqual(user.actor, pending.ingress.actor) ||
				user.connectionId !== pending.ingress.connectionId ||
				user.channelId !== pending.ingress.channelId ||
				this.now() - pending.publishedAt > 300000 ||
				this.now() < pending.publishedAt
			)
				throw new Error("Confirm the exact presented rule in a separate actual user reply.");
			await this.ports.controller.confirm(pending.proposal.id, {
				kind: "explicit-standing-rule-confirmation",
				requestId: user.requestId,
				actor: user.actor,
				policyDigest: pending.proposal.policyDigest,
				confirmedAt: new Date(this.now()).toISOString(),
			});
			this.pending = undefined;
			return { status: "active" as const, ruleId: pending.proposal.id };
		});
	}
	async list(token: StandingIngress, signal: AbortSignal) {
		const user = await this.access(token, signal);
		const rules = await this.ports.controller.list(user.actor, user.connectionId);
		this.user(token, signal);
		const selected = rules.filter((rule) => rule.policy.channelId === user.channelId);
		for (const rule of selected) this.observed.add(rule.policy.id);
		return selected.map((rule) => ({
			...rule,
			status:
				rule.status === "active" && Date.parse(rule.expiresAt ?? "") <= this.now()
					? ("expired" as const)
					: rule.status,
		}));
	}
	revoke(token: StandingIngress, ruleId: string, signal: AbortSignal) {
		return this.exclusive(async () => {
			const user = await this.access(token, signal);
			const exact = `revoke rule ${ruleId}`;
			const singular = /^(?:please )?(?:revoke|stop) (?:this|that|the) rule[.!]?$/i.test(
				user.text.trim()
			);
			if (
				!this.observed.has(ruleId) ||
				(user.text.trim().toLowerCase() !== exact.toLowerCase() &&
					!(singular && this.observed.size === 1))
			)
				throw new Error("List the rules and explicitly identify the rule to revoke.");
			await this.ports.controller.revoke(ruleId, user.actor);
			if (this.pending?.proposal.id === ruleId) this.pending = undefined;
			return { status: "revoked" as const, ruleId };
		});
	}
}

/** Fresh network identity and joined-channel checks using existing SlackClient read APIs. */
export async function readStandingSlackAccess(
	client: Pick<
		SlackClient,
		"credential" | "capabilities" | "conversation" | "audience" | "assertCurrent"
	>,
	channelId: string,
	signal: AbortSignal,
	now = Date.now
): Promise<StandingAccess> {
	const credential = await client.credential(signal);
	const capabilities = await client.capabilities(signal);
	const conversation = await client.conversation(channelId, signal);
	const audience = await client.audience(channelId, signal, credential);
	await client.assertCurrent(credential, signal);
	signal.throwIfAborted();
	if (
		capabilities.workspaceId !== credential.workspaceId ||
		capabilities.userId !== credential.userId ||
		!capabilities.canReply ||
		conversation.workspaceId !== credential.workspaceId ||
		conversation.id !== channelId ||
		!conversation.canRead ||
		!conversation.canReply ||
		conversation.visibility !== audience.visibility ||
		audience.workspaceId !== credential.workspaceId ||
		audience.conversationId !== channelId ||
		!audience.readerIds.includes(credential.userId) ||
		!["public_channel", "private_channel"].includes(audience.visibility) ||
		Date.parse(audience.observedAt) > now() ||
		now() - Date.parse(audience.observedAt) > 5000
	)
		throw new Error("Fresh joined Slack channel access is required.");
	return StandingAccessSchema.parse({
		actor: { workspaceId: credential.workspaceId, userId: credential.userId },
		connectionId: credential.connectionId,
		channelId,
		joined: true,
		canReply: true,
		observedAt: audience.observedAt,
	});
}

/** Retains original trusted classifyDayMessage results only, before root reduces them to Day metadata.
 * Ephemeral, single-use and bounded: never reclassify history or restore grants from a model/cache. */
export class StandingIncomingBindings {
	private readonly entries = new Map<
		string,
		{ at: number; connectionId: string; actor: DayActor; message: ChatMessage }
	>();
	constructor(private readonly now = Date.now) {}
	clear() {
		this.entries.clear();
	}
	retain(actor: DayActor, connectionId: string, raw: ChatMessage, result: DayIntakeClassification) {
		const message = ChatMessageSchema.parse(raw);
		const binding = dayIntakeSourceBinding({ actor, message });
		if (
			result.explicitOwnPromise ||
			result.kind === "promise" ||
			result.provenance !== "inferred" ||
			message.authorId === actor.userId ||
			message.deletedAt ||
			message.updatedAt !== message.createdAt ||
			!message.text.includes(`<@${actor.userId}>`) ||
			Date.parse(message.createdAt) > this.now() ||
			this.now() - Date.parse(message.createdAt) > 30000 ||
			!isDeepStrictEqual(binding, {
				actor: result.actor,
				source: result.source,
				authorId: result.authorId,
				bodyDigest: result.bodyDigest,
			})
		)
			return;
		const key = JSON.stringify(binding);
		if (this.entries.size >= 128) this.entries.delete(this.entries.keys().next().value as string);
		this.entries.set(key, { at: this.now(), connectionId, actor: structuredClone(actor), message });
	}
	take(
		actor: DayActor,
		connectionId: string,
		message: ChatMessage
	): StandingCandidate["classification"] | null {
		const key = JSON.stringify(dayIntakeSourceBinding({ actor, message }));
		const entry = this.entries.get(key);
		this.entries.delete(key);
		if (
			!entry ||
			entry.connectionId !== connectionId ||
			!isDeepStrictEqual(entry.actor, actor) ||
			!isDeepStrictEqual(entry.message, message) ||
			this.now() - entry.at > 30000 ||
			this.now() < entry.at
		)
			return null;
		return {
			kind: "incoming-request",
			targetUserId: actor.userId,
			source: structuredClone(message.citation.source),
		};
	}
}

/** Only committed, visible Slack selections may bind a channel; never source/model text. */
export function selectedStandingChannel(snapshot: WorkspaceSnapshot): string | undefined {
	const channels = new Set<string>();
	for (const canvas of snapshot.canvases) {
		if (canvas.id !== snapshot.primaryId && canvas.id !== snapshot.secondaryId) continue;
		if (canvas.kind !== "center" || canvas.section !== "slack" || !canvas.selectedId) continue;
		try {
			channels.add(decodeSlackViewTarget(canvas.selectedId).conversationId);
		} catch {
			return undefined;
		}
	}
	return channels.size === 1 ? [...channels][0] : undefined;
}
export interface StandingCompositionPorts {
	controller: StandingClarification;
	epoch(): string | number;
	observe(sessionId: string, signal: AbortSignal): Promise<WorkspaceSnapshot>;
	readAccess(channelId: string, signal: AbortSignal): Promise<StandingAccess>;
	narrate(
		turn: ConversationTurnInput,
		text: string,
		signal: AbortSignal
	): Promise<"spoken" | "displayed">;
}
/** Production seam: every actual ingress retires old capabilities before asynchronous reads. */
export class StandingClarificationComposition {
	private readonly admissions = new Map<
		string,
		{ turn: ConversationTurnInput; controller: AbortController; ready: Promise<void> }
	>();
	/** Synchronous actual-user hook: start capture before model work, gate it at hub preflight. */
	admit(turn: ConversationTurnInput) {
		const previous = this.admissions.get(turn.sessionId);
		previous?.controller.abort();
		const controller = new AbortController();
		const entry = { turn, controller, ready: Promise.resolve() };
		this.admissions.set(turn.sessionId, entry);
		entry.ready = this.capture(turn, controller.signal).catch(() => {
			/* Capture fails closed; ordinary conversation remains available. */
		});
	}
	async ready(turn: ConversationTurnInput, signal: AbortSignal) {
		const entry = this.admissions.get(turn.sessionId);
		if (!entry || !isDeepStrictEqual(entry.turn, turn)) return;
		const cancel = () => entry.controller.abort();
		signal.addEventListener("abort", cancel, { once: true });
		try {
			signal.throwIfAborted();
			await entry.ready;
			signal.throwIfAborted();
		} finally {
			signal.removeEventListener("abort", cancel);
			if (this.admissions.get(turn.sessionId) === entry) this.admissions.delete(turn.sessionId);
		}
	}
	private readonly captures = new Map<string, object>();
	private readonly sessions = new Map<
		string,
		{ rules: StandingClarificationConversation; epoch: string | number }
	>();
	private readonly turns = new Map<
		string,
		{
			turn: ConversationTurnInput;
			rules: StandingClarificationConversation;
			ingress: StandingIngress;
			workflow: boolean;
		}
	>();
	constructor(private readonly ports: StandingCompositionPorts) {}
	clear(sessionId?: string) {
		for (const [id, entry] of this.admissions)
			if (!sessionId || id === sessionId) {
				entry.controller.abort();
				this.admissions.delete(id);
			}
		this.retireState(sessionId);
	}
	private retireState(sessionId?: string) {
		if (sessionId) this.captures.delete(sessionId);
		else this.captures.clear();
		for (const [id, entry] of this.sessions)
			if (!sessionId || id === sessionId) {
				entry.rules.dispose();
				this.sessions.delete(id);
			}
		for (const [id, entry] of this.turns)
			if (!sessionId || entry.turn.sessionId === sessionId) this.turns.delete(id);
	}
	cancel(turn: Pick<ConversationTurnInput, "sessionId" | "turnId" | "generation">) {
		const admission = this.admissions.get(turn.sessionId);
		if (admission?.turn.turnId === turn.turnId && admission.turn.generation === turn.generation) {
			admission.controller.abort();
			this.admissions.delete(turn.sessionId);
		}
		for (const entry of this.turns.values())
			if (
				entry.turn.sessionId === turn.sessionId &&
				entry.turn.turnId === turn.turnId &&
				entry.turn.generation === turn.generation
			)
				this.clear(turn.sessionId);
	}
	async capture(turn: ConversationTurnInput, signal: AbortSignal) {
		const admittedAt = Date.now();
		let session = this.sessions.get(turn.sessionId);
		session?.rules.beginUserTurn(turn.text);
		for (const [id, entry] of this.turns)
			if (entry.turn.sessionId === turn.sessionId) this.turns.delete(id);
		if (!standingManagementRequested(turn.text) && !session?.rules.pendingConfirmation) {
			this.retireState(turn.sessionId);
			return;
		}
		const epoch = this.ports.epoch();
		if (session && session.epoch !== epoch) {
			this.retireState(turn.sessionId);
			session = undefined;
		}
		const capture = {};
		this.captures.set(turn.sessionId, capture);
		const check = () => {
			signal.throwIfAborted();
			if (Date.now() - admittedAt > 30000) throw new Error("Rule ingress expired");
			if (this.captures.get(turn.sessionId) !== capture) throw new Error("Rule ingress retired");
			if (this.ports.epoch() !== epoch) throw new Error("Slack account changed");
		};
		try {
			const snapshot = await this.ports.observe(turn.sessionId, signal);
			check();
			const channelId = selectedStandingChannel(snapshot);
			if (!channelId) {
				this.retireState(turn.sessionId);
				return;
			}
			const access = await this.ports.readAccess(channelId, signal);
			check();
			const after = await this.ports.observe(turn.sessionId, signal);
			check();
			if (selectedStandingChannel(after) !== channelId) throw new Error("Slack selection changed");
			if (!session) {
				const rules = new StandingClarificationConversation({
					controller: this.ports.controller,
					readAccess: async (channel, active) => {
						active.throwIfAborted();
						if (this.ports.epoch() !== epoch) throw new Error("Slack account changed");
						const value = await this.ports.readAccess(channel, active);
						active.throwIfAborted();
						if (this.ports.epoch() !== epoch) throw new Error("Slack account changed");
						return value;
					},
					publish: async (proposal, active) => {
						const entry = this.turns.get(proposal.requestId);
						if (!entry || entry.rules !== rules) throw new Error("Rule turn retired");
						active.throwIfAborted();
						if (this.ports.epoch() !== epoch) throw new Error("Slack account changed");
						const kind = await this.ports.narrate(entry.turn, proposal.text, active);
						active.throwIfAborted();
						if (this.ports.epoch() !== epoch || this.turns.get(proposal.requestId) !== entry)
							throw new Error("Rule turn retired");
						return {
							kind,
							proposalId: proposal.id,
							policyDigest: proposal.policyDigest,
							text: proposal.text,
							sessionId: proposal.sessionId,
							turnId: proposal.turnId,
							requestId: proposal.requestId,
						};
					},
				});
				session = { rules, epoch };
				this.sessions.set(turn.sessionId, session);
			}
			const ingress = session.rules.userIngress(
				{
					sessionId: turn.sessionId,
					turnId: turn.turnId,
					requestId: turn.requestId,
					text: turn.text,
					inputMode: turn.inputMode === "voice" ? "voice" : "text",
					actor: access.actor,
					connectionId: access.connectionId,
					channelId,
					channelLabel: `Slack channel ${channelId}`,
				},
				admittedAt
			);
			this.turns.set(turn.requestId, {
				turn,
				rules: session.rules,
				ingress,
				workflow: standingManagementRequested(turn.text) || session.rules.pendingConfirmation,
			});
		} catch (error) {
			if (this.captures.get(turn.sessionId) === capture) this.retireState(turn.sessionId);
			signal.throwIfAborted();
			// Missing Slack/access must not prevent unrelated foreground conversation.
		}
	}
	binding(turn: ConversationTurnInput) {
		const entry = this.turns.get(turn.requestId);
		const session = this.sessions.get(turn.sessionId);
		if (session && session.epoch !== this.ports.epoch()) {
			this.clear(turn.sessionId);
			return undefined;
		}
		return entry && isDeepStrictEqual(entry.turn, turn) ? entry : undefined;
	}
}
