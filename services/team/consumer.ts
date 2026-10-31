import { z } from "zod";
import type { AgentModelClient } from "../../apps/desktop/src/main/agent/meta-client";
import { prepareReview } from "../../apps/desktop/src/main/agent/prepare-review";
import {
	ConversationPRContextSchema,
	type PreparedReview,
} from "../../apps/desktop/src/shared/contracts";
import { RepositorySchema, type TeamRepository } from "./access";
import type { HostedGitHub } from "./github";
import { ReviewKeySchema, TeamError, artifact, digest } from "./protocol";
import { type SupabaseRest, query } from "./supabase";
import { WebhookPayloadSchema } from "./webhook";

const LeaseSchema = z.object({
	lease_token: z.uuid(),
	attempts: z.int().positive(),
	org_id: z.uuid(),
	repository_id: z.string(),
});
const WebhookLeaseSchema = LeaseSchema.extend({
	delivery_id: z.uuid(),
	installation_id: z.string(),
	payload: WebhookPayloadSchema,
});
const PreparationLeaseSchema = LeaseSchema.extend({
	id: z.uuid(),
	key: ReviewKeySchema,
	context: ConversationPRContextSchema,
});
/** Supervised durable consumer; one invocation handles one leased item. No Git writes/builds/coding credentials. */
export class TeamConsumer {
	constructor(
		private readonly options: {
			db: SupabaseRest;
			github: Pick<HostedGitHub, "context">;
			model: AgentModelClient;
			analysisVersion: string;
			heartbeatMs?: number;
		}
	) {}
	private async repository(org: string, id: string): Promise<TeamRepository> {
		const rows = z
			.array(RepositorySchema)
			.max(1)
			.parse(
				await this.options.db.request(
					query("team_repositories", { org_id: org, repository_id: id, enabled: "true" })
				)
			);
		if (!rows[0]) throw new TeamError("forbidden");
		return rows[0];
	}
	async tick(queue: "webhook" | "preparation", signal: AbortSignal): Promise<boolean> {
		if (signal.aborted) return false;
		const raw = await this.options.db.rpc("team_claim", { p_queue: queue, p_lease_seconds: 120 });
		if (raw === null) return false;
		const base = LeaseSchema.parse(raw);
		const id =
			queue === "webhook"
				? WebhookLeaseSchema.parse(raw).delivery_id
				: PreparationLeaseSchema.parse(raw).id;
		const controller = new AbortController();
		const combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(600000)]);
		let renewing = false;
		const heartbeat = setInterval(() => {
			if (renewing) return;
			renewing = true;
			void this.options.db
				.rpc("team_renew", { p_queue: queue, p_id: id, p_token: base.lease_token, p_seconds: 120 })
				.then(
					(ok) => {
						if (ok !== true) controller.abort();
					},
					() => controller.abort()
				)
				.finally(() => {
					renewing = false;
				});
		}, this.options.heartbeatMs ?? 30000);
		try {
			const repository = await this.repository(base.org_id, base.repository_id);
			if (queue === "webhook") {
				const job = WebhookLeaseSchema.parse(raw);
				if (job.installation_id !== repository.installation_id) throw new TeamError("forbidden");
				const { context, contextDigest } = await this.options.github.context(
					repository,
					job.payload.number,
					combined
				);
				const key = ReviewKeySchema.parse({
					orgId: repository.org_id,
					repositoryId: repository.repository_id,
					prNumber: context.pr.number,
					baseSha: context.pr.baseSha,
					headSha: context.pr.headSha,
					contextDigest,
					analysisVersion: this.options.analysisVersion,
				});
				combined.throwIfAborted();
				await this.options.db.rpc("team_enqueue_preparation", {
					p_key: key,
					p_context: context,
					p_webhook: id,
					p_token: job.lease_token,
				});
			} else {
				const job = PreparationLeaseSchema.parse(raw);
				if (
					job.key.orgId !== repository.org_id ||
					job.key.repositoryId !== repository.repository_id ||
					job.key.analysisVersion !== this.options.analysisVersion ||
					digest(job.context) !== job.key.contextDigest
				)
					throw new TeamError("invalid");
				const rows = z
					.array(z.object({ key: ReviewKeySchema, review: z.unknown(), digest: z.string() }))
					.max(1)
					.parse(
						await this.options.db.request(
							query("team_review_artifacts", { key: JSON.stringify(job.key) })
						)
					);
				let prepared: PreparedReview;
				if (rows[0]) prepared = artifact(rows[0]).review;
				else {
					const source = await this.options.github.context(repository, job.key.prNumber, combined);
					if (source.contextDigest !== job.key.contextDigest) throw new TeamError("conflict");
					prepared = await prepareReview(this.options.model, job.context, combined);
					// Revalidate authorization and the exact approved revision after potentially long model work.
					const final = await this.options.github.context(
						await this.repository(base.org_id, base.repository_id),
						job.key.prNumber,
						combined
					);
					if (final.contextDigest !== job.key.contextDigest) throw new TeamError("conflict");
				}
				combined.throwIfAborted();
				const value = artifact({
					key: job.key,
					review: prepared,
					digest: digest({ key: job.key, review: prepared }),
				});
				await this.options.db.rpc("team_finish_preparation", {
					p_id: id,
					p_token: job.lease_token,
					p_review: value.review,
					p_digest: value.digest,
				});
			}
			return true;
		} catch (error) {
			const code =
				error instanceof TeamError
					? error.code === "forbidden"
						? "revoked"
						: error.code === "invalid"
							? "invalid"
							: error.code === "conflict"
								? "source"
								: "unavailable"
					: "provider";
			if (!combined.aborted)
				await this.options.db.rpc("team_fail", {
					p_queue: queue,
					p_id: id,
					p_token: base.lease_token,
					p_error: code,
				});
			// Cancellation/lease loss leaves an expiring claim for supervised recovery, never an unfenced completion.
			return true;
		} finally {
			clearInterval(heartbeat);
		}
	}
}
