import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CredentialStore } from "../runtime/credentials";
import { initializeAppConfiguration } from "./initialize";

test("V1 migration preserves explicit env values, migrates privately once, and never resurrects deleted keys", async () => {
	const directory = await mkdtemp(join(tmpdir(), "met-v1-migrate-"));
	try {
		const userDataPath = join(directory, "app");
		const encryption = {
			isEncryptionAvailable: () => true,
			encryptString: (value: string) => Buffer.from(value),
			decryptString: (value: Buffer) => value.toString(),
		};
		const old = new CredentialStore(join(userDataPath, "credentials"), encryption);
		await old.set("meta", "old-test-meta");
		await old.set("elevenlabs", "test-eleven");
		await mkdir(join(userDataPath, "voice"), { recursive: true });
		await writeFile(
			join(userDataPath, "voice/settings.json"),
			JSON.stringify({ voiceId: "test-voice" })
		);
		const envPath = join(directory, ".env");
		await writeFile(envPath, "# keep this comment\nMODEL_API_KEY=explicit-test-meta\n");
		const config = await initializeAppConfiguration({ envPath, userDataPath, encryption });
		assert.equal(await config.get("meta"), "explicit-test-meta");
		assert.equal(await config.get("elevenlabs"), "test-eleven");
		assert.equal(await config.voiceId(), "test-voice");
		assert.equal((await stat(envPath)).mode & 0o777, 0o600);
		assert.match(await readFile(envPath, "utf8"), /# keep this comment/);
		await config.delete("elevenlabs");
		const restarted = await initializeAppConfiguration({ envPath, userDataPath, encryption });
		assert.equal(await restarted.get("elevenlabs"), undefined);
		assert.equal(await old.get("elevenlabs"), "test-eleven");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
