import assert from "node:assert/strict";
import { test } from "node:test";
import { secureServiceUrl, secureUrl } from "../../../../../services/team/protocol";
import { TeamClient } from "./client";

const userId = "00000000-0000-4000-8000-000000000001";
test("team API preserves its trusted Edge prefix and sends the same separate credentials", async () => {
	for (const suffix of ["", "/"]) {
		let calls = 0;
		const client = new TeamClient({
			url: `https://project.supabase.co/functions/v1/muse-team-api${suffix}`,
			auth: {
				session: async () => ({
					user: { id: userId },
					access_token: "controlled-supabase-user",
					refresh_token: "controlled-refresh",
					expires_at: 2000000000,
				}),
			},
			getGitHubToken: async () => "controlled-github-grant",
			cache: { read: async () => null, write: async () => {} },
			fetch: async (url, init) => {
				calls++;
				assert.equal(
					url,
					"https://project.supabase.co/functions/v1/muse-team-api/v1/organizations"
				);
				assert.equal(init?.method, "POST");
				assert.equal(init?.redirect, "error");
				assert.deepEqual(init?.headers, {
					Authorization: "Bearer controlled-supabase-user",
					"X-GitHub-Token": "controlled-github-grant",
					"Content-Type": "application/json",
				});
				return new Response(JSON.stringify({ analysisVersion: "edge-v1", items: [] }));
			},
		});
		assert.deepEqual(await client.organizations(), { analysisVersion: "edge-v1", items: [] });
		assert.equal(calls, 1);
	}
});

test("service prefixes do not weaken Auth origins, HTTPS or URL identity checks", () => {
	assert.equal(secureServiceUrl("https://team.example").origin, "https://team.example");
	assert.equal(
		secureServiceUrl("http://127.0.0.1:8787/functions/api", true).pathname,
		"/functions/api"
	);
	assert.throws(() => secureUrl("https://project.supabase.co/functions/v1/api"));
	for (const url of [
		"http://remote.example/api",
		"https://user:password@team.example/api",
		"https://team.example/api?token=bad",
		"https://team.example/api#fragment",
		"https://team.example/api/../other",
		"https://team.example/api/%2e%2e/other",
		"https://team.example/api%2fother",
		"https://team.example/api\\other",
		"https://team.example/api//other",
	])
		assert.throws(() => secureServiceUrl(url), url);
});
