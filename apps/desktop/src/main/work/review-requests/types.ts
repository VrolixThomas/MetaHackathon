import { z } from "zod";
import {
	CommitShaSchema,
	GitHubRepositorySchema,
	type WorkReviewSchema,
} from "../../../shared/contracts";
export const Login = z.string().regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/);
export const IntentSchema = z.strictObject({
	requestId: z.string().min(1).max(300),
	jobId: z.string().min(1).max(200),
	accountKey: z.string().min(1).max(300),
	actor: Login,
	repository: GitHubRepositorySchema,
	headSha: CommitShaSchema,
	text: z.string().min(1).max(16000),
});
/** Main captures this at actual user ingress, never from a model argument. */
export type ReviewRequestIntent = z.infer<typeof IntentSchema>;
export const PRSchema = z.object({
	number: z.number().int().positive(),
	nodeId: z.string().min(1),
	repository: GitHubRepositorySchema,
	headSha: CommitShaSchema,
	author: Login,
	url: z.string().url(),
	draft: z.boolean(),
	open: z.boolean(),
	reviewers: z.array(Login).max(100),
});
export type ReviewRequestPR = z.infer<typeof PRSchema>;
export const ReceiptSchema = z.strictObject({
	operationId: z.string(),
	jobId: z.string(),
	repository: GitHubRepositorySchema,
	prNumber: z.number().int().positive(),
	prUrl: z.string().url(),
	headSha: CommitShaSchema,
	reviewers: z.array(Login),
	requestedAt: z.iso.datetime(),
	evidence: z.enum(["request-response", "already-requested"]),
});
export type ReviewRequestReceipt = z.infer<typeof ReceiptSchema>;
export interface ReviewRequestProvider {
	read(repository: string, number: number, signal: AbortSignal): Promise<ReviewRequestPR>;
	canReview(repository: string, login: string, signal: AbortSignal): Promise<boolean>;
	ready(pr: ReviewRequestPR, signal: AbortSignal): Promise<void>;
	request(pr: ReviewRequestPR, reviewers: string[], signal: AbortSignal): Promise<ReviewRequestPR>;
}
export interface ReviewRequestPorts {
	/** Current acknowledged selected job; null when selection is no longer this job. */
	selected(jobId: string, signal: AbortSignal): Promise<z.infer<typeof WorkReviewSchema> | null>;
	/** Existing WorkJobs.publish; its draft-only semantics remain unchanged. */
	publish(jobId: string): Promise<unknown>;
	/** Fresh GitHub actor and credential/account epoch. */
	account(signal: AbortSignal): Promise<{ accountKey: string; login: string }>;
	provider: ReviewRequestProvider;
}
export class ReviewRequestError extends Error {
	constructor(readonly code: "denied" | "changed" | "unavailable" | "unknown" | "busy") {
		super(
			`review-request-${code}: ${code === "unknown" ? "Delivery is uncertain. Inspect the existing request; do not resend automatically." : "The review request could not be verified. Check the selected work, account and named reviewers."}`
		);
	}
}
/** Narrow, whole-utterance admission. No quote, condition, negation or how-to authority. */
export function requestedReviewers(text: string): string[] | null {
	const match =
		/^(?:please\s+)?(?:send\s+(?:this|the selected|the completed)\s+(?:work|job|pull request|PR)\s+(?:to\s+(.+?)\s+for\s+(?:team\s+)?review|for\s+(?:team\s+)?review\s+to\s+(.+?))|request\s+(?:a\s+)?review\s+from\s+(.+?))(?:\s+please)?[.!]?$/i.exec(
			text.trim()
		);
	if (!match) return null;
	const names = (match[1] ?? match[2] ?? match[3] ?? "")
		.split(/\s*,\s*|\s+and\s+/i)
		.map((n) => n.trim().replace(/^@/, "").toLowerCase());
	if (!names.length || names.length > 10 || names.some((n) => !Login.safeParse(n).success))
		return null;
	return [...new Set(names)].sort();
}
