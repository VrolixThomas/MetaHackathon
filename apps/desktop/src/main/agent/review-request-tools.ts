import { z } from "zod";
import type { ConversationTurnInput } from "../../shared/contracts";
import {
	Login,
	ReviewRequestError,
	type ReviewRequestIntent,
	type ReviewRequestReceipt,
	requestedReviewers,
} from "../work/review-requests";
import type { FunctionTool } from "./meta-client";
export interface ConversationReviewRequestPorts {
	/** Exact actual ingress, selected job/head and account epoch captured by main. */
	intent(
		turn: ConversationTurnInput,
		signal?: AbortSignal
	): ReviewRequestIntent | null | Promise<ReviewRequestIntent | null>;
	send(
		intent: ReviewRequestIntent,
		reviewerLogins: string[],
		signal: AbortSignal
	): Promise<ReviewRequestReceipt>;
}
const args = z.strictObject({
	jobId: z.string().min(1).max(200),
	reviewerLogins: z.array(Login).min(1).max(10),
});
export class ConversationReviewRequestTools {
	constructor(
		private readonly ports: ConversationReviewRequestPorts,
		private readonly turn: ConversationTurnInput,
		private readonly signal: AbortSignal
	) {}
	get tools(): FunctionTool[] {
		return [
			{
				type: "function",
				name: "send_work_for_review",
				parameters: z.toJSONSchema(args),
				description:
					"Send the actually selected completed work for GitHub review only after the real user explicitly names reviewer logins. Publishes a draft if needed, marks its exact PR ready and requests those reviewers. Requires fresh successful validation and write collaborators. Never merges, approves or completes Linear. Unknown delivery must not be replayed.",
			},
		];
	}
	has(name: string) {
		return name === "send_work_for_review";
	}
	async execute(name: string, raw: string) {
		try {
			this.signal.throwIfAborted();
			if (!this.has(name)) throw new ReviewRequestError("denied");
			const input = args.parse(JSON.parse(raw));
			const intent = await this.ports.intent(this.turn, this.signal);
			this.signal.throwIfAborted();
			const names = requestedReviewers(this.turn.text);
			if (
				!intent ||
				intent.requestId !== this.turn.requestId ||
				intent.text !== this.turn.text ||
				intent.jobId !== input.jobId ||
				!names ||
				JSON.stringify(names) !==
					JSON.stringify([...new Set(input.reviewerLogins.map((n) => n.toLowerCase()))].sort())
			)
				throw new ReviewRequestError("denied");
			return await this.ports.send(intent, input.reviewerLogins, this.signal);
		} catch (error) {
			if (error instanceof ReviewRequestError) throw error;
			throw new ReviewRequestError("unavailable");
		}
	}
}
