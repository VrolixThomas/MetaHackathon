import type {
	PreparedReview,
	ReviewFile,
	ReviewProgress,
	ReviewScreen,
} from "../../shared/contracts";
import type { MetaItem } from "./meta-client";

const MAX_INPUT_BYTES = 96_000;
type Snapshot = {
	review: PreparedReview | null;
	progress: ReviewProgress | null;
	screen: ReviewScreen;
};
export type CurrentReviewSource = { file: ReviewFile | null; unavailableReason?: string };
type Excerpt = {
	text: string;
	startLine: number | null;
	endLine: number | null;
	totalLines: number;
	truncated: boolean;
};

/** One current-file packet per request; old source packets never enter the tool/chat history. */
export function reviewModelInput(
	history: MetaItem[],
	questionIndex: number,
	snapshot: Snapshot,
	source: CurrentReviewSource
): MetaItem[] {
	const retained = [...history];
	let dropped = 0;
	while (encodedSize(retained) > 32_000 && dropped + 2 <= questionIndex) {
		retained.splice(0, 2);
		dropped += 2;
	}
	const current = snapshot.review?.files.find((file) => file.path === snapshot.screen.path);
	let planTextTruncated = false;
	const clip = (text: string, limit: number) => {
		if (text.length > limit) planTextTruncated = true;
		return text.slice(0, limit);
	};
	const preparedReview = snapshot.review
		? {
				id: snapshot.review.id,
				version: snapshot.review.version,
				pr: snapshot.review.pr,
				createdAt: snapshot.review.createdAt,
				evidence: snapshot.review.evidence,
				coverage: snapshot.review.coverage,
				summary: clip(snapshot.review.summary, 2000),
				orderRationale: clip(snapshot.review.orderRationale, 1000),
				files: snapshot.review.files.map((file) => ({
					path: file.path,
					reason: clip(file.reason, 120),
				})),
			}
		: null;
	const currentFile = current
		? {
				path: current.path,
				reason: clip(current.reason, 1000),
				summary: clip(current.summary, 2000),
				suggestedComments: current.suggestedComments.map((comment) => ({
					...comment,
					body: clip(comment.body, 500),
				})),
			}
		: null;
	const file = source.file;
	const part = (text: string | null) =>
		text === null ? null : excerpt(text, [], 0, lineEnds(text).length);
	const currentFileSource = file
		? {
				status:
					file.patch !== null ||
					file.base.status === "available" ||
					file.head.status === "available"
						? "available"
						: "unavailable",
				prId: file.prId,
				reviewId: snapshot.review?.id,
				repository: snapshot.review?.pr.repository,
				path: file.path,
				fileStatus: file.status,
				patch: {
					status: file.patch === null ? "unavailable" : "available",
					lineNumbers: "patch-text",
					excerpt: part(file.patch),
				},
				base: {
					path: file.base.path,
					commitSha: file.base.commitSha,
					status: file.base.status,
					excerpt: part(file.base.status === "available" ? file.base.content : null),
				},
				head: {
					path: file.head.path,
					commitSha: file.head.commitSha,
					status: file.head.status,
					excerpt: part(file.head.status === "available" ? file.head.content : null),
				},
			}
		: {
				status: "unavailable",
				reason: source.unavailableReason ?? "source-not-supplied",
				path: snapshot.screen.path ?? null,
			};
	const packet = {
		reviewAvailability: snapshot.review ? "ready" : "unavailable",
		preparedReview,
		currentFile,
		reviewProgress: snapshot.progress,
		reviewScreen: snapshot.screen,
		currentFileSource,
		planTextTruncated,
		readingOrderTruncated: false,
		historyTruncated: dropped > 0,
		sourcePolicy:
			"Only currentFileSource excerpts are inspected source. Plan text is inferred. Source line numbers are one-based; patch line numbers index patch text. Omitted source/lines are uninspected.",
	};
	const input = (): MetaItem[] => [
		...retained,
		{ role: "user", content: [{ type: "input_text", text: JSON.stringify(packet) }] },
	];
	// Preserve exact file identities; if plan metadata alone fills the budget, omit tail entries explicitly.
	while (encodedSize(input()) > 48_000 && preparedReview && preparedReview.files.length > 1) {
		preparedReview.files.pop();
		packet.readingOrderTruncated = true;
	}
	while (encodedSize(input()) > 48_000 && dropped + 2 <= questionIndex) {
		retained.splice(0, 2);
		dropped += 2;
		packet.historyTruncated = true;
	}
	if (encodedSize(input()) > MAX_INPUT_BYTES)
		throw new Error("Review input exceeds the source context budget");
	if (file && currentFileSource.patch && currentFileSource.base && currentFileSource.head) {
		const parts: { text: string; target: { excerpt: Excerpt | null } }[] = [];
		if (file.patch !== null) parts.push({ text: file.patch, target: currentFileSource.patch });
		if (file.base.status === "available" && file.base.content !== null)
			parts.push({ text: file.base.content, target: currentFileSource.base });
		if (file.head.status === "available" && file.head.content !== null)
			parts.push({ text: file.head.content, target: currentFileSource.head });
		for (const [index, { text, target }] of parts.entries()) {
			const ends = lineEnds(text);
			const allowance =
				encodedSize(input()) +
				Math.floor((MAX_INPUT_BYTES - encodedSize(input())) / (parts.length - index));
			let low = 0;
			let high = ends.length;
			// Prefix search measures the complete serialized input, including JSON escaping and UTF-8.
			while (low < high) {
				const count = Math.ceil((low + high) / 2);
				target.excerpt = excerpt(text, ends, count, ends.length);
				if (encodedSize(input()) <= allowance) low = count;
				else high = count - 1;
			}
			target.excerpt = excerpt(text, ends, low, ends.length);
		}
	}
	const result = input();
	if (encodedSize(result) > MAX_INPUT_BYTES)
		throw new Error("Review input exceeds the source context budget");
	return result;
}
function encodedSize(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}
function lineEnds(text: string): number[] {
	const ends: number[] = [];
	for (let i = 0; i < text.length; i++) if (text[i] === "\n") ends.push(i + 1);
	if (text.length > 0 && ends.at(-1) !== text.length) ends.push(text.length);
	return ends;
}
function excerpt(text: string, ends: number[], count: number, totalLines: number): Excerpt {
	return {
		text: count ? text.slice(0, ends[count - 1]) : "",
		startLine: count ? 1 : null,
		endLine: count || null,
		totalLines,
		truncated: count < totalLines,
	};
}
