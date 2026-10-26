import { createHash, randomUUID } from "node:crypto";
import {
	ConfirmCommentInputSchema,
	type DraftedComment,
	DraftedCommentSchema,
	type PullRequest,
	PullRequestSchema,
} from "../../shared/contracts";
import { abortable, throwIfAborted } from "./cancellation";

export interface CommentPostingPort {
	getPullRequest: (prId: string, signal: AbortSignal) => Promise<PullRequest>;
	/** Runtime must atomically recheck headSha and persist idempotencyKey before GitHub writes.
	 * After an ambiguous network failure it must reconcile that key; never blindly repost.
	 */
	postConfirmedComment: (
		input: { draft: DraftedComment; idempotencyKey: string; expectedHeadSha: string },
		signal: AbortSignal
	) => Promise<{ url: string }>;
}

/** The model can create drafts, but has no tool that calls confirmAndPost. */
export class CommentDrafts {
	private readonly drafts = new Map<string, DraftedComment>();
	private readonly attempts = new Map<
		string,
		{ fingerprint: string; result: Promise<{ url: string }> }
	>();
	private readonly posting = new Set<string>();
	constructor(private readonly port: CommentPostingPort) {}

	create(input: Omit<DraftedComment, "id" | "revision">): DraftedComment {
		const draft = DraftedCommentSchema.parse({ ...input, id: randomUUID(), revision: 1 });
		this.assertLocation(draft);
		this.drafts.set(draft.id, draft);
		return structuredClone(draft);
	}

	get(id: string): DraftedComment {
		const draft = this.drafts.get(id);
		if (!draft) throw new Error("Comment draft not found");
		return structuredClone(draft);
	}

	edit(id: string, body: string): DraftedComment {
		if (this.posting.has(id)) throw new Error("Cannot edit a posting or posted draft");
		const previous = this.get(id);
		const draft = DraftedCommentSchema.parse({
			...previous,
			body,
			revision: previous.revision + 1,
		});
		this.drafts.set(id, draft);
		return structuredClone(draft);
	}

	confirmAndPost(raw: unknown, signal: AbortSignal): Promise<{ url: string }> {
		const input = ConfirmCommentInputSchema.parse(raw);
		const draft = this.get(input.draftId);
		if (draft.evidence.kind === "fixture")
			throw new Error("Fixture drafts cannot be posted to GitHub");
		if (
			input.draftRevision !== draft.revision ||
			input.headSha !== draft.headSha ||
			input.body !== draft.body
		) {
			throw new Error("Confirmation is stale; review and confirm the current draft");
		}
		const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
		const attempt = this.attempts.get(input.requestId);
		if (attempt) {
			if (attempt.fingerprint !== fingerprint)
				throw new Error("Confirmation request ID reused with different data");
			return attempt.result;
		}
		if (this.posting.has(draft.id))
			throw new Error("Draft already submitted; reconcile the original posting attempt");
		throwIfAborted(signal);
		this.posting.add(draft.id);
		const result = this.post(draft, input.requestId, signal);
		// Keep successful AND failed attempts: a network failure may have happened after the write.
		this.attempts.set(input.requestId, { fingerprint, result });
		return result;
	}

	private async post(draft: DraftedComment, requestId: string, signal: AbortSignal) {
		let submissionStarted = false;
		try {
			const pr = PullRequestSchema.parse(
				await abortable(this.port.getPullRequest(draft.prId, signal), signal)
			);
			if (
				pr.id !== draft.prId ||
				pr.headSha !== draft.headSha ||
				(draft.location && draft.location.repository !== pr.repository)
			) {
				throw new Error("Pull request changed; refresh the draft before confirming");
			}
			throwIfAborted(signal);
			submissionStarted = true;
			const result = await abortable(
				this.port.postConfirmedComment(
					{
						draft,
						idempotencyKey: requestId,
						expectedHeadSha: pr.headSha,
					},
					signal
				),
				signal
			);
			const url = new URL(result.url);
			if (url.protocol !== "https:") throw new Error("Invalid GitHub posting receipt");
			return { url: url.toString() };
		} catch (error) {
			// Only failures known to precede the external write may unlock the draft.
			if (!submissionStarted) this.posting.delete(draft.id);
			throw error;
		}
	}

	private assertLocation(draft: DraftedComment) {
		if (
			draft.location &&
			(draft.location.revision !== "head" || draft.location.commitSha !== draft.headSha)
		) {
			throw new Error("Inline draft must reference its exact PR head");
		}
	}
}
