import assert from "node:assert/strict";
import { test } from "node:test";
import { TeamAccess } from "./access";
import { SupabaseRest } from "./supabase";

const org = "10000000-0000-4000-8000-000000000001";
const user = "00000000-0000-4000-8000-000000000001";
test("independent Supabase and GitHub identity, organization membership AND fresh repo authorization", async () => {
	let subject = "101";
	let membership = true;
	let repo = true;
	let grants = 0;
	const transport = (async (url: unknown) => {
		const path = String(url);
		if (path.endsWith("/auth/v1/user"))
			return Response.json({
				id: user,
				identities: [{ provider: "github", identity_data: { sub: subject } }],
			});
		if (path.includes("team_memberships"))
			return Response.json(membership ? [{ active: true }] : []);
		if (path.includes("team_repositories"))
			return Response.json([
				{
					org_id: org,
					repository_id: "42",
					full_name: "test/repo",
					installation_id: "7",
					enabled: true,
				},
			]);
		if (path.includes("team_repository_grants")) {
			grants++;
			return new Response(null, { status: 204 });
		}
		if (path.endsWith("/user")) return Response.json({ id: 101, login: "a" });
		if (path.endsWith("/repositories/42"))
			return Response.json(repo ? { id: 42, full_name: "test/repo" } : {}, {
				status: repo ? 200 : 404,
			});
		throw new Error("Unexpected controlled URL");
	}) as typeof fetch;
	const admin = new SupabaseRest({
		url: "https://project.supabase.co",
		key: "server-only",
		fetch: transport,
	});
	const access = new TeamAccess({
		admin,
		user: (jwt) =>
			new SupabaseRest({
				url: "https://project.supabase.co",
				key: "public",
				token: jwt,
				fetch: transport,
			}),
		fetch: transport,
	});
	assert.equal((await access.authorize("supabase-jwt", "github-token", org, "42")).userId, user);
	assert.equal(grants, 1);
	subject = "102";
	await assert.rejects(access.authorize("supabase-jwt", "github-token", org, "42"));
	subject = "101";
	membership = false;
	await assert.rejects(access.authorize("supabase-jwt", "github-token", org, "42"));
	membership = true;
	repo = false;
	await assert.rejects(access.authorize("supabase-jwt", "github-token", org, "42"));
	assert.equal(grants, 1);
});
