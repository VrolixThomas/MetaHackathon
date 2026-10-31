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
			throw new TeamError(response.status === 401 ? "unauthorized" : "forbidden", response.status);
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
		const db = this.options.user(jwt);
		const user = userSchema.parse(await db.request("/auth/v1/user"));
		const identity = user.identities.find((item) => item.provider === "github");
		if (!identity) throw new TeamError("forbidden");
		const account = z
			.object({ id: z.number().int().positive(), login: z.string().min(1) })
			.parse(await this.github("/user", githubToken));
		if (String(account.id) !== (identity.identity_data.sub ?? identity.identity_data.provider_id))
			throw new TeamError("forbidden");
		const memberships = z
			.array(z.object({ active: z.boolean() }))
			.parse(
				await this.options.admin.request(
					query("team_memberships", { org_id: orgId, user_id: user.id })
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
					user_id: user.id,
					github_user_id: String(account.id),
					checked_at: new Date(now).toISOString(),
					expires_at: new Date(now + 60000).toISOString(),
				},
			}
		);
		return {
			userId: user.id,
			githubId: String(account.id),
			githubLogin: account.login,
			repository,
			db,
		};
	}
}
