import { CodeLocationSchema, PRFixDetailSchema, PinnedSourceSchema } from "../../shared/contracts";

/** The isolated candidate has Git objects that may not exist in the user's clone. */
export function sourceFromPRFix(rawDetail: unknown, rawLocation: unknown) {
	const { fix, review } = PRFixDetailSchema.parse(rawDetail);
	const location = CodeLocationSchema.parse(rawLocation);
	if (
		!review ||
		review.job.id !== fix.jobId ||
		review.job.repository !== fix.pr.repository ||
		review.job.baseSha !== fix.baseSha ||
		review.job.headSha !== fix.headSha ||
		location.repository !== fix.pr.repository ||
		location.endLine - location.startLine >= 500
	)
		throw new Error("This candidate source is unavailable");
	const expected = location.revision === "base" ? fix.baseSha : fix.headSha;
	if (location.commitSha !== expected) throw new Error("The candidate source revision changed");
	const file = review.files.find((file) => file[location.revision].path === location.path);
	const source = file?.[location.revision];
	if (
		!source ||
		source.commitSha !== expected ||
		source.status !== "available" ||
		source.content === null
	)
		throw new Error("This candidate has no readable text at the selected location");
	const lines = source.content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	const endLine = Math.min(location.endLine, lines.length);
	if (location.startLine > endLine) throw new Error("This candidate source range is unavailable");
	return PinnedSourceSchema.parse({
		location: { ...location, endLine },
		text: lines.slice(location.startLine - 1, endLine).join(""),
		language: null,
		truncated: endLine < location.endLine,
	});
}
