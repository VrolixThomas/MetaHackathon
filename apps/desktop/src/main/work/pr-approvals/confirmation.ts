import { randomUUID } from "node:crypto";
import {
	type ApprovalConfirmInput,
	type ApprovalPolicy,
	ApprovalPresentationSchema,
	type ConversationTurnInput,
} from "../../../shared/contracts";

export function approvalProposal(p: ApprovalPolicy) {
	return `Delegate ${p.terms.action === "approve" ? "automatic GitHub PR approval" : "notification only"} for ${p.pr.repository} PR ${p.pr.number}, account ${p.actor.login}, inspected head ${p.pr.headSha}, policy revision ${p.revision}. Expires ${p.terms.expiresAt}. Conditions: ${p.terms.conditions.map((c) => (c.kind === "check" ? `successful check ${c.name}, ${c.appId === null ? "one unambiguous provider" : `GitHub app ${c.appId}`}` : c.kind === "judgment" ? `human judgment required: ${c.description}` : `exact complete file ${c.path}: ${c.reason}. Expected contents: ${c.expectedContent}`)).join("; ")}. Subsequent changes are covered only in these exact source files with these exact bytes; other changes, PR title/description/target or author changes require renewed review. This never merges. Say “confirm this delegation” to authorize this exact policy.`;
}
type Proposal = {
	policy: ApprovalPolicy;
	turn: ConversationTurnInput;
	requestId: string;
	at: number;
	shown: boolean;
	spoken: boolean;
	consent?: ConversationTurnInput;
	resolve?: () => void;
	reject?: (e: Error) => void;
};
/** Consent comes from actual ingress and exact visible/spoken presentation, never model arguments. */
export class ApprovalConfirmation {
	private proposals = new Map<string, Proposal>();
	constructor(
		private readonly ports: {
			narrate(
				turn: ConversationTurnInput,
				requestId: string,
				text: string,
				signal: AbortSignal
			): Promise<unknown>;
			voice(turn: ConversationTurnInput): boolean;
		},
		private readonly now: () => number = Date.now
	) {}
	pending(sessionId: string) {
		const p = this.fresh(sessionId);
		return p && !p.shown
			? { sessionId, id: p.policy.id, revision: p.policy.revision, digest: p.policy.digest }
			: null;
	}
	async present(policy: ApprovalPolicy, turn: ConversationTurnInput, signal: AbortSignal) {
		this.invalidate(turn.sessionId);
		const p: Proposal = {
			policy: structuredClone(policy),
			turn: structuredClone(turn),
			requestId: randomUUID(),
			at: this.now(),
			shown: false,
			spoken: false,
		};
		this.proposals.set(turn.sessionId, p);
		const abort = () => this.invalidate(turn.sessionId);
		const timer = setTimeout(abort, 30000);
		signal.addEventListener("abort", abort, { once: true });
		try {
			await new Promise<void>((resolve, reject) => {
				p.resolve = resolve;
				p.reject = reject;
				if (signal.aborted) abort();
			});
			signal.throwIfAborted();
			if (this.ports.voice(turn)) {
				await this.ports.narrate(turn, p.requestId, approvalProposal(policy), signal);
				signal.throwIfAborted();
				p.spoken = true;
			}
			return { policy, displayed: true, confirmationRequired: true };
		} catch (error) {
			this.invalidate(turn.sessionId);
			throw error;
		} finally {
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
		}
	}
	presented(raw: unknown) {
		const input = ApprovalPresentationSchema.parse(raw);
		const p = this.fresh(input.sessionId);
		if (
			!p ||
			p.policy.id !== input.id ||
			p.policy.revision !== input.revision ||
			p.policy.digest !== input.digest
		)
			throw new Error("Stale delegation presentation");
		p.shown = true;
		p.resolve?.();
	}
	acceptUserTurn(turn: ConversationTurnInput) {
		const p = this.fresh(turn.sessionId);
		if (!p) return;
		p.consent = undefined;
		if (
			p.shown &&
			turn.turnId !== p.turn.turnId &&
			turn.generation >= p.turn.generation &&
			(turn.inputMode !== "voice" || p.spoken) &&
			/^(?:yes[, ]+)?(?:please )?confirm (?:this|the) delegation[.!]?$/i.test(turn.text.trim())
		)
			p.consent = structuredClone(turn);
	}
	take(turn: ConversationTurnInput, policy: ApprovalPolicy): ApprovalConfirmInput {
		const p = this.fresh(turn.sessionId);
		if (
			!p?.consent ||
			JSON.stringify(p.consent) !== JSON.stringify(turn) ||
			policy.id !== p.policy.id ||
			policy.revision !== p.policy.revision ||
			policy.digest !== p.policy.digest
		)
			throw new Error(
				"Explicit confirmation of the exact displayed delegation is required in a new user turn"
			);
		return { id: policy.id, revision: policy.revision, digest: policy.digest, confirmed: true };
	}
	invalidate(sessionId: string) {
		const p = this.proposals.get(sessionId);
		this.proposals.delete(sessionId);
		p?.reject?.(new Error("Delegation presentation retired"));
	}
	clear() {
		for (const id of this.proposals.keys()) this.invalidate(id);
	}
	private fresh(sessionId: string) {
		const p = this.proposals.get(sessionId);
		if (p && (this.now() < p.at || this.now() - p.at > 120000)) {
			this.invalidate(sessionId);
			return undefined;
		}
		return p;
	}
}
