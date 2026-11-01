import { z } from "zod";
import { abortable } from "../../apps/desktop/src/main/agent/cancellation";
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
	private readonly maxRunMs: number;
	constructor(
		private readonly options: {
			db: SupabaseRest;
			github: Pick<HostedGitHub, "context">;
			model: AgentModelClient;
			analysisVersion: string;
			heartbeatMs?: number;
			/** Full tick budget, including claim and terminal writes. Edge callers use <= 110_000. */
			maxRunMs?: number;
		}
	) {
		this.maxRunMs = z.int().min(1).max(600_000).default(600_000).parse(options.maxRunMs);
	}
	private async repository(org: string, id: string, signal: AbortSignal): Promise<TeamRepository> {
		const rows = z
			.array(RepositorySchema)
			.max(1)
			.parse(
				await this.run(signal, () =>
					this.options.db.request(
						query("team_repositories", { org_id: org, repository_id: id, enabled: "true" }),
						{},
						signal
					)
				)
			);
		if (!rows[0]) throw new TeamError("forbidden");
		return rows[0];
	}
	/** Check before dispatch as well as after await; injected ports may ignore the signal. */
	private async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
		signal.throwIfAborted();
		return abortable(operation(), signal);
	}
	async tick(queue: "webhook" | "preparation", signal?: AbortSignal): Promise<boolean> {
		const controller = new AbortController();
		const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
		const deadline = setTimeout(() => controller.abort(), this.maxRunMs);
		const renewals = new AbortController();
		const renewalSignal = AbortSignal.any([combined, renewals.signal]);
		let heartbeat: ReturnType<typeof setInterval> | undefined;
		let claimed = false;
		const stopRenewals = () => {
			clearInterval(heartbeat);
			renewals.abort();
		};
		try {
			if (combined.aborted) return false;
			const raw = await this.run(combined, () =>
				this.options.db.rpc("team_claim", { p_queue: queue, p_lease_seconds: 120 }, combined)
			);
			if (raw === null) return false;
			claimed = true;
			const base = LeaseSchema.parse(raw);
			const id =
				queue === "webhook"
					? WebhookLeaseSchema.parse(raw).delivery_id
					: PreparationLeaseSchema.parse(raw).id;
			let renewing = false;
			heartbeat = setInterval(() => {
				if (renewing || renewalSignal.aborted) return;
				renewing = true;
				void this.run(renewalSignal, () =>
					this.options.db.rpc(
						"team_renew",
						{ p_queue: queue, p_id: id, p_token: base.lease_token, p_seconds: 120 },
						renewalSignal
					)
				)
					.then(
						(ok) => {
							if (!renewalSignal.aborted && ok !== true) controller.abort();
						},
						() => {
							if (!renewalSignal.aborted) controller.abort();
						}
					)
					.finally(() => {
						renewing = false;
					});
			}, this.options.heartbeatMs ?? 30000);

			try {
				const repository = await this.repository(base.org_id, base.repository_id, combined);
				if (queue === "webhook") {
					const job = WebhookLeaseSchema.parse(raw);
					if (job.installation_id !== repository.installation_id) throw new TeamError("forbidden");
					const { context, contextDigest } = await this.run(combined, () =>
						this.options.github.context(repository, job.payload.number, combined)
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
					stopRenewals();
					await this.run(combined, () =>
						this.options.db.rpc(
							"team_enqueue_preparation",
							{
								p_key: key,
								p_context: context,
								p_webhook: id,
								p_token: job.lease_token,
							},
							combined
						)
					);
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
							await this.run(combined, () =>
								this.options.db.request(
									query("team_review_artifacts", { key: JSON.stringify(job.key) }),
									{},
									combined
								)
							)
						);
					let prepared: PreparedReview;
					if (rows[0]) prepared = artifact(rows[0]).review;
					else {
						const source = await this.run(combined, () =>
							this.options.github.context(repository, job.key.prNumber, combined)
						);
						if (source.contextDigest !== job.key.contextDigest) throw new TeamError("conflict");
						prepared = await this.run(combined, () =>
							prepareReview(this.options.model, job.context, combined)
						);
						// Revalidate authorization and the exact approved revision after potentially long model work.
						const currentRepository = await this.repository(
							base.org_id,
							base.repository_id,
							combined
						);
						const final = await this.run(combined, () =>
							this.options.github.context(currentRepository, job.key.prNumber, combined)
						);
						if (final.contextDigest !== job.key.contextDigest) throw new TeamError("conflict");
					}
					combined.throwIfAborted();
					const value = artifact({
						key: job.key,
						review: prepared,
						digest: digest({ key: job.key, review: prepared }),
					});
					stopRenewals();
					await this.run(combined, () =>
						this.options.db.rpc(
							"team_finish_preparation",
							{
								p_id: id,
								p_token: job.lease_token,
								p_review: value.review,
								p_digest: value.digest,
							},
							combined
						)
					);
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
				stopRenewals();
				if (!combined.aborted)
					await this.run(combined, () =>
						this.options.db.rpc(
							"team_fail",
							{
								p_queue: queue,
								p_id: id,
								p_token: base.lease_token,
								p_error: code,
							},
							combined
						)
					);
				// Cancellation/lease loss leaves an expiring claim for supervised recovery, never an unfenced completion.
				return true;
			}
		} catch (error) {
			if (!combined.aborted) throw error;
			return claimed;
		} finally {
			clearTimeout(deadline);
			stopRenewals();
			controller.abort();
		}
	}
}
