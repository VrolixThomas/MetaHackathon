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
		orgId: scope.orgId,
		repositoryId: scope.repositoryId,
		analysisVersion: scope.analysisVersion,
		prNumber: approved.pr.number,
		baseSha: approved.pr.baseSha,
		headSha: approved.pr.headSha,
		contextDigest: digest(approved),
	});
}
export class TeamPreparationProvider {
	constructor(
		private readonly client: Pick<TeamClient, "load" | "requestPreparation" | "preparationStatus">,
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
	/** A cache miss enqueues the same pinned input on the hosted consumer; never prepares a second local model result. */
	async prepare(context: ConversationPRContext, signal: AbortSignal) {
		signal.throwIfAborted();
		const first = await this.lookup(context);
		signal.throwIfAborted();
		if (first.prepared) return first.prepared;
		signal.throwIfAborted();
		await this.client.requestPreparation(first.key);
		const expires = Date.now() + 300000;
		while (Date.now() < expires) {
			await new Promise<void>((resolve, reject) => {
				const abort = () => {
					clearTimeout(timer);
					reject(new TeamError("unavailable"));
				};
				const timer = setTimeout(() => {
					signal.removeEventListener("abort", abort);
					resolve();
				}, 1000);
				if (signal.aborted) abort();
				else signal.addEventListener("abort", abort, { once: true });
			});
			signal.throwIfAborted();
			const next = await this.lookup(context);
			signal.throwIfAborted();
			if (next.prepared) return next.prepared;
			if ((await this.client.preparationStatus(first.key)).status === "failed")
				throw new TeamError("unavailable");
		}
		throw new TeamError("unavailable");
	}
}
