import { randomUUID } from "node:crypto";
import {
	type ReviewKey,
	ReviewKeySchema,
	TeamError,
	artifact,
	digest,
} from "../../../../../services/team/protocol";
import {
	type ConversationPRContext,
	ConversationPRContextSchema,
	type PreparedReview,
	PreparedReviewSchema,
} from "../../shared/contracts";
import { abortable } from "../agent/cancellation";
import type { TeamClient } from "./client";

export type LocalReviewPreparation = (signal: AbortSignal) => Promise<PreparedReview>;

/** Root supplies Muse preparation with approved source context, never private conversation history. */
export async function prepareLocalReview(
	context: ConversationPRContext,
	signal: AbortSignal,
	localPrepare?: LocalReviewPreparation
): Promise<PreparedReview> {
	signal.throwIfAborted();
	if (!localPrepare) throw new TeamError("unavailable");
	const review = PreparedReviewSchema.parse(await abortable(localPrepare(signal), signal));
	signal.throwIfAborted();
	assertReviewSource(context, review);
	return review;
}

function assertReviewSource(context: ConversationPRContext, review: PreparedReview) {
	if (
		review.pr.id !== context.pr.id ||
		review.pr.repository !== context.pr.repository ||
		review.pr.number !== context.pr.number ||
		review.pr.baseSha !== context.pr.baseSha ||
		review.pr.headSha !== context.pr.headSha ||
		review.files.some((file) => !context.files.some((source) => source.path === file.path))
	)
		throw new TeamError("invalid");
}

export function sharedReviewKey(
	context: ConversationPRContext,
	scope: { orgId: string; repositoryId: string; analysisVersion: string }
): ReviewKey {
	const approved = ConversationPRContextSchema.parse(context);
	return ReviewKeySchema.parse({
		orgId: scope.orgId,
		repositoryId: scope.repositoryId,
		analysisVersion: scope.analysisVersion,
		prNumber: approved.pr.number,
		baseSha: approved.pr.baseSha,
		headSha: approved.pr.headSha,
		contextDigest: digest(approved),
	});
}
/** Optional sharing adapter. A cache miss is handled locally, never by a hosted queue. */
export class TeamPreparationProvider {
	constructor(
		private readonly client: Pick<TeamClient, "load" | "publishReview">,
		private readonly scope: { orgId: string; repositoryId: string; analysisVersion: string }
	) {}
	async lookup(raw: ConversationPRContext, signal?: AbortSignal) {
		const context = ConversationPRContextSchema.parse(raw);
		const key = sharedReviewKey(context, this.scope);
		signal?.throwIfAborted();
		const result = await this.client.load(key, signal);
		signal?.throwIfAborted();
		// Offline cache does not establish fresh authorization to reuse shared findings.
		if (result.status !== "current" || !result.artifact) return { key, prepared: null };
		const value = artifact(result.artifact);
		if (digest(value.key) !== digest(key)) throw new TeamError("invalid");
		assertReviewSource(context, value.review);
		return { key, prepared: value.review };
	}
	async publish(context: ConversationPRContext, review: PreparedReview, signal?: AbortSignal) {
		const key = sharedReviewKey(context, this.scope);
		assertReviewSource(context, review);
		signal?.throwIfAborted();
		// Attribution is server-derived; this contains inferred findings, never execution proof.
		return this.client.publishReview(
			{ requestId: randomUUID(), key, review, digest: digest({ key, review }) },
			signal
		);
	}
}
