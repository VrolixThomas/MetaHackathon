import type { PRFixDetail, PRFixSummary, ReviewFile } from "../../shared/contracts";
import { patchLines } from "../prepared/diff";

export function fixSourceKey(fix: PRFixSummary) {
	return JSON.stringify([fix.id, fix.jobId, fix.pr, fix.feedback, fix.baseSha]);
}
export function validateFix(fix: PRFixSummary) {
	if (
		fix.feedback.prId !== fix.pr.id ||
		fix.baseSha !== fix.pr.headSha ||
		new Set(fix.changedFiles).size !== fix.changedFiles.length
	)
		throw new Error("Fix source identity mismatch");
	return fix;
}
const samePaths = (a: string[], b: string[]) =>
	a.length === b.length && [...a].sort().every((path, i) => path === [...b].sort()[i]);

/** A saved job is evidence only when its source and every candidate file match this fix. */
export function loadedReviewMatchesFix(detail: PRFixDetail | null) {
	if (!detail?.review || !detail.fix.headSha) return false;
	const { fix, review } = detail;
	const { job, files } = review;
	return (
		fix.baseSha === fix.pr.headSha &&
		fix.feedback.prId === fix.pr.id &&
		job.id === fix.jobId &&
		job.repository === fix.pr.repository &&
		job.baseSha === fix.baseSha &&
		job.headSha === fix.headSha &&
		(!job.pullRequest || JSON.stringify(job.pullRequest) === JSON.stringify(fix.pr)) &&
		JSON.stringify(job.feedback) === JSON.stringify(fix.feedback) &&
		JSON.stringify(job.checks) === JSON.stringify(fix.checks) &&
		samePaths(job.changedFiles, fix.changedFiles) &&
		new Set(files.map((file) => file.path)).size === files.length &&
		samePaths(
			files.map((file) => file.path),
			fix.changedFiles
		) &&
		files.every(
			(file) =>
				file.base.commitSha === fix.baseSha &&
				file.head.commitSha === fix.headSha &&
				file.head.path === file.path &&
				(file.status === "renamed" || file.base.path === file.path) &&
				[file.base, file.head].every(
					(source) => (source.status === "available") === (source.content !== null)
				)
		)
	);
}

export function validateDetail(detail: PRFixDetail) {
	validateFix(detail.fix);
	if (detail.review && !loadedReviewMatchesFix(detail))
		throw new Error("Candidate review does not match the saved fix");
	return detail;
}
export function diffLineCounts(file: Omit<ReviewFile, "prId">) {
	if (file.patch === null) return null;
	const lines = patchLines(file.patch);
	return {
		added: lines.filter((line) => line.kind === "add").length,
		removed: lines.filter((line) => line.kind === "remove").length,
	};
}
export function hasCandidateSource(
	file: Omit<ReviewFile, "prId"> | undefined,
	view: "diff" | "base" | "head"
) {
	return (
		!!file &&
		(view === "diff"
			? file.patch !== null && patchLines(file.patch).some((line) => line.kind !== "meta")
			: file[view].status === "available" && file[view].content !== null)
	);
}
export const fixPhaseLabel = (fix: PRFixSummary) =>
	fix.reviewedAt
		? "Reviewed locally"
		: {
				preparing: "Preparing",
				prepared: "Prepared",
				executing: "Working on candidate",
				ready: "Ready to review",
				"needs-input": "Needs your input",
				failed: "Failed",
				interrupted: "Interrupted",
			}[fix.phase];
