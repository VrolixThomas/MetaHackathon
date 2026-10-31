import { z } from "zod";
import type { TeamAccess } from "./access";
import { CreateOrganizationSchema, RegisterRepositorySchema } from "./desktop-schemas";
import type { HostedGitHub } from "./github";
import { TeamError } from "./protocol";
import { type SupabaseRest, query } from "./supabase";

export async function onboard(
	path: string,
	body: unknown,
	jwt: string,
	githubToken: string,
	options: {
		access: Pick<TeamAccess, "identify" | "github">;
		admin: SupabaseRest;
		github: Pick<HostedGitHub, "installation" | "authorize">;
	}
) {
	const actor = await options.access.identify(jwt, githubToken);
	if (path === "/v1/organizations/create") {
		const input = CreateOrganizationSchema.parse(body);
		return options.admin.rpc("team_create_organization", {
			p_user: actor.userId,
			p_name: input.name,
			p_request: input.requestId,
		});
	}
	const input = RegisterRepositorySchema.parse(body);
	const owners = z
		.array(z.object({ org_id: z.uuid() }))
		.max(1)
		.parse(
			await actor.db.request(
				query("team_organization_owners", { org_id: input.orgId, user_id: actor.userId }, "org_id")
			)
		);
	if (!owners[0]) throw new TeamError("forbidden");
	const source = z
		.object({
			id: z.number().int().positive(),
			full_name: z.string(),
			permissions: z.object({ admin: z.boolean() }),
		})
		.parse(await options.access.github(`/repos/${input.repository}`, githubToken));
	if (
		!source.permissions.admin ||
		source.full_name.toLowerCase() !== input.repository.toLowerCase()
	)
		throw new TeamError("forbidden");
	const installation = await options.github.installation(source.full_name, input.installationId);
	await options.github.authorize({
		org_id: input.orgId,
		repository_id: String(source.id),
		full_name: source.full_name,
		installation_id: installation,
		enabled: true,
	});
	return options.admin.rpc("team_register_repository", {
		p_user: actor.userId,
		p_org: input.orgId,
		p_repository: String(source.id),
		p_name: source.full_name,
		p_installation: installation,
		p_request: input.requestId,
	});
}
