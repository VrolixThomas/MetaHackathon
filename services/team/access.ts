import { z } from "zod";
import { RepositoryId, TeamError, boundedJson } from "./protocol";
import { type SupabaseRest, query } from "./supabase";

export const RepositorySchema = z.object({
	org_id: z.uuid(),
	repository_id: RepositoryId,
	full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
	installation_id: RepositoryId,
	enabled: z.boolean(),
});
export type TeamRepository = z.infer<typeof RepositorySchema>;
const userSchema = z.object({
	id: z.uuid(),
	identities: z.array(
		z.object({
			provider: z.string(),
			identity_data: z
				.object({ sub: z.string().optional(), provider_id: z.string().optional() })
				.passthrough(),
		})
	),
});
/** Both credentials are independently validated against their issuer, then matched by stable GitHub subject. */
export class TeamAccess {
	constructor(
		private readonly options: {
			admin: SupabaseRest;
			user: (jwt: string) => SupabaseRest;
			fetch?: typeof fetch;
			now?: () => number;
		}
	) {}
	async github(path: string, token: string): Promise<unknown> {
		let response: Response;
		try {
			response = await (this.options.fetch ?? fetch)(`https://api.github.com${path}`, {
				redirect: "error",
				signal: AbortSignal.timeout(15000),
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
				},
			});
		} catch {
			throw new TeamError("unavailable");
		}
		if (!response.ok)
			throw new TeamError(
				response.status === 401
					? "unauthorized"
					: response.status === 429 ||
							response.status >= 500 ||
							response.headers.get("x-ratelimit-remaining") === "0" ||
							response.headers.has("retry-after")
						? "unavailable"
						: "forbidden",
				response.status
			);
		return boundedJson(response, 1000000);
	}
	async authorize(
		jwt: string,
		githubToken: string,
		orgId: string,
		repositoryId: string
	): Promise<{
		userId: string;
		githubId: string;
		githubLogin: string;
		repository: TeamRepository;
		db: SupabaseRest;
	}> {
		z.uuid().parse(orgId);
		RepositoryId.parse(repositoryId);
		const actor = await this.identify(jwt, githubToken);
		const { db, userId, githubId, githubLogin } = actor;
		const memberships = z
			.array(z.object({ active: z.boolean() }))
			.parse(
				await this.options.admin.request(
					query("team_memberships", { org_id: orgId, user_id: userId })
				)
			);
		if (memberships.length !== 1 || !memberships[0]?.active) throw new TeamError("forbidden");
		const repos = z
			.array(RepositorySchema)
			.parse(
				await this.options.admin.request(
					query("team_repositories", { org_id: orgId, repository_id: repositoryId })
				)
			);
		const repository = repos[0];
		if (!repository || !repository.enabled) throw new TeamError("forbidden");
		// GET by immutable ID, using the user's credential, is fresh source authorization.
		const source = z
			.object({ id: z.number().int().positive(), full_name: z.string() })
			.parse(await this.github(`/repositories/${repositoryId}`, githubToken));
		if (
			String(source.id) !== repositoryId ||
			source.full_name.toLowerCase() !== repository.full_name.toLowerCase()
		)
			throw new TeamError("forbidden");
		const now = (this.options.now ?? Date.now)();
		await this.options.admin.request(
			"/rest/v1/team_repository_grants?on_conflict=org_id,repository_id,user_id",
			{
				method: "POST",
				prefer: "resolution=merge-duplicates,return=minimal",
				body: {
					org_id: orgId,
					repository_id: repositoryId,
					user_id: userId,
					github_user_id: githubId,
					checked_at: new Date(now).toISOString(),
					expires_at: new Date(now + 60000).toISOString(),
				},
			}
		);
		return {
			userId,
			githubId: githubId,
			githubLogin,
			repository,
			db,
		};
	}
	async identify(jwt: string, githubToken: string) {
		const db = this.options.user(jwt);
		const user = userSchema.parse(await db.request("/auth/v1/user"));
		const identity = user.identities.find((item) => item.provider === "github");
		if (!identity) throw new TeamError("forbidden");
		const account = z
			.object({ id: z.number().int().positive(), login: z.string().min(1) })
			.parse(await this.github("/user", githubToken));
		if (String(account.id) !== (identity.identity_data.sub ?? identity.identity_data.provider_id))
			throw new TeamError("forbidden");
		return { db, userId: user.id, githubId: String(account.id), githubLogin: account.login };
	}
	async organizations(jwt: string, githubToken: string) {
		const { db } = await this.identify(jwt, githubToken);
		return z
			.array(z.object({ id: z.uuid(), name: z.string().min(1).max(160) }))
			.max(100)
			.parse(
				await db.request("/rest/v1/team_organizations?select=id,name&limit=100&order=name.asc")
			);
	}
	async repositories(jwt: string, githubToken: string, orgId: string, offset = 0) {
		z.uuid().parse(orgId);
		z.int().min(0).max(10000).parse(offset);
		const { userId } = await this.identify(jwt, githubToken);
		const members = z
			.array(z.object({ active: z.boolean() }))
			.max(1)
			.parse(
				await this.options.admin.request(
					query("team_memberships", { org_id: orgId, user_id: userId })
				)
			);
		if (!members[0]?.active) throw new TeamError("forbidden");
		const rows = z
			.array(RepositorySchema)
			.max(11)
			.parse(
				await this.options.admin.request(
					`${query("team_repositories", { org_id: orgId, enabled: "true" })}&order=repository_id&limit=11&offset=${offset}`
				)
			);
		const items: { orgId: string; repositoryId: string; fullName: string }[] = [];
		for (const repository of rows.slice(0, 10)) {
			try {
				const source = z
					.object({ id: z.number().int().positive(), full_name: z.string() })
					.parse(await this.github(`/repositories/${repository.repository_id}`, githubToken));
				if (
					String(source.id) === repository.repository_id &&
					source.full_name.toLowerCase() === repository.full_name.toLowerCase()
				)
					items.push({
						orgId,
						repositoryId: repository.repository_id,
						fullName: repository.full_name,
					});
			} catch (error) {
				if (!(error instanceof TeamError) || error.code !== "forbidden") throw error;
			}
		}
		return { items, nextOffset: rows.length > 10 ? offset + 10 : null };
	}
}
