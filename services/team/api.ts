import { z } from "zod";
import type { TeamAccess, TeamRepository } from "./access";
import type { HostedGitHub } from "./github";
import { onboard } from "./onboarding";
import {
	type ProposalBundle,
	ProposalDecisionSchema,
	ShareProposalSchema,
	validateBundle,
} from "./proposals";
import {
	ProgressWriteSchema,
	ReviewKeySchema,
	TeamError,
	artifact,
	boundedJson,
	digest,
} from "./protocol";
import { type SupabaseRest, query } from "./supabase";

/** Every operation revalidates source access. All GitHub operations are reads. */
export function createTeamApi(
	access: Pick<TeamAccess, "authorize" | "github" | "organizations" | "repositories"> &
		Partial<Pick<TeamAccess, "identify">>,
	options?: {
		admin: SupabaseRest;
		github: Pick<HostedGitHub, "context"> &
			Partial<Pick<HostedGitHub, "installation" | "authorize">>;
		analysisVersion: string;
	}
) {
	const verifyFeedback = async (
		bundle: ProposalBundle,
		github: string,
		repository: TeamRepository
	) => {
		if (!options) throw new TeamError("unavailable");
		const key = bundle.key;
		const feedback = bundle.feedback;
		const source = z
			.object({
				id: z.number().int(),
				body: z.string(),
				updated_at: z.string(),
				pull_request_url: z.string().optional(),
				issue_url: z.string().optional(),
			})
			.parse(
				await access.github(
					`/repos/${repository.full_name}/${feedback.kind === "pull-review-comment" ? "pulls" : "issues"}/comments/${feedback.id}`,
					github
				)
			);
		const expected = `https://api.github.com/repos/${repository.full_name}/${feedback.kind === "pull-review-comment" ? "pulls" : "issues"}/${key.prNumber}`;
		if (
			String(source.id) !== feedback.id ||
			source.updated_at !== feedback.revision ||
			source.body !== feedback.body ||
			(source.pull_request_url ?? source.issue_url) !== expected
		)
			throw new TeamError("conflict");
		await options.admin.request(
			"/rest/v1/team_feedback_revisions?on_conflict=org_id,repository_id,kind,source_id",
			{
				method: "POST",
				prefer: "resolution=merge-duplicates,return=minimal",
				body: {
					org_id: key.orgId,
					repository_id: key.repositoryId,
					pr_number: key.prNumber,
					kind: feedback.kind,
					source_id: feedback.id,
					revision: feedback.revision,
					body_digest: feedback.bodyDigest,
					checked_at: new Date().toISOString(),
				},
			}
		);
	};
	return async (request: Request): Promise<Response> => {
		try {
			if (request.method !== "POST") return Response.json({ error: "method" }, { status: 405 });
			const jwt = /^Bearer ([^\s]+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
			const github = request.headers.get("x-github-token");
			if (!jwt || !github || github.length > 32768) throw new TeamError("unauthorized");
			const path = new URL(request.url).pathname;
			const body = (await boundedJson(new Response(request.body), 4000000)) as {
				key?: unknown;
				progress?: { key?: unknown };
				bundle?: { key?: unknown };
			};

			if (path === "/v1/organizations/create" || path === "/v1/repositories/register") {
				if (!options?.github.installation || !options.github.authorize || !access.identify)
					throw new TeamError("unavailable");
				return Response.json(
					await onboard(path, body, jwt, github, {
						access: { identify: access.identify.bind(access), github: access.github.bind(access) },
						admin: options.admin,
						github: {
							installation: options.github.installation.bind(options.github),
							authorize: options.github.authorize.bind(options.github),
						},
					})
				);
			}
			if (path === "/v1/proposals/browse" || path === "/v1/proposals/get") {
				const input = z
					.object({
						orgId: z.uuid(),
						repositoryId: z.string(),
						proposalId: z.uuid().optional(),
						prNumber: z.int().positive().optional(),
						offset: z.int().min(0).max(10000).default(0),
					})
					.parse(body);
				const actor = await access.authorize(jwt, github, input.orgId, input.repositoryId);
				const filters: Record<string, string> = {
					org_id: input.orgId,
					repository_id: input.repositoryId,
				};
				if (input.proposalId) filters["id"] = input.proposalId;
				if (input.prNumber) filters["key->>prNumber"] = String(input.prNumber);
				const rows = z
					.array(
						z
							.object({
								id: z.uuid(),
								key: ReviewKeySchema,
								owner_id: z.uuid(),
								bundle_digest: z.string(),
								created_at: z.string(),
								bundle: z.unknown().optional(),
							})
							.passthrough()
					)
					.max(21)
					.parse(
						await actor.db.request(
							`${query("team_fix_proposals", filters, path.endsWith("/get") ? "*" : "id,key,owner_id,bundle_digest,created_at")}&limit=${path.endsWith("/get") ? 1 : 21}&offset=${input.offset}&order=created_at.desc,id`
						)
					);
				const selected = rows.slice(0, path.endsWith("/get") ? 1 : 20);
				const decisions = selected.length
					? z
							.array(z.object({ proposal_id: z.uuid() }).passthrough())
							.max(20)
							.parse(
								await actor.db.request(
									`/rest/v1/team_proposal_decisions?${new URLSearchParams({ select: "*", proposal_id: `in.(${selected.map((row) => row.id).join(",")})` })}`
								)
							)
					: [];
				const items = selected.map((row) => {
					if (row.bundle) {
						const bundle = validateBundle(row.bundle);
						if (digest(bundle) !== row.bundle_digest) throw new TeamError("invalid");
					}
					return {
						...row,
						decision: decisions.find((item) => item.proposal_id === row.id) ?? null,
					};
				});
				return Response.json(
					path.endsWith("/get")
						? (items[0] ?? null)
						: { items, nextOffset: rows.length > 20 ? input.offset + 20 : null }
				);
			}
			if (path === "/v1/organizations") {
				if (!options) throw new TeamError("unavailable");
				return Response.json({
					analysisVersion: options.analysisVersion,
					items: await access.organizations(jwt, github),
				});
			}

			if (path === "/v1/repositories/resolve") {
				const input = z.object({ orgId: z.uuid(), repositoryId: z.string() }).parse(body);
				const actor = await access.authorize(jwt, github, input.orgId, input.repositoryId);
				return Response.json({
					orgId: input.orgId,
					repositoryId: actor.repository.repository_id,
					fullName: actor.repository.full_name,
				});
			}
			if (path === "/v1/repositories") {
				const input = z
					.object({ orgId: z.uuid(), offset: z.int().min(0).max(10000).default(0) })
					.parse(body);
				return Response.json(await access.repositories(jwt, github, input.orgId, input.offset));
			}
			const key = ReviewKeySchema.parse(body?.key ?? body?.progress?.key ?? body?.bundle?.key);
			const actor = await access.authorize(jwt, github, key.orgId, key.repositoryId);
			const { db, userId, repository } = actor;
			if (path === "/v1/reviews/read") {
				if (options && key.analysisVersion !== options.analysisVersion)
					throw new TeamError("conflict");
				const rows = z
					.array(z.object({ key: ReviewKeySchema, review: z.unknown(), digest: z.string() }))
					.max(1)
					.parse(await db.request(query("team_review_artifacts", { key: JSON.stringify(key) })));
				if (rows[0]) {
					if (!options) throw new TeamError("unavailable");
					const current = await options.github.context(repository, key.prNumber, request.signal);
					if (
						current.contextDigest !== key.contextDigest ||
						current.context.pr.headSha !== key.headSha ||
						current.context.pr.baseSha !== key.baseSha
					)
						throw new TeamError("conflict");
				}
				return Response.json(rows[0] ? artifact(rows[0]) : null);
			}

			if (path === "/v1/reviews/status") {
				const rows = z
					.array(
						z.object({
							state: z.enum(["queued", "leased", "ready", "failed"]),
							error_code: z.string().nullable(),
							attempts: z.int(),
						})
					)
					.max(1)
					.parse(
						await db.request(
							query(
								"team_preparation_jobs",
								{ key: JSON.stringify(key) },
								"state,error_code,attempts"
							)
						)
					);
				return Response.json(
					rows[0]
						? { status: rows[0].state, errorCode: rows[0].error_code, attempts: rows[0].attempts }
						: { status: "missing", errorCode: null, attempts: 0 }
				);
			}
			if (path === "/v1/reviews/retry") {
				const input = z.object({ requestId: z.uuid() }).parse(body);
				await db.rpc("team_retry_preparation", { p_key: key, p_request: input.requestId });
				return Response.json({ status: "queued" });
			}
			if (path === "/v1/reviews/request") {
				if (!options) throw new TeamError("unavailable");
				if (key.analysisVersion !== options.analysisVersion) throw new TeamError("conflict");
				const { context, contextDigest } = await options.github.context(
					repository,
					key.prNumber,
					request.signal
				);
				if (
					contextDigest !== key.contextDigest ||
					context.pr.baseSha !== key.baseSha ||
					context.pr.headSha !== key.headSha
				)
					throw new TeamError("conflict");
				await options.admin.rpc("team_request_preparation", { p_key: key, p_context: context });
				return Response.json({ status: "queued", key }, { status: 202 });
			}
			if (path === "/v1/progress/read") {
				const rows = z
					.array(z.object({ progress: z.unknown() }))
					.max(1)
					.parse(
						await db.request(
							query("team_review_progress", { key: JSON.stringify(key), user_id: userId })
						)
					);
				return Response.json(rows[0]?.progress ?? null);
			}
			if (path === "/v1/progress/write") {
				const input = ProgressWriteSchema.parse(body);
				return Response.json(
					await db.rpc("team_write_progress", {
						p_key: key,
						p_progress: input.progress,
						p_expected: input.expectedRevision,
						p_request: input.requestId,
					})
				);
			}
			if (path === "/v1/proposals/list") {
				return Response.json(
					await db.request(
						`${query(
							"team_fix_proposals",
							{ org_id: key.orgId, repository_id: key.repositoryId, key: JSON.stringify(key) },
							"id,key,owner_id,bundle_digest,created_at"
						)}&limit=100&order=created_at.desc`
					)
				);
			}
			if (path === "/v1/proposals/read") {
				const input = z.object({ proposalId: z.uuid() }).parse(body);
				const rows = z
					.array(z.object({ bundle: z.unknown(), bundle_digest: z.string() }).passthrough())
					.max(1)
					.parse(
						await db.request(
							query("team_fix_proposals", {
								id: input.proposalId,
								org_id: key.orgId,
								repository_id: key.repositoryId,
								key: JSON.stringify(key),
							})
						)
					);
				if (rows[0]) {
					const bundle = validateBundle(rows[0].bundle);
					if (digest(bundle) !== rows[0].bundle_digest) throw new TeamError("invalid");
				}
				return Response.json(rows[0] ?? null);
			}

			if (path === "/v1/proposals/authorize-apply") {
				if (!options) throw new TeamError("unavailable");
				const input = z
					.object({ proposalId: z.uuid(), bundleDigest: z.string(), confirmed: z.literal(true) })
					.parse(body);
				const records = z
					.array(z.object({ bundle: z.unknown(), bundle_digest: z.string() }).passthrough())
					.max(1)
					.parse(
						await db.request(
							query("team_fix_proposals", { id: input.proposalId, key: JSON.stringify(key) })
						)
					);
				const record = records[0];
				if (!record || record.bundle_digest !== input.bundleDigest) throw new TeamError("conflict");
				const bundle = validateBundle(record.bundle);
				if (digest(bundle) !== input.bundleDigest) throw new TeamError("invalid");
				const decisions = z
					.array(
						z
							.object({
								id: z.uuid(),
								proposal_id: z.uuid(),
								bundle_digest: z.string(),
								decision: z.literal("accept"),
								author_id: z.uuid(),
								github_author_id: z.string(),
							})
							.passthrough()
					)
					.max(1)
					.parse(
						await db.request(
							query("team_proposal_decisions", {
								proposal_id: input.proposalId,
								decision: "accept",
							})
						)
					);
				const decision = decisions[0];
				if (
					!decision ||
					decision.bundle_digest !== input.bundleDigest ||
					decision.author_id !== userId ||
					decision.github_author_id !== actor.githubId
				)
					throw new TeamError("forbidden");
				const current = z
					.object({
						user: z.object({ id: z.number().int() }),
						head: z.object({ sha: z.string() }),
						base: z.object({ repo: z.object({ id: z.number().int() }) }),
					})
					.parse(
						await access.github(`/repos/${repository.full_name}/pulls/${key.prNumber}`, github)
					);
				if (
					String(current.user.id) !== actor.githubId ||
					String(current.base.repo.id) !== key.repositoryId ||
					current.head.sha !== key.headSha
				)
					throw new TeamError("conflict");
				await verifyFeedback(bundle, github, repository);
				return Response.json({ proposal: { ...record, decision }, decision, userId });
			}
			if (path === "/v1/proposals/share" || path === "/v1/proposals/decide") {
				if (!options) throw new TeamError("unavailable");

				if (path === "/v1/proposals/share") {
					const input = ShareProposalSchema.parse(body);
					const bundle = validateBundle(input.bundle);
					if (digest(bundle) !== input.bundleDigest) throw new TeamError("invalid");
					const previous = await options.admin.rpc("team_find_shared_proposal", {
						p_actor: userId,
						p_request: input.requestId,
						p_digest: input.bundleDigest,
					});
					if (previous !== null) {
						const record = z
							.object({ bundle: z.unknown(), bundle_digest: z.string() })
							.passthrough()
							.parse(previous);
						if (
							digest(validateBundle(record.bundle)) !== input.bundleDigest ||
							record.bundle_digest !== input.bundleDigest
						)
							throw new TeamError("invalid");
						return Response.json(record);
					}
				} else {
					const input = ProposalDecisionSchema.parse(body);
					const previous = z
						.array(
							z
								.object({ proposal_id: z.uuid(), bundle_digest: z.string(), decision: z.string() })
								.passthrough()
						)
						.max(1)
						.parse(
							await db.request(
								query("team_proposal_decisions", { author_id: userId, request_id: input.requestId })
							)
						);
					if (previous[0]) {
						if (
							previous[0].proposal_id !== input.proposalId ||
							previous[0].bundle_digest !== input.bundleDigest ||
							previous[0].decision !== input.decision
						)
							throw new TeamError("conflict");
						const bound = z
							.array(z.object({ key: ReviewKeySchema }))
							.max(1)
							.parse(
								await db.request(
									query(
										"team_fix_proposals",
										{
											id: input.proposalId,
											key: JSON.stringify(key),
											org_id: key.orgId,
											repository_id: key.repositoryId,
										},
										"key"
									)
								)
							);
						if (!bound[0]) throw new TeamError("conflict");

						return Response.json(previous[0]);
					}
				}
				const pr = z
					.object({
						number: z.int(),
						user: z.object({ id: z.number().int() }),
						head: z.object({ sha: z.string() }),
						base: z.object({ repo: z.object({ id: z.number().int() }) }),
					})
					.parse(
						await access.github(`/repos/${repository.full_name}/pulls/${key.prNumber}`, github)
					);
				if (
					pr.number !== key.prNumber ||
					String(pr.base.repo.id) !== key.repositoryId ||
					pr.head.sha !== key.headSha
				)
					throw new TeamError("conflict");
				await options.admin.request(
					"/rest/v1/team_pr_heads?on_conflict=org_id,repository_id,pr_number",
					{
						method: "POST",
						prefer: "resolution=merge-duplicates,return=minimal",
						body: {
							org_id: key.orgId,
							repository_id: key.repositoryId,
							pr_number: key.prNumber,
							head_sha: pr.head.sha,
							github_author_id: String(pr.user.id),
							checked_at: new Date().toISOString(),
						},
					}
				);
				if (path === "/v1/proposals/share") {
					const input = ShareProposalSchema.parse(body);
					const bundle = validateBundle(input.bundle);
					if (digest(bundle) !== input.bundleDigest) throw new TeamError("invalid");
					await verifyFeedback(bundle, github, repository);
					return Response.json(
						await options.admin.rpc("team_share_proposal", {
							p_actor: userId,
							p_bundle: bundle,
							p_digest: input.bundleDigest,
							p_request: input.requestId,
						})
					);
				}
				const input = ProposalDecisionSchema.parse(body);
				if (actor.githubId !== String(pr.user.id)) throw new TeamError("forbidden");
				const rows = z
					.array(z.object({ key: ReviewKeySchema, bundle_digest: z.string(), bundle: z.unknown() }))
					.max(1)
					.parse(
						await db.request(
							query("team_fix_proposals", { id: input.proposalId, key: JSON.stringify(key) })
						)
					);
				if (!rows[0] || rows[0].bundle_digest !== input.bundleDigest)
					throw new TeamError("conflict");
				const selected = validateBundle(rows[0].bundle);
				if (digest(selected) !== input.bundleDigest) throw new TeamError("invalid");
				await verifyFeedback(selected, github, repository);
				return Response.json(
					await options.admin.rpc("team_decide_proposal", {
						p_actor: userId,
						p_id: input.proposalId,
						p_digest: input.bundleDigest,
						p_decision: input.decision,
						p_request: input.requestId,
						p_confirmed: input.confirmed,
					})
				);
			}
			return Response.json({ error: "not-found" }, { status: 404 });
		} catch (error) {
			const code = error instanceof TeamError ? error.code : "invalid";
			return Response.json(
				{ error: code },
				{
					status:
						code === "unauthorized"
							? 401
							: code === "forbidden"
								? 403
								: code === "conflict"
									? 409
									: code === "offline" || code === "unavailable"
										? 503
										: 400,
				}
			);
		}
	};
}
