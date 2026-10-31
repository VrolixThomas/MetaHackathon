import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { OAuthProvider } from "../../shared/contracts/oauth";
import type { SecretEncryption } from "../runtime/credentials";
import { OAuthError, type OAuthSession, SessionSchema, assertProvider } from "./types";

const CiphertextSchema = z
	.string()
	.min(4)
	.max(350000)
	.regex(/^[A-Za-z0-9+/]+={0,2}$/);
const EnvelopeSchema = z.strictObject({
	version: z.literal(1),
	github: CiphertextSchema.optional(),
	linear: CiphertextSchema.optional(),
	slack: CiphertextSchema.optional(),
});
type Envelope = z.infer<typeof EnvelopeSchema>;

/** One service owns this store. Serial atomic replacements preserve all other providers.
 * Slack is additive to the v1 envelope, so existing GitHub/Linear files remain readable.
 */
export class OAuthStore {
	private pending: Promise<unknown> = Promise.resolve();
	private readonly path: string;

	constructor(
		private readonly directory: string,
		private readonly encryption: SecretEncryption
	) {
		this.path = join(directory, "oauth.sessions.encrypted.json");
	}

	assertSecure(): void {
		try {
			if (
				!this.encryption.isEncryptionAvailable() ||
				this.encryption.getSelectedStorageBackend?.() === "basic_text"
			) {
				throw new OAuthError("storage");
			}
		} catch {
			throw new OAuthError("storage");
		}
	}

	private async read(): Promise<Envelope> {
		let file: Awaited<ReturnType<typeof open>> | undefined;
		try {
			file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
			const metadata = await file.stat();
			if (!metadata.isFile() || metadata.size > 1100000) throw new OAuthError("storage");
			return EnvelopeSchema.parse(JSON.parse(await file.readFile("utf8")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1 };
			throw new OAuthError("storage");
		} finally {
			await file?.close();
		}
	}

	async has(provider: OAuthProvider): Promise<boolean> {
		assertProvider(provider);
		await this.pending;
		return Boolean((await this.read())[provider]);
	}

	async get(provider: OAuthProvider): Promise<OAuthSession | undefined> {
		assertProvider(provider);
		await this.pending;
		const ciphertext = (await this.read())[provider];
		if (!ciphertext) return undefined;
		this.assertSecure();
		try {
			const session = SessionSchema.parse(
				JSON.parse(this.encryption.decryptString(Buffer.from(ciphertext, "base64")))
			);
			if (session.provider !== provider) throw new OAuthError("storage");
			return session;
		} catch {
			throw new OAuthError("storage");
		}
	}

	set(session: OAuthSession): Promise<void> {
		return this.update(session.provider, session);
	}

	delete(provider: OAuthProvider): Promise<void> {
		return this.update(provider);
	}

	private update(provider: OAuthProvider, session?: OAuthSession): Promise<void> {
		const operation = this.pending.then(async () => {
			let temporary: string | undefined;
			try {
				assertProvider(provider);
				const envelope = await this.read();
				if (session) {
					this.assertSecure();
					const value = SessionSchema.parse(session);
					envelope[provider] = CiphertextSchema.parse(
						this.encryption.encryptString(JSON.stringify(value)).toString("base64")
					);
				} else delete envelope[provider];
				await mkdir(this.directory, { recursive: true, mode: 0o700 });
				await chmod(this.directory, 0o700);
				temporary = `${this.path}.${randomUUID()}.tmp`;
				const file = await open(temporary, "wx", 0o600);
				try {
					await file.writeFile(JSON.stringify(envelope));
					await file.sync();
				} finally {
					await file.close();
				}
				await rename(temporary, this.path);
			} catch {
				throw new OAuthError("storage");
			} finally {
				if (temporary) await rm(temporary, { force: true }).catch(() => {});
			}
		});
		this.pending = operation.catch(() => {});
		return operation;
	}

	async drain(): Promise<void> {
		await this.pending;
	}
}
