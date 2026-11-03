import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
	ApprovalConditionSchema,
	ApprovalTermsSchema,
	type PRFixDetail,
	PRFixDetailSchema,
	type PullRequest,
	PullRequestSchema,
} from "../../../shared/contracts";

export const ReviewedFixTermsInputSchema = z.strictObject({
	candidateId: z.string().min(1).max(200),
	action: ApprovalTermsSchema.shape.action,
	expiresAt: ApprovalTermsSchema.shape.expiresAt,
	checks: z.array(ApprovalConditionSchema.options[0]).max(9),
});
/** Main-only ports. detail must call fresh PRFixService.detail (including current source,
 * feedback fingerprint and account checks), never a cached/model-bounded tool packet.
 * reviewed must use the existing acknowledged original-PR display gate. */
export interface ReviewedFixPolicyPorts {
	detail(id: string, signal: AbortSignal): Promise<PRFixDetail>;
	reviewed(sessionId: string, signal: AbortSignal): Promise<PullRequest>;
}
export function reviewedFixTerms(
	raw: PRFixDetail,
	displayed: PullRequest,
	input: z.infer<typeof ReviewedFixTermsInputSchema>
) {
	const { fix, review } = PRFixDetailSchema.parse(raw);
	const pr = PullRequestSchema.parse(displayed);
	const fail = () => {
		throw new Error(
			"The complete reviewed candidate and current original PR must match; no partial or check-only policy is allowed."
		);
	};
	if (
		fix.id !== input.candidateId ||
		fix.phase !== "ready" ||
		!fix.reviewedAt ||
		!fix.headSha ||
		fix.error ||
		!isDeepStrictEqual(fix.pr, pr) ||
		fix.baseSha !== pr.headSha ||
		fix.feedback.prId !== pr.id ||
		!review ||
		review.job.id !== fix.jobId ||
		review.job.state !== "ready" ||
		review.job.repository !== pr.repository ||
		review.job.baseSha !== fix.baseSha ||
		review.job.headSha !== fix.headSha ||
		!isDeepStrictEqual(review.job.feedback, fix.feedback)
	)
		return fail();
	const paths = fix.changedFiles;
	const samePaths = (other: string[]) => isDeepStrictEqual([...paths].sort(), [...other].sort());
	if (
		!paths.length ||
		new Set(paths).size !== paths.length ||
		!samePaths(review.job.changedFiles) ||
		!samePaths(review.files.map((f) => f.path))
	)
		return fail();
	const sources = [...review.files]
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
		.map((file) => {
			if (
				!["added", "modified"].includes(file.status) ||
				file.base.path !== file.path ||
				file.head.path !== file.path ||
				file.base.commitSha !== fix.baseSha ||
				file.head.commitSha !== fix.headSha ||
				file.head.status !== "available" ||
				file.head.content === null ||
				(file.status === "modified" &&
					(file.base.status !== "available" || file.base.content === null)) ||
				(file.status === "added" && (file.base.status !== "missing" || file.base.content !== null))
			)
				return fail();
			return {
				kind: "source" as const,
				path: file.path,
				expectedContent: file.head.content,
				reason:
					"Exact complete contents of the privately reviewed fix; other changes require renewed review.",
			};
		});
	return ApprovalTermsSchema.parse({
		action: input.action,
		expiresAt: input.expiresAt,
		conditions: [...sources, ...input.checks],
	});
}
