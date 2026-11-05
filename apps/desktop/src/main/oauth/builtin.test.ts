import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

const keys = [
	"MUSE_GITHUB_OAUTH_CLIENT_ID",
	"MUSE_GITHUB_OAUTH_CLIENT_SECRET",
	"MUSE_SLACK_OAUTH_CLIENT_ID",
] as const;
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
afterEach(() => {
	for (const key of keys)
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
});
const load = async () =>
	import(`./builtin?case=${Math.random()}`) as Promise<typeof import("./builtin")>;

describe("built-in OAuth registrations", () => {
	test("absent when the build supplied none", async () => {
		for (const key of keys) delete process.env[key];
		const { builtinOAuthClient, resolveOAuthClient } = await load();
		assert.equal(builtinOAuthClient("github"), undefined);
		assert.equal(await resolveOAuthClient("slack", async () => undefined), undefined);
	});
	test("used when no local registration exists", async () => {
		process.env["MUSE_GITHUB_OAUTH_CLIENT_ID"] = " built-id ";
		process.env["MUSE_GITHUB_OAUTH_CLIENT_SECRET"] = "built-secret";
		process.env["MUSE_SLACK_OAUTH_CLIENT_ID"] = "slack-id";
		const { resolveOAuthClient } = await load();
		assert.deepEqual(await resolveOAuthClient("github", async () => undefined), {
			clientId: "built-id",
			clientSecret: "built-secret",
		});
		assert.deepEqual(await resolveOAuthClient("slack", async () => undefined), {
			clientId: "slack-id",
		});
	});
	test("a local registration wins and is never mixed with the built-in secret", async () => {
		process.env["MUSE_GITHUB_OAUTH_CLIENT_ID"] = "built-id";
		process.env["MUSE_GITHUB_OAUTH_CLIENT_SECRET"] = "built-secret";
		const { resolveOAuthClient } = await load();
		assert.deepEqual(await resolveOAuthClient("github", async () => ({ clientId: "local-id" })), {
			clientId: "local-id",
		});
	});
});
