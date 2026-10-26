import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { CredentialStore } from "./credentials";

const paths: string[] = [];
afterEach(async () => {
	for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});
async function store() {
	const directory = await mkdtemp(join(tmpdir(), "runtime-credentials-"));
	paths.push(directory);
	const key = randomBytes(32);
	const encryption = {
		isEncryptionAvailable: () => true,
		encryptString(value: string) {
			const iv = randomBytes(16);
			return Buffer.concat([iv, createCipheriv("aes-256-ctr", key, iv).update(value, "utf8")]);
		},
		decryptString(value: Buffer) {
			return createDecipheriv("aes-256-ctr", key, value.subarray(0, 16))
				.update(value.subarray(16))
				.toString();
		},
	};
	return { directory, credentials: new CredentialStore(directory, encryption), encryption };
}
describe("main-only credential storage", () => {
	test("encrypts secrets on disk, limits permissions, never returns secrets from status", async () => {
		const { directory, credentials } = await store();
		await Promise.all([
			credentials.set("meta", "test-secret-meta"),
			credentials.set("elevenlabs", "test-secret-voice"),
		]);
		assert.equal(await credentials.get("meta"), "test-secret-meta");
		assert.equal(await credentials.get("elevenlabs"), "test-secret-voice");
		assert.ok(!JSON.stringify(await credentials.status()).includes("test-secret"));
		const file = join(directory, "credentials.encrypted.json");
		assert.ok(!(await readFile(file, "utf8")).includes("test-secret"));
		assert.equal((await stat(file)).mode & 0o777, 0o600);
		await credentials.delete("meta");
		assert.equal(await credentials.get("meta"), undefined);
	});
	test("fails closed when OS encryption is unavailable or uses plaintext fallback", async () => {
		const { directory, encryption } = await store();
		const unavailable = new CredentialStore(directory, {
			...encryption,
			isEncryptionAvailable: () => false,
		});
		assert.throws(() => unavailable.set("meta", "secret"), /unavailable/);
		const fallback = new CredentialStore(directory, {
			...encryption,
			getSelectedStorageBackend: () => "basic_text",
		});
		assert.throws(() => fallback.set("github", "secret"), /unavailable/);
	});
});
