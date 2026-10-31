import {
	type CodeLocation,
	CodeLocationSchema,
	type PullRequest,
	PullRequestSchema,
	type ReviewFile,
} from "../../shared/contracts";
import type { PreparedController } from "../prepared/controller";
import { patchLines, sourceLines } from "../prepared/diff";

export type PRCommentContext = {
	pr: PullRequest;
	reviewId: string;
	file: ReviewFile;
	selectedLine: number | null;
};

/** Only the actual ready, pinned file in the default prepared-review flow is eligible. */
export function preparedCommentContext(
	state: ReturnType<PreparedController["store"]["getState"]>
): PRCommentContext | null {
	const { detail, file, screen, highlight } = state;
	const plan = detail?.prepared;
	if (
		state.stale ||
		state.fileBusy ||
		state.reviewError ||
		detail?.status !== "ready" ||
		!plan ||
		!file ||
		screen.mode !== "review" ||
		screen.prId !== detail.pr.id ||
		screen.reviewId !== plan.id ||
		screen.path !== file.path ||
		screen.baseSha !== detail.pr.baseSha ||
		screen.headSha !== detail.pr.headSha ||
		plan.pr.id !== detail.pr.id ||
		plan.pr.repository !== detail.pr.repository ||
		plan.pr.baseSha !== detail.pr.baseSha ||
		plan.pr.headSha !== detail.pr.headSha ||
		file.prId !== detail.pr.id ||
		file.base.commitSha !== detail.pr.baseSha ||
		file.head.commitSha !== detail.pr.headSha ||
		file.head.path !== file.path ||
		!plan.files.some((entry) => entry.path === file.path)
	)
		return null;
	const context: PRCommentContext = {
		pr: PullRequestSchema.parse(detail.pr),
		reviewId: plan.id,
		file,
		selectedLine: null,
	};
	if (
		highlight?.revision === "head" &&
		highlight.repository === detail.pr.repository &&
		highlight.path === file.path &&
		highlight.commitSha === detail.pr.headSha &&
		canCommentOnLine(context, highlight.endLine)
	)
		context.selectedLine = highlight.endLine;
	return context;
}

export function canCommentOnLine(context: PRCommentContext, line: number) {
	return (
		Number.isSafeInteger(line) &&
		line > 0 &&
		context.file.head.status === "available" &&
		context.file.head.content !== null &&
		line <= sourceLines(context.file.head.content).length &&
		patchLines(context.file.patch ?? "").some((entry) => entry.head === line)
	);
}

/** GitHub's existing posting adapter supports a single RIGHT-side diff line. */
export function commentLocation(context: PRCommentContext, line: string): CodeLocation | undefined {
	if (!line) return undefined;
	if (!/^\d+$/.test(line) || !canCommentOnLine(context, Number(line)))
		throw new Error("Choose a head-side line present in this file's diff, or use a PR comment.");
	return CodeLocationSchema.parse({
		repository: context.pr.repository,
		revision: "head",
		commitSha: context.pr.headSha,
		path: context.file.path,
		startLine: Number(line),
		endLine: Number(line),
	});
}

export function commentContextKey(context: PRCommentContext | null) {
	return context
		? JSON.stringify([context.pr, context.reviewId, context.file.path, context.selectedLine])
		: "";
}
