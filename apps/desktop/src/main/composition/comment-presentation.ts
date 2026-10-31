import { isDeepStrictEqual } from "node:util";
import {
	type AgentAction,
	type ConfirmCommentInput,
	type ConversationTurnInput,
	type DraftedComment,
	type PRCommentPresentation,
	type PRCommentPresentationReceipt,
	PRCommentPresentationReceiptSchema,
	PRCommentPresentationSchema,
	type PullRequest,
} from "../../shared/contracts";
import {
	PRCommentConfirmationGate,
	commentProposalText,
} from "../agent/pr-comment-tools/confirmation";

type Ports = {
	getDraft(id: string): Promise<DraftedComment>;
	readPR(id: string, signal: AbortSignal): Promise<PullRequest>;
	confirm(input: ConfirmCommentInput): Promise<{ url: string }>;
	publish(action: AgentAction): void;
	voice(input: PRCommentPresentation): boolean;
	narrate(
		input: PRCommentPresentation,
		text: string,
		signal: AbortSignal
	): Promise<"spoken" | "displayed">;
};
const receiptFor = (
	input: PRCommentPresentation,
	status: "applied" | "ignored"
): PRCommentPresentationReceipt => ({
	sessionId: input.sessionId,
	turnId: input.turnId,
	generation: input.generation,
	requestId: input.requestId,
	status,
	draft: input.draft,
});
/** One canonical composer and a main-only confirmation capability for foreground turns. */
export class CommentPresentationCoordinator {
	readonly confirmation = new PRCommentConfirmationGate();
	private readonly pending = new Map<
		string,
		{ input: PRCommentPresentation; finish(receipt: PRCommentPresentationReceipt): void }
	>();
	private readonly drafts = new Map<string, string>();
	private readonly attempts = new Map<string, ConversationTurnInput>();
	constructor(private readonly ports: Ports) {}
	draftId(sessionId: string) {
		return this.drafts.get(sessionId);
	}
	takeConfirmation(turn: ConversationTurnInput, draft: DraftedComment) {
		const input = this.confirmation.takeConfirmation(turn, draft);
		if (input) this.attempts.set(input.requestId, turn);
		return input;
	}
	async confirm(input: ConfirmCommentInput) {
		const turn = this.attempts.get(input.requestId);
		if (!turn) throw new Error("Comment confirmation has no actual user turn");
		const publish = (status: "posting" | "posted" | "uncertain", url?: string) => {
			try {
				this.ports.publish({
					sessionId: turn.sessionId,
					turnId: turn.turnId,
					generation: turn.generation,
					requestId: `${input.requestId}-${status}`,
					screenSequence: 0,
					kind: "comment-post-state",
					confirmation: input,
					status,
					...(url ? { url } : {}),
				});
			} catch {
				/* A cancelled turn cannot publish a late effect; canonical ledger retains outcome. */
			}
		};
		publish("posting");
		try {
			const result = await this.ports.confirm(input);
			publish("posted", result.url);
			this.drafts.delete(turn.sessionId);
			this.confirmation.invalidate(turn.sessionId);
			return result;
		} catch (error) {
			publish("uncertain");
			throw error;
		}
	}
	invalidate(sessionId: string) {
		this.confirmation.invalidate(sessionId);
		this.drafts.delete(sessionId);
		for (const entry of this.pending.values())
			if (entry.input.sessionId === sessionId) entry.finish(receiptFor(entry.input, "ignored"));
	}
	clear() {
		for (const sessionId of new Set([
			...this.drafts.keys(),
			...[...this.pending.values()].map((entry) => entry.input.sessionId),
		]))
			this.invalidate(sessionId);
		this.confirmation.clear();
	}
	async present(
		raw: PRCommentPresentation,
		signal: AbortSignal
	): Promise<PRCommentPresentationReceipt> {
		const input = PRCommentPresentationSchema.parse(raw);
		signal.throwIfAborted();
		const draft = await this.ports.getDraft(input.draft.id);
		if (!isDeepStrictEqual(draft, input.draft)) throw new Error("Comment draft changed");
		this.invalidate(input.sessionId);
		this.drafts.set(input.sessionId, draft.id);
		const receipt = await new Promise<PRCommentPresentationReceipt>((resolve, reject) => {
			let done = false;
			const finish = (value: PRCommentPresentationReceipt) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				signal.removeEventListener("abort", abort);
				this.pending.delete(input.requestId);
				resolve(PRCommentPresentationReceiptSchema.parse(value));
			};
			const abort = () => {
				this.confirmation.invalidate(input.sessionId);
				finish(receiptFor(input, "ignored"));
			};
			const timer = setTimeout(abort, 12000);
			signal.addEventListener("abort", abort, { once: true });
			this.pending.set(input.requestId, { input, finish });
			try {
				this.ports.publish({
					sessionId: input.sessionId,
					turnId: input.turnId,
					generation: input.generation,
					requestId: input.requestId,
					screenSequence: 0,
					kind: "draft-comment",
					draft,
					reviewId: input.reviewId,
				});
			} catch (error) {
				abort();
				reject(error);
			}
		});
		if (receipt.status !== "applied") return receipt;
		const current = await this.ports.getDraft(draft.id);
		const pr = await this.ports.readPR(draft.prId, signal);
		if (!isDeepStrictEqual(current, draft) || pr.headSha !== draft.headSha)
			throw new Error("Comment target changed");
		this.confirmation.presented(input, pr);
		if (this.ports.voice(input)) {
			const text = commentProposalText(pr, draft);
			try {
				if ((await this.ports.narrate(input, text, signal)) !== "spoken")
					throw new Error("Comment proposal was not spoken");
				this.confirmation.spoken(input.sessionId, input.requestId, text);
			} catch (error) {
				this.invalidate(input.sessionId);
				throw error;
			}
		}
		return receipt;
	}
	async applied(raw: PRCommentPresentationReceipt) {
		const receipt = PRCommentPresentationReceiptSchema.parse(raw);
		const pending = this.pending.get(receipt.requestId);
		if (
			!pending ||
			pending.input.sessionId !== receipt.sessionId ||
			pending.input.turnId !== receipt.turnId ||
			pending.input.generation !== receipt.generation ||
			!isDeepStrictEqual(pending.input.draft, receipt.draft)
		)
			return { status: "stale" as const };
		if (
			receipt.status === "applied" &&
			!isDeepStrictEqual(await this.ports.getDraft(receipt.draft.id), receipt.draft)
		)
			return { status: "stale" as const };
		if (this.pending.get(receipt.requestId) !== pending) return { status: "stale" as const };
		pending.finish(receipt);
		return { status: "accepted" as const };
	}
}
