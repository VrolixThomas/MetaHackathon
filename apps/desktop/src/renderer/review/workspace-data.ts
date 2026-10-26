import type { PRPreparation } from "../../shared/contracts";
import { getReviewFixture } from "../../shared/fixtures/review";
import type { ReviewFile } from "./model";
import { referenceFiles } from "./reference-diff";

export const fixture = getReviewFixture();

/** Fixture excerpts are deliberately separate from the shared evidence and never used for live PRs. */
export function fixtureSources(): ReviewFile[] {
	return referenceFiles.map((file) =>
		file.path === "jobs/cartReminder.ts"
			? {
					...file,
					// The reference identifies the caller at lines 44–45.
					lines: file.lines.map((line) => ({
						...line,
						oldLine: (line.oldLine ?? 0) + 41,
						newLine: (line.newLine ?? 0) + 41,
					})),
				}
			: file
	);
}

export function orderedFiles(preparation: PRPreparation, sources: ReviewFile[]): ReviewFile[] {
	const files = [...preparation.files]
		.sort((a, b) => a.readingOrder - b.readingOrder)
		.map((triage) => {
			const source = sources.find((file) => file.path === triage.path);
			return {
				path: triage.path,
				purpose: source?.purpose ?? triage.reason,
				attention: triage.category.startsWith("mechanical")
					? ("mechanical" as const)
					: triage.attention,
				additions: source?.additions ?? 0,
				deletions: source?.deletions ?? 0,
				lines: source?.lines ?? [],
				sourceAvailable: source?.sourceAvailable ?? !!source,
				sourceError: source?.sourceError,
			};
		});
	return [
		...files,
		...sources
			.filter((source) => !files.some((file) => file.path === source.path))
			.map((source) => ({ ...source, attention: "context" as const })),
	];
}

export const initialFiles = orderedFiles(fixture.preparation, fixtureSources());
export function readingRoute(files: ReviewFile[]) {
	return files.filter((file) => file.attention !== "context" && file.attention !== "mechanical");
}
