import {
	type ReviewKey,
	ReviewKeySchema,
	TeamError,
	digest,
} from "../../../../../services/team/protocol";
import { type ConversationPRContext, ConversationPRContextSchema } from "../../shared/contracts";
import type { TeamClient } from "./client";

/** Root ReviewCoordinator preparation seam. The caller supplies only approved repository context. */
export function sharedReviewKey(
	context: ConversationPRContext,
	scope: { orgId: string; repositoryId: string; analysisVersion: string }
): ReviewKey {
	const approved = ConversationPRContextSchema.parse(context);
	return ReviewKeySchema.parse({
		...scope,
		prNumber: approved.pr.number,
		baseSha: approved.pr.baseSha,
		headSha: approved.pr.headSha,
		contextDigest: digest(approved),
	});
}
export class TeamPreparationProvider {
	constructor(
		private readonly client: Pick<TeamClient, "load">,
		private readonly scope: { orgId: string; repositoryId: string; analysisVersion: string }
	) {}
	async lookup(context: ConversationPRContext) {
		const key = sharedReviewKey(context, this.scope);
		const result = await this.client.load(key);
		// Root must present offline cache as stale; it must never silently narrate it as current.
		if (result.status === "offline-cache") throw new TeamError("offline");
		if (result.artifact && result.artifact.review.pr.repository !== context.pr.repository)
			throw new TeamError("invalid");
		return { key, prepared: result.artifact?.review ?? null };
	}
}
