import {
	type CodeLocation,
	type PRPreparation,
	PRPreparationSchema,
	type SourceFileRequest,
	SourceFileSchema,
} from "../../shared/contracts";
import { highlightLocation, installPreparedReview, useReview } from "./controller";
import { type ReviewFile, parseDiff } from "./model";
import { type SourceAdapter, useServices } from "./services";
import { orderedFiles } from "./workspace-data";

let loadGeneration = 0;

async function readSide(
	adapter: SourceAdapter,
	preparation: PRPreparation,
	request: SourceFileRequest
) {
	const result = SourceFileSchema.parse(await adapter.read(request));
	const expectedSha = request.revision === "base" ? preparation.pr.baseSha : preparation.pr.headSha;
	if (
		result.prId !== request.prId ||
		result.path !== request.path ||
		result.revision !== request.revision ||
		result.repository !== preparation.pr.repository ||
		result.commitSha !== expectedSha
	)
		throw new Error("Source response does not match the requested pinned revision");
	return result;
}

export async function readReviewFile(
	adapter: SourceAdapter,
	preparation: PRPreparation,
	path: string
): Promise<ReviewFile> {
	const [base, head] = await Promise.all([
		readSide(adapter, preparation, { prId: preparation.pr.id, revision: "base", path }),
		readSide(adapter, preparation, { prId: preparation.pr.id, revision: "head", path }),
	]);
	const triage = preparation.files.find((file) => file.path === path);
	const metadata = {
		path,
		purpose: triage?.reason ?? "Caller context",
		attention: triage?.attention ?? ("context" as const),
	};
	if (base.content === null && head.content === null)
		return {
			...metadata,
			lines: [],
			additions: 0,
			deletions: 0,
			sourceAvailable: false,
			sourceError: "This file is absent at both pinned revisions.",
		};
	// A large source remains unavailable rather than silently truncating its line evidence.
	if ((base.content?.split("\n").length ?? 0) + (head.content?.split("\n").length ?? 0) > 20_000)
		return {
			...metadata,
			lines: [],
			additions: 0,
			deletions: 0,
			sourceAvailable: false,
			sourceError:
				"This file exceeds the interactive diff limit. No excerpt or line evidence has been substituted.",
		};
	const lines = parseDiff(base.content ?? "", head.content ?? "");
	return {
		...metadata,
		lines,
		additions: lines.filter((line) => line.kind === "add").length,
		deletions: lines.filter((line) => line.kind === "remove").length,
		sourceAvailable: true,
	};
}

/** Full source responses are checked before replacing the current workspace. */
export async function loadPreparedReview(
	input: PRPreparation,
	adapter: SourceAdapter,
	signal?: AbortSignal
) {
	const generation = ++loadGeneration;
	const preparation = PRPreparationSchema.parse(input);
	const files: ReviewFile[] = [];
	for (const file of preparation.files) {
		signal?.throwIfAborted();
		files.push(await readReviewFile(adapter, preparation, file.path));
		if (generation !== loadGeneration) return false;
	}
	signal?.throwIfAborted();
	installPreparedReview(preparation, {
		repository: preparation.pr.repository,
		baseSha: preparation.pr.baseSha,
		headSha: preparation.pr.headSha,
		files,
	});
	return true;
}

/** A scenario may visit an unchanged caller that was not in the original reading route. */
export async function focusCodeLocation(
	location: CodeLocation,
	note: string,
	signal?: AbortSignal
) {
	if (signal?.aborted) return false;
	const state = useReview.getState();
	const source = state.files.find((file) => file.path === location.path);
	if (source?.lines.length) return highlightLocation(location, note);
	const adapter = useServices.getState().sources;
	const expected =
		location.revision === "base" ? state.preparation.pr.baseSha : state.preparation.pr.headSha;
	if (
		!adapter ||
		location.repository !== state.preparation.pr.repository ||
		location.commitSha !== expected
	)
		return highlightLocation(location, note);
	const sequence = state.sequence;
	try {
		const file = await readReviewFile(adapter, state.preparation, location.path);
		if (signal?.aborted || useReview.getState().sequence !== sequence) return false;
		useReview.setState((current) => ({
			files: orderedFiles(current.preparation, [
				...current.files.filter((source) => source.path !== file.path),
				file,
			]),
		}));
		return highlightLocation(location, note);
	} catch {
		useReview
			.getState()
			.announce(
				"The pinned source could not be loaded. Your current review location is unchanged."
			);
		return false;
	}
}
