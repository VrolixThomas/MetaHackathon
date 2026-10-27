import { chmod, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CredentialStore, type SecretEncryption } from "../runtime/credentials";
import { EnvConfiguration } from "./env";

/** Runs inside the actual app; secret values never cross IPC, logs, or the model. */
export async function initializeAppConfiguration(options: {
	envPath: string;
	userDataPath: string;
	encryption: SecretEncryption;
	seedPath?: string;
}): Promise<EnvConfiguration> {
	const config = new EnvConfiguration(options.envPath);
	if (options.seedPath && !(await exists(options.envPath)) && (await exists(options.seedPath))) {
		await mkdir(dirname(options.envPath), { recursive: true, mode: 0o700 });
		await copyFile(options.seedPath, options.envPath);
		await chmod(options.envPath, 0o600);
	}
	await config.ensureTemplate();
	const marker = join(options.userDataPath, ".env-migrated-v1");
	if (!(await exists(marker))) {
		const legacy = new CredentialStore(
			join(options.userDataPath, "credentials"),
			options.encryption
		);
		const values: { github?: string; meta?: string; elevenlabs?: string; voiceId?: string } = {};
		for (const row of await legacy.status()) {
			if (row.configured) values[row.provider] = await legacy.get(row.provider);
		}
		try {
			const path = join(options.userDataPath, "voice", "settings.json");
			if ((await stat(path)).size < 4096) {
				const previous = JSON.parse(await readFile(path, "utf8"));
				if (typeof previous.voiceId === "string") values.voiceId = previous.voiceId;
			}
		} catch {
			/* No valid previous voice selection. */
		}
		await config.migrate(values);
		await mkdir(options.userDataPath, { recursive: true, mode: 0o700 });
		await writeFile(
			marker,
			"Configuration migrated to .env; previous encrypted backup retained.\n",
			{ mode: 0o600 }
		);
	}
	return config;
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw new Error("Configuration path could not be accessed");
	}
}
