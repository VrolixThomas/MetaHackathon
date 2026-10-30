import { randomUUID } from "node:crypto";
import { type FileHandle, link, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseEnv } from "node:util";
import {
	type CredentialProvider,
	CredentialProviderSchema,
	type CredentialStatusList,
	CredentialStatusListSchema,
	type OAuthProvider,
	OAuthProviderSchema,
	SetCredentialInputSchema,
	VoiceSetupInputSchema,
} from "../../shared/contracts";

const keys = { github: "GITHUB_TOKEN", meta: "MODEL_API_KEY", elevenlabs: "ELEVENLABS_API_KEY" };
const aliases: Partial<Record<CredentialProvider, string>> = {
	github: "GH_TOKEN",
	meta: "META_API_KEY",
};
const voiceKey = "ELEVENLABS_VOICE_ID";
const maxBytes = 1_048_576;
const template = `# Local credentials. This repository ignores .env; keep it private.
# GitHub token for pull request access.
GITHUB_TOKEN=
# Meta model and voice API key.
MODEL_API_KEY=
# ElevenLabs speech API key and public voice ID.
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
# Linear personal API key for your own assigned tickets.
LINEAR_API_KEY=
`;
export type EnvMigration = Partial<Record<CredentialProvider | "voiceId", string>>;
interface Document {
	text: string;
	values: NodeJS.Dict<string>;
	entries: { key: string; start: number; end: number }[];
}

function value(input: string, provider?: CredentialProvider): string {
	if (
		typeof input !== "string" ||
		input.length > (provider ? 16_384 : 200) ||
		/[\r\n\0]/.test(input)
	)
		throw new Error("Invalid value");
	return provider
		? SetCredentialInputSchema.parse({ provider, secret: input }).secret
		: VoiceSetupInputSchema.parse({ voiceId: input }).voiceId;
}

function document(text: string): Document {
	if (Buffer.byteLength(text) > maxBytes || text.includes("\0")) throw new Error("Invalid file");
	// Record complete assignments, including quoted multiline values, so unrelated text is untouched.
	// parseEnv is permissive about malformed lines; this scanner rejects them before any rewrite.
	const head =
		/[ \t]*(?:(?:#[^\r\n]*)?(?:\r?\n|$)|(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*)/gy;
	const unquoted = /[^#\r\n]*/gy;
	const tail = /[ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)/gy;
	const entries: Document["entries"] = [];
	let offset = text.startsWith("\uFEFF") ? 1 : 0;
	while (offset < text.length) {
		head.lastIndex = offset;
		const match = head.exec(text);
		if (!match || !match[0].length) throw new Error("Invalid file");
		offset = head.lastIndex;
		if (match[1] === undefined) continue;
		const start = offset;
		const quote = text[start];
		let end: number;
		if (quote && ["'", '"', "`"].includes(quote)) {
			end = text.indexOf(quote, start + 1) + 1;
			if (!end) throw new Error("Invalid file");
			offset = end;
		} else {
			unquoted.lastIndex = start;
			const raw = unquoted.exec(text)?.[0] ?? "";
			end = start + raw.trimEnd().length;
			offset = start + raw.length;
		}
		tail.lastIndex = offset;
		if (!tail.exec(text)) throw new Error("Invalid file");
		entries.push({ key: match[1], start, end });
		offset = tail.lastIndex;
	}
	const values = parseEnv(text.replace(/^\uFEFF/, ""));
	for (const provider of CredentialProviderSchema.options) {
		for (const key of [keys[provider], aliases[provider]]) {
			const raw = key ? values[key] : undefined;
			if (raw !== undefined && raw !== "") value(raw, provider);
		}
	}
	if (values[voiceKey] !== undefined && values[voiceKey] !== "") value(values[voiceKey]);
	return { text, values, entries };
}

function credential(values: Document["values"], provider: CredentialProvider) {
	const alias = aliases[provider];
	const raw = values[keys[provider]] ?? (alias ? values[alias] : undefined);
	return raw?.trim() || undefined;
}

function encode(raw: string): string {
	if (!raw) return "";
	// dotenv has no general quote escaping. Choose a lossless representation or reject it.
	for (const encoded of [`'${raw}'`, `\`${raw}\``, `"${raw}"`, raw]) {
		try {
			const parsed = document(`VALUE=${encoded}\n`).values;
			if (parsed["VALUE"] === raw && Object.keys(parsed).length === 1) return encoded;
		} catch {
			// Try another quote delimiter without revealing the value.
		}
	}
	throw new Error("Unsupported value");
}

function update(source: Document, changes: Map<string, string>, append = true): string {
	let text = source.text;
	const seen = new Set<string>();
	for (const entry of [...source.entries].reverse()) {
		const replacement = changes.get(entry.key);
		if (replacement === undefined) continue;
		text = text.slice(0, entry.start) + encode(replacement) + text.slice(entry.end);
		seen.add(entry.key);
	}
	const newline = text.includes("\r\n") ? "\r\n" : "\n";
	if (append) {
		for (const [key, replacement] of changes) {
			if (seen.has(key)) continue;
			if (text && !text.endsWith("\n")) text += newline;
			text += `${key}=${encode(replacement)}${newline}`;
		}
	}
	document(text);
	return text;
}

/** Main-only file adapter. Only status/set/delete belong in renderer credential RPCs. */
export class EnvConfiguration {
	private pending: Promise<unknown> = Promise.resolve();
	constructor(readonly path: string) {}

	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const job = this.pending.then(operation).catch(() => {
			// Filesystem paths, parser diagnostics and validation errors can contain credentials.
			throw new Error("Invalid or inaccessible local environment configuration");
		});
		this.pending = job.catch(() => {});
		return job;
	}
	private async read(): Promise<Document | undefined> {
		let file: FileHandle;
		try {
			file = await open(this.path, "r");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		try {
			const info = await file.stat();
			if (!info.isFile() || info.size > maxBytes) throw new Error("Invalid file");
			const buffer = Buffer.alloc(maxBytes + 1);
			let length = 0;
			while (length < buffer.length) {
				const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
				if (!bytesRead) break;
				length += bytesRead;
			}
			if (length > maxBytes) throw new Error("Invalid file");
			return document(
				new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
					buffer.subarray(0, length)
				)
			);
		} finally {
			await file.close();
		}
	}
	private async write(text: string, onlyIfMissing = false) {
		document(text);
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		const temporary = `${this.path}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, text, { flag: "wx", mode: 0o600 });
			if (onlyIfMissing) {
				try {
					await link(temporary, this.path);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
					await this.read();
				}
			} else await rename(temporary, this.path);
		} finally {
			await rm(temporary, { force: true });
		}
	}
	get(provider: CredentialProvider): Promise<string | undefined> {
		return this.serialize(async () =>
			credential((await this.read())?.values ?? {}, CredentialProviderSchema.parse(provider))
		);
	}
	set(provider: CredentialProvider, secret: string): Promise<void> {
		return this.serialize(async () => {
			const selected = CredentialProviderSchema.parse(provider);
			const normalized = value(secret, selected);
			const source = (await this.read()) ?? document("");
			await this.write(update(source, new Map([[keys[selected], normalized]])));
		});
	}
	delete(provider: CredentialProvider): Promise<void> {
		return this.serialize(async () => {
			const selected = CredentialProviderSchema.parse(provider);
			const source = await this.read();
			if (!source) return;
			const changes = new Map([[keys[selected], ""]]);
			const alias = aliases[selected];
			if (alias) changes.set(alias, "");
			await this.write(update(source, changes, false));
		});
	}
	status(): Promise<CredentialStatusList> {
		return this.serialize(async () => {
			const values = (await this.read())?.values ?? {};
			return CredentialStatusListSchema.parse(
				CredentialProviderSchema.options.map((provider) => ({
					provider,
					configured: Boolean(credential(values, provider)),
					storage: "env-file",
				}))
			);
		});
	}
	voiceId(): Promise<string | undefined> {
		return this.serialize(async () => (await this.read())?.values[voiceKey]?.trim() || undefined);
	}
	linearToken(): Promise<string | undefined> {
		return this.serialize(async () => {
			const raw = (await this.read())?.values["LINEAR_API_KEY"]?.trim();
			if (!raw) return undefined;
			if (raw.length > 16384 || /[\r\n\0]/.test(raw))
				throw new Error("Invalid Linear configuration");
			return raw;
		});
	}
	setLinearToken(token: string): Promise<void> {
		return this.serialize(async () => {
			if (token.length > 16384 || /[\r\n\0]/.test(token))
				throw new Error("Invalid Linear configuration");
			await this.write(
				update((await this.read()) ?? document(""), new Map([["LINEAR_API_KEY", token.trim()]]))
			);
		});
	}
	/** Main-only registration credentials; never return this through a renderer procedure. */
	oauthClient(
		provider: OAuthProvider
	): Promise<{ clientId: string; clientSecret?: string } | undefined> {
		return this.serialize(async () => {
			const selected = OAuthProviderSchema.parse(provider);
			const values = (await this.read())?.values ?? {};
			const prefix = selected === "github" ? "GITHUB_OAUTH" : "LINEAR_OAUTH";
			const clientId = values[`${prefix}_CLIENT_ID`]?.trim();
			const clientSecret = values[`${prefix}_CLIENT_SECRET`]?.trim();
			for (const text of [clientId, clientSecret])
				if (text && (text.length > 16384 || /[\r\n\0]/.test(text)))
					throw new Error("Invalid OAuth configuration");
			if (!clientId) return undefined;
			return { clientId, ...(clientSecret ? { clientSecret } : {}) };
		});
	}
	ensureOAuthTemplate(): Promise<void> {
		return this.serialize(async () => {
			const source = (await this.read()) ?? document(template);
			const missing = [
				"GITHUB_OAUTH_CLIENT_ID",
				"GITHUB_OAUTH_CLIENT_SECRET",
				"LINEAR_OAUTH_CLIENT_ID",
				"LINEAR_OAUTH_CLIENT_SECRET",
			].filter((key) => source.values[key] === undefined);
			if (missing.length)
				await this.write(update(source, new Map(missing.map((key) => [key, ""]))));
		});
	}
	setVoiceId(voiceId: string): Promise<void> {
		return this.serialize(async () => {
			const normalized = value(voiceId);
			await this.write(
				update((await this.read()) ?? document(""), new Map([[voiceKey, normalized]]))
			);
		});
	}
	reload(): Promise<void> {
		return this.serialize(async () => {
			await this.read();
		});
	}
	migrate(values: EnvMigration): Promise<void> {
		return this.serialize(async () => {
			const source = (await this.read()) ?? document("");
			const changes = new Map<string, string>();
			for (const provider of CredentialProviderSchema.options) {
				const supplied = values[provider];
				if (supplied === undefined) continue;
				const normalized = value(supplied, provider);
				if (!credential(source.values, provider)) changes.set(keys[provider], normalized);
			}
			if (values.voiceId !== undefined) {
				const normalized = value(values.voiceId);
				if (!source.values[voiceKey]) changes.set(voiceKey, normalized);
			}
			if (changes.size) await this.write(update(source, changes));
		});
	}
	ensureTemplate(): Promise<void> {
		return this.serialize(async () => {
			const source = await this.read();
			if (!source) await this.write(template, true);
			else if (source.values["LINEAR_API_KEY"] === undefined)
				await this.write(
					`${source.text}${source.text.endsWith("\n") ? "" : "\n"}# Linear personal API key\nLINEAR_API_KEY=\n`
				);
		});
	}
}
