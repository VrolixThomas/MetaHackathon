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
