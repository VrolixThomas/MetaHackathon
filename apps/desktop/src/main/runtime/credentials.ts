import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	CredentialProviderSchema,
	CredentialStatusListSchema,
	SetCredentialInputSchema,
} from "../../shared/contracts";
import type { CredentialProvider } from "../../shared/contracts";

export const credentialProviders = CredentialProviderSchema.options;
export type { CredentialProvider } from "../../shared/contracts";

/** Inject Electron safeStorage after app.whenReady(). macOS uses Keychain encryption keys. */
export interface SecretEncryption {
	isEncryptionAvailable(): boolean;
	encryptString(value: string): Buffer;
	decryptString(value: Buffer): string;
	getSelectedStorageBackend?(): string;
}

/** Main-process service. Only status/set/delete may be adapted into renderer RPCs. */
export class CredentialStore {
	private pending: Promise<unknown> = Promise.resolve();
	private readonly path: string;

	constructor(
		private readonly directory: string,
		private readonly encryption: SecretEncryption
	) {
		this.path = join(directory, "credentials.encrypted.json");
	}

	private assertSecure() {
		if (
			!this.encryption.isEncryptionAvailable() ||
			this.encryption.getSelectedStorageBackend?.() === "basic_text"
		) {
			throw new Error("OS credential encryption is unavailable");
		}
	}

	private async read(): Promise<Partial<Record<CredentialProvider, string>>> {
		try {
			return JSON.parse(await readFile(this.path, "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw new Error("Unable to read encrypted credentials");
		}
	}

	async status() {
		await this.pending;
		const values = await this.read();
		return CredentialStatusListSchema.parse(
			credentialProviders.map((provider) => ({
				provider,
				configured: Boolean(values[provider]),
				storage: "os-encrypted" as const,
			}))
		);
	}

	/** Never expose this method through preload, tRPC, logs or renderer state. */
	async get(provider: CredentialProvider): Promise<string | undefined> {
		this.assertSecure();
		await this.pending;
		const encrypted = (await this.read())[provider];
		return encrypted ? this.encryption.decryptString(Buffer.from(encrypted, "base64")) : undefined;
	}

	set(provider: CredentialProvider, secret: string): Promise<void> {
		const input = SetCredentialInputSchema.parse({ provider, secret });
		this.assertSecure();
		return this.update(
			input.provider,
			this.encryption.encryptString(input.secret).toString("base64")
		);
	}

	delete(provider: CredentialProvider): Promise<void> {
		if (!credentialProviders.includes(provider)) throw new Error("Unknown credential provider");
		return this.update(provider, undefined);
	}

	private update(provider: CredentialProvider, value: string | undefined): Promise<void> {
		const operation = this.pending.then(async () => {
			const values = await this.read();
			if (value === undefined) delete values[provider];
			else values[provider] = value;
			await mkdir(this.directory, { recursive: true, mode: 0o700 });
			const temporary = `${this.path}.${randomUUID()}.tmp`;
			try {
				await writeFile(temporary, JSON.stringify(values), { mode: 0o600, flag: "wx" });
				await rename(temporary, this.path);
			} finally {
				await rm(temporary, { force: true });
			}
		});
		this.pending = operation.catch(() => {});
		return operation;
	}
}
