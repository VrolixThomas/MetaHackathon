import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SecretEncryption } from "../runtime/credentials";

export interface TeamStore {
	read(): Promise<unknown | null>;
	write(value: unknown | null): Promise<void>;
}
/** Main-only, account-scoped encrypted storage; inject Electron safeStorage after ready. */
export class EncryptedTeamStore implements TeamStore {
	private pending: Promise<unknown> = Promise.resolve();
	constructor(
		private readonly path: string,
		private readonly encryption: SecretEncryption
	) {}
	private secure() {
		if (
			!this.encryption.isEncryptionAvailable() ||
			this.encryption.getSelectedStorageBackend?.() === "basic_text"
		)
			throw new Error("OS encryption unavailable");
	}
	async read() {
		await this.pending;
		this.secure();
		try {
			return JSON.parse(this.encryption.decryptString(await readFile(this.path)));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw new Error("Unable to read team storage");
		}
	}
	write(value: unknown | null): Promise<void> {
		const operation = this.pending.then(async () => {
			this.secure();
			if (value === null) {
				await rm(this.path, { force: true });
				return;
			}
			await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
			const temporary = `${this.path}.${randomUUID()}.tmp`;
			try {
				await writeFile(temporary, this.encryption.encryptString(JSON.stringify(value)), {
					mode: 0o600,
					flag: "wx",
				});
				await rename(temporary, this.path);
			} finally {
				await rm(temporary, { force: true });
			}
		});
		this.pending = operation.catch(() => {});
		return operation;
	}
}
