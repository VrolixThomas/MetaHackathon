import { z } from "zod";
import type { TeamAccess } from "./access";
import { ProgressWriteSchema, ReviewKeySchema, TeamError, artifact, boundedJson } from "./protocol";
import { query } from "./supabase";

/** Authenticated API; every operation revalidates current GitHub account/repository access. No CORS, no remote writes to GitHub. */
export function createTeamApi(access: TeamAccess) {
	return async (request: Request): Promise<Response> => {
		try {
			if (request.method !== "POST") return Response.json({ error: "method" }, { status: 405 });
			const jwt = /^Bearer ([^\s]+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
			const github = request.headers.get("x-github-token");
			if (!jwt || !github || github.length > 32768) throw new TeamError("unauthorized");
			const path = new URL(request.url).pathname;
			const body = await boundedJson(new Response(request.body), 4000000);
			const key = ReviewKeySchema.parse(
				(body as { key?: unknown; progress?: { key?: unknown } })?.key ??
					(body as { progress?: { key?: unknown } })?.progress?.key
			);
			const { db, userId } = await access.authorize(jwt, github, key.orgId, key.repositoryId);
			if (path === "/v1/reviews/read") {
				const rows = z
					.array(z.object({ key: ReviewKeySchema, review: z.unknown(), digest: z.string() }))
					.max(1)
					.parse(await db.request(query("team_review_artifacts", { key: JSON.stringify(key) })));
				return Response.json(rows[0] ? artifact(rows[0]) : null);
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
