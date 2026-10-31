import { arch, platform } from "node:os";
import { type ProposalBundle, validateBundle } from "../../../../../services/team/proposals";
import { digest, sha256 } from "../../../../../services/team/protocol";
import {
	type ConversationPRContext,
	type PRFixDetail,
	PRFixDetailSchema,
} from "../../shared/contracts";
import { sharedReviewKey } from "../team/provider";

/** Export exact inspected local files/check logs; neither author approval nor hosted execution. */
export async function localFixProposal(
	raw: PRFixDetail,
	scope: { orgId: string; repositoryId: string; repository: string; analysisVersion: string },
	ports: {
		context(prId: string, signal: AbortSignal): Promise<ConversationPRContext>;
		log(id: string): Promise<string>;
	},
	signal: AbortSignal
): Promise<ProposalBundle> {
	const { fix, review } = PRFixDetailSchema.parse(raw);
	if (
		!review ||
		fix.phase !== "ready" ||
		!fix.headSha ||
		review.job.headSha !== fix.headSha ||
		review.job.baseSha !== fix.baseSha ||
		fix.pr.repository !== scope.repository ||
		!fix.reviewedAt
	)
		throw new Error("Inspect and mark the exact local fix reviewed before sharing it.");
	const context = await ports.context(fix.pr.id, signal);
	signal.throwIfAborted();
	if (context.pr.headSha !== fix.baseSha || context.pr.repository !== scope.repository)
		throw new Error("The PR head changed before sharing.");
	const feedback = /:(inline|conversation):([1-9][0-9]*)$/.exec(fix.feedback.id);
	if (!feedback) throw new Error("Share an individual inline or general PR comment fix.");
	const files: ProposalBundle["files"] = [];
	const patches: string[] = [];
	for (const file of review.files) {
		const blob = (side: typeof file.base) => {
			if (side.status === "missing") return null;
			if (side.status !== "available" || side.content === null)
				throw new Error("Shared fixes require exact available UTF-8 source.");
			return { text: side.content, sha256: sha256(side.content) };
		};
		if (file.base.commitSha !== fix.baseSha || file.head.commitSha !== fix.headSha || !file.patch)
			throw new Error("The local fix source or patch is incomplete.");
		const before = blob(file.base);
		const after = blob(file.head);
		if (file.base.path !== file.head.path && before && after) {
			files.push(
				{ path: file.base.path, before, after: null },
				{ path: file.head.path, before: null, after }
			);
		} else files.push({ path: file.path, before, after });
		patches.push(file.patch);
	}
	const checks: ProposalBundle["checks"] = [];
	for (const check of fix.checks) {
		const output = await ports.log(check.logId);
		signal.throwIfAborted();
		checks.push({
			command: [check.command, ...check.args],
			commitSha: check.commitSha,
			startedAt: check.startedAt,
			finishedAt: check.finishedAt,
			exitCode: check.exitCode,
			environment: `developer-device:${platform()}/${arch()};reported-local-check`,
			output: { text: output, sha256: sha256(output) },
		});
	}
	const patch = patches.join("\n");
	return validateBundle({
		key: sharedReviewKey(context, {
			orgId: scope.orgId,
			repositoryId: scope.repositoryId,
			analysisVersion: scope.analysisVersion,
		}),
		feedback: {
			kind: feedback[1] === "inline" ? "pull-review-comment" : "issue-comment",
			id: feedback[2],
			revision: fix.feedback.updatedAt,
			body: fix.feedback.body,
			bodyDigest: sha256(fix.feedback.body),
		},
		baseSha: fix.baseSha,
		candidateSha: fix.headSha,
		files,
		patch: { text: patch, sha256: sha256(patch) },
		checks,
		checksDigest: digest(checks),
		sourcesDigest: digest(files),
		provenance: "reported-local-candidate",
	});
}
