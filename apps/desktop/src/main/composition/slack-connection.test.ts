import assert from "node:assert/strict";
import { test } from "node:test";
import type { SlackCredential } from "../slack/types";
import { SlackConnection } from "./slack-connection";

test("OAuth wins over manual tokens, rotation preserves ledger identity, and failed refresh never falls back", async () => {
	let selected: SlackCredential = {
		connectionId: "stable-encrypted-session",
		workspaceId: "TTEST",
		userId: "UTEST",
		appId: "ATEST",
		tokenKind: "user",
		accessToken: "controlled-oauth-first",
		scopes: ["users:read"],
	};
	let fail = false;
	const seen: string[] = [];
	const connection = new SlackConnection({
		readSettings: async () => ({ userToken: "controlled-manual-not-selected", appId: "AMANUAL" }),
		getOAuthCredential: async () => {
			if (fail) throw new Error("controlled refresh failure");
			return selected;
		},
		fetch: async (url, init) => {
			seen.push(new Headers(init?.headers).get("authorization") ?? "");
			return Response.json(
				String(url).endsWith("auth.test")
					? { ok: true, team_id: "TTEST", user_id: "UTEST", team: "Verified workspace" }
					: { ok: true, user: { id: "UTEST", team_id: "TTEST", name: "reviewer" } },
				{ headers: { "x-oauth-scopes": "users:read" } }
			);
		},
	});
	try {
		assert.equal((await connection.credential())?.connectionId, selected.connectionId);
		const epoch = connection.epoch;
		selected = { ...selected, accessToken: "controlled-oauth-rotated" };
		assert.equal((await connection.credential())?.accessToken, selected.accessToken);
		assert.equal(connection.epoch, epoch);
		assert.equal((await connection.status()).account?.userId, "UTEST");
		assert.deepEqual((await connection.status()).missing, []);
		fail = true;
		await assert.rejects(connection.credential());
		const status = await connection.status();
		assert.equal(status.phase, "error");
		assert.equal(status.account, null);
		assert.ok(seen.every((header) => header === "Bearer controlled-oauth-first"));
	} finally {
		connection.dispose();
	}
});

test("Slack token import verifies the actual user and keeps every credential out of public status", async () => {
	const secret = "controlled-user-token";
	let calls = 0;
	const connection = new SlackConnection({
		readSettings: async () => ({
			userToken: secret,
			appId: "ATEST",
			appToken: "controlled-app-secret",
			clientSecret: "controlled-client-secret",
		}),
		fetch: async (url, init) => {
			calls++;
			assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${secret}`);
			return Response.json(
				String(url).endsWith("auth.test")
					? { ok: true, team_id: "TTEST", user_id: "UTEST", team: "Verified workspace" }
					: {
							ok: true,
							user: {
								id: "UTEST",
								team_id: "TTEST",
								name: "reviewer",
								profile: { real_name: "Verified user" },
							},
						},
				{ headers: { "x-oauth-scopes": "users:read,channels:history,chat:write" } }
			);
		},
	});
	try {
		const [a, b] = await Promise.all([connection.credential(), connection.credential()]);
		assert.equal(a?.connectionId, b?.connectionId);
		assert.equal(calls, 3);
		const status = await connection.status();
		assert.equal(status.phase, "connected");
		assert.equal(status.account?.userName, "Verified user");
		assert.doesNotMatch(JSON.stringify(status), /controlled-|accessToken|clientSecret|appToken/);
		assert.equal(calls, 3);
	} finally {
		connection.dispose();
	}
});

test("missing setup does not call Slack and a bot token is never admitted as the user's DM authority", async () => {
	let settings: { userToken?: string; appId?: string } = {};
	let calls = 0;
	const connection = new SlackConnection({
		readSettings: async () => settings,
		fetch: async () => {
			calls++;
			return Response.json({ ok: true, team_id: "TTEST", user_id: "UTEST", bot_id: "BTEST" });
		},
	});
	try {
		assert.equal((await connection.status()).phase, "disconnected");
		assert.equal(calls, 0);
		settings = { userToken: "controlled-bot", appId: "ATEST" };
		assert.equal((await connection.status()).phase, "error");
		assert.equal((await connection.status()).account, null);
		assert.equal(calls, 1, "status polling must not hammer failed credential verification");
		await assert.rejects(connection.refresh());
		assert.equal(calls, 2, "an explicit retry is still available");
	} finally {
		connection.dispose();
	}
});

test("late credential verification cannot overwrite a newer account or resurrect a disposed connection", async () => {
	let token = "controlled-old";
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const connection = new SlackConnection({
		readSettings: async () => ({ userToken: token, appId: "ATEST" }),
		fetch: async (url, init) => {
			const old = new Headers(init?.headers).get("authorization") === "Bearer controlled-old";
			if (old) await held;
			return Response.json(
				String(url).endsWith("auth.test")
					? { ok: true, team_id: "TTEST", user_id: old ? "UOLD" : "UNEW" }
					: {
							ok: true,
							user: { id: old ? "UOLD" : "UNEW", team_id: "TTEST", name: old ? "old" : "new" },
						},
				{ headers: { "x-oauth-scopes": "users:read" } }
			);
		},
	});
	try {
		const stale = connection.credential();
		const rejected = assert.rejects(stale);
		await new Promise<void>((resolve) => setImmediate(resolve));
		token = "controlled-new";
		assert.equal((await connection.credential())?.userId, "UNEW");
		release();
		await rejected;
		assert.equal((await connection.status()).account?.userId, "UNEW");
		connection.dispose();
		assert.equal(await connection.credential(), undefined);
	} finally {
		release();
		connection.dispose();
	}
});
