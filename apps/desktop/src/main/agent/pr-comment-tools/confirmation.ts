import { createHash } from "node:crypto";
import {
	type ConfirmCommentInput,
	type ConversationTurnInput,
	type DraftedComment,
	DraftedCommentSchema,
	type PullRequest,
} from "../../../shared/contracts";
import { type PRCommentPresentation, sameCommentDraft } from "./index";

/** Exact text root may send through its existing narration/checkpoint pipeline. */
export function commentProposalText(pr: PullRequest, draft: DraftedComment) {
	return `Post this exact comment to ${pr.repository} #${pr.number} at head ${draft.headSha}${draft.location ? `, ${draft.location.path}:${draft.location.endLine}` : ""}:\n${draft.body}\nSay “post this comment” to confirm, or ask to edit it.`;
}
type Proposal = {
	presentation: PRCommentPresentation;
	text: string;
	at: number;
	spoken: boolean;
	consent?: { turn: ConversationTurnInput; input: ConfirmCommentInput };
};
/**
 * Main-only capability: root alone calls presented/spoken/acceptUserTurn from actual
 * renderer receipts, drained narration checkpoints, and user input ingress respectively.
 * Never expose these methods as model tools, source readers, or renderer approval RPCs.
 */
export class PRCommentConfirmationGate {
	private readonly proposals = new Map<string, Proposal>();
	constructor(
		private readonly now: () => number = Date.now,
		private readonly ttlMs = 120_000
	) {}
	presented(presentation: PRCommentPresentation, pr: PullRequest) {
		const draft = DraftedCommentSchema.parse(presentation.draft);
		if (draft.prId !== pr.id || draft.headSha !== pr.headSha || draft.evidence.kind === "fixture")
			throw new Error("Invalid comment presentation");
		if (this.proposals.size >= 256 && !this.proposals.has(presentation.sessionId))
			throw new Error("Comment confirmation capacity reached");
		this.proposals.set(presentation.sessionId, {
			presentation: structuredClone(presentation),
			text: commentProposalText(pr, draft),
			at: this.now(),
			spoken: false,
		});
	}
	spoken(sessionId: string, requestId: string, exactText: string) {
		const proposal = this.fresh(sessionId);
		if (!proposal || proposal.presentation.requestId !== requestId || proposal.text !== exactText)
			return false;
		proposal.spoken = true;
		return true;
	}
	/** Call only with an actual new user turn, after recording the displayed/spoken proposal. */
	acceptUserTurn(turn: ConversationTurnInput, modality: "typed" | "voice") {
		const proposal = this.fresh(turn.sessionId);
		if (!proposal) return false;
		proposal.consent = undefined;
		const text = turn.text
			.trim()
			.toLowerCase()
			.replace(/[.!?]+$/, "");
		if (
			turn.turnId === proposal.presentation.turnId ||
			turn.generation < proposal.presentation.generation ||
			(modality === "voice" && !proposal.spoken) ||
			!/^(?:yes[, ]+)?(?:please )?(?:post|send) (?:this|the) comment(?: please)?$/.test(text)
		)
			return false;
		const draft = proposal.presentation.draft;
		proposal.consent = {
			turn: structuredClone(turn),
			input: {
				requestId: `pr-comment-consent-${createHash("sha256")
					.update(
						JSON.stringify([
							turn.sessionId,
							turn.turnId,
							turn.generation,
							proposal.presentation.requestId,
						])
					)
					.digest("hex")}`,
				draftId: draft.id,
				draftRevision: draft.revision,
				body: draft.body,
				headSha: draft.headSha,
				confirmed: true,
			},
		};
		return true;
	}
	takeConfirmation(turn: ConversationTurnInput, draft: DraftedComment): ConfirmCommentInput | null {
		const proposal = this.fresh(turn.sessionId);
		const consent = proposal?.consent;
		if (
			!proposal ||
			!consent ||
			JSON.stringify(consent.turn) !== JSON.stringify(turn) ||
			!sameCommentDraft(proposal.presentation.draft, draft)
		)
			return null;
		// Keep the exact attempt identity for retries; the canonical ledger deduplicates it.
		return structuredClone(consent.input);
	}
	invalidate(sessionId: string) {
		this.proposals.delete(sessionId);
	}
	clear() {
		this.proposals.clear();
	}
	private fresh(sessionId: string) {
		const proposal = this.proposals.get(sessionId);
		if (proposal && (this.now() < proposal.at || this.now() - proposal.at > this.ttlMs)) {
			this.invalidate(sessionId);
			return undefined;
		}
		return proposal;
	}
}
