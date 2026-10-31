import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { OAuthStore } from "./store";
import { directory, encryption } from "./test-support";
import { OAuthError, type OAuthSession } from "./types";

function record(provider: "github" | "linear"): OAuthSession {
	return {
		id: randomUUID(),
		provider,
		account: { id: `${provider}-profile`, displayName: "Private Profile" },
		accessToken: `${provider}-private-access`,
		refreshToken: `${provider}-private-refresh`,
		scopes: ["read"],
		expiresAt: Date.now() + 86400000,
		refreshExpiresAt: null,
	};
}

describe("OS-encrypted atomic OAuth sessions", () => {
	test("reads legacy v1 envelopes unchanged and adds/removes an encrypted third provider without replacing old grants", async () => {
		const path = await directory();
		const port = encryption();
		const github = record("github");
		const linear = record("linear");
		const legacy = {
			version: 1,
			github: port.encryptString(JSON.stringify(github)).toString("base64"),
			linear: port.encryptString(JSON.stringify(linear)).toString("base64"),
		};
		const file = join(path, "oauth.sessions.encrypted.json");
		await writeFile(file, JSON.stringify(legacy));
		const store = new OAuthStore(path, port);
		assert.deepEqual(await store.get("github"), github);
		assert.deepEqual(await store.get("linear"), linear);
		assert.equal(await store.get("slack"), undefined);
		const slack: OAuthSession = {
			...record("linear"),
			provider: "slack",
			account: { id: "U123", displayName: "Private Slack User" },
			slack: { appId: "A123", workspaceId: "T123", userId: "U123" },
			refreshExpiresAt: Date.now() + 30 * 86400000,
		};
		await store.set(slack);
		const added = JSON.parse(await readFile(file, "utf8"));
		assert.equal(added.version, 1);
		assert.equal(added.github, legacy.github);
		assert.equal(added.linear, legacy.linear);
		for (const value of ["U123", "T123", "A123", "Private Slack User", slack.id])
			assert.ok(!JSON.stringify(added).includes(value));
		const restarted = new OAuthStore(path, port);
		assert.deepEqual(await restarted.get("slack"), slack);
		await restarted.delete("slack");
		assert.deepEqual(JSON.parse(await readFile(file, "utf8")), legacy);
	});

	test("Slack sessions require validated encrypted user/workspace/app identity and matching public user identity", async () => {
		const store = new OAuthStore(await directory(), encryption());
		const slack: OAuthSession = {
			...record("github"),
			provider: "slack",
			account: { id: "U123", displayName: "Private Slack User" },
			slack: { appId: "A123", workspaceId: "T123", userId: "U123" },
			refreshExpiresAt: Date.now() + 30 * 86400000,
		};
		for (const invalid of [
			{ ...slack, slack: undefined },
			{ ...slack, slack: { ...slack.slack, workspaceId: "../secret" } },
			{ ...slack, account: { id: "U999", displayName: "Wrong user" } },
			{ ...slack, refreshExpiresAt: null },
			{ ...slack, refreshToken: null },
			{ ...slack, provider: "github" },
		])
			await assert.rejects(store.set(invalid as OAuthSession), OAuthError);
		assert.equal(await store.has("slack"), false);
		await store.set(slack);
		assert.deepEqual(await store.get("slack"), slack);
	});

	test("roundtrips both providers, encrypts all fields, uses randomized ciphertext and private atomic files", async () => {
		const path = await directory();
		await chmod(path, 0o755);
		const port = encryption();
		const store = new OAuthStore(path, port);
		const github = record("github");
		const linear = record("linear");
		await Promise.all([store.set(github), store.set(linear)]);
		const file = join(path, "oauth.sessions.encrypted.json");
		const first = await readFile(file, "utf8");
		for (const value of [
			github.id,
			github.accessToken,
			github.refreshToken,
			github.account.id,
			github.account.displayName,
		])
			assert.ok(value && !first.includes(value));
		assert.equal((await stat(file)).mode & 0o777, 0o600);
		assert.equal((await stat(path)).mode & 0o777, 0o700);
		assert.deepEqual(await readdir(path), ["oauth.sessions.encrypted.json"]);
		const restarted = new OAuthStore(path, port);
		assert.deepEqual(await restarted.get("github"), github);
		assert.deepEqual(await restarted.get("linear"), linear);
		await store.set(github);
		assert.notEqual(JSON.parse(first).github, JSON.parse(await readFile(file, "utf8")).github);
		await store.delete("github");
		assert.equal(await store.get("github"), undefined);
		assert.deepEqual(await store.get("linear"), linear);
	});

	test("fails closed on basic_text/unavailable encryption/decryption/tampered records; deletion remains possible", async () => {
		const path = await directory();
		const port = encryption();
		const original = new OAuthStore(path, port);
		await original.set(record("github"));
		for (const encryptionPort of [
			{ ...port, isEncryptionAvailable: () => false },
			{ ...port, getSelectedStorageBackend: () => "basic_text" },
			{
				...port,
				decryptString: () => {
					throw new Error("raw-secret-decrypt");
				},
			},
		]) {
			const store = new OAuthStore(path, encryptionPort);
			assert.equal(await store.has("github"), true);
			await assert.rejects(
				store.get("github"),
				(error: unknown) =>
					error instanceof OAuthError &&
					error.code === "storage" &&
					!error.message.includes("raw-secret")
			);
		}
		const insecure = new OAuthStore(path, {
			...port,
			getSelectedStorageBackend: () => "basic_text",
		});
		await assert.rejects(insecure.set(record("linear")), OAuthError);
		await insecure.delete("github");
		assert.equal(await original.has("github"), false);
		await original.set(record("linear"));
		const file = join(path, "oauth.sessions.encrypted.json");
		const content = JSON.parse(await readFile(file, "utf8"));
		content.github = content.linear;
		await writeFile(file, JSON.stringify(content));
		await assert.rejects(original.get("github"), OAuthError);
	});

	test("a failed encryption/atomic update retains the previous complete session and leaves no temporary files", async () => {
		const path = await directory();
		const port = encryption();
		const store = new OAuthStore(path, port);
		const session = record("linear");
		await store.set(session);
		const broken = new OAuthStore(path, {
			...port,
			encryptString: () => {
				throw new Error("raw-token-error");
			},
		});
		await assert.rejects(broken.set({ ...session, accessToken: "replacement" }), OAuthError);
		assert.deepEqual(await store.get("linear"), session);
		assert.deepEqual(await readdir(path), ["oauth.sessions.encrypted.json"]);
	});
});
