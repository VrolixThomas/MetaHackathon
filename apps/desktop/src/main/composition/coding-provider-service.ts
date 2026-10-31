import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import {
	type CodingProviderSettings,
	CodingProviderSettingsSchema,
	CodingProviderStatusSchema,
	type MuseCodeStatus,
	MuseCodeStatusSchema,
} from "../../shared/contracts";
import type { EnvConfiguration } from "../config/env";

interface Ports {
	configuration(): EnvConfiguration;
	directory: string;
	probe(input: { musePath: string | null }, signal?: AbortSignal): Promise<MuseCodeStatus>;
	resolveBinary(path: string | null): Promise<string | null>;
	openCommand(path: string): Promise<void>;
	now?: () => number;
}
const inactive = (installed: boolean): MuseCodeStatus => ({
	installed,
	version: null,
	auth: "unknown",
	billing: "unknown",
	tier: null,
	ready: false,
	error: installed ? null : "not-installed",
});
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Main-only configuration/account presence. The vendor owns its credentials and sign-in. */
export class CodingProviderService {
	private cache?: {
		path: string | null;
		at: number;
		promise: Promise<MuseCodeStatus>;
		value?: MuseCodeStatus;
	};
	private readonly lifetime = new AbortController();
	private readonly scripts = new Set<string>();
	private opening?: Promise<void>;
	constructor(private readonly ports: Ports) {}
	private live() {
		this.lifetime.signal.throwIfAborted();
	}
	private async detected(path: string | null) {
		const candidates = path
			? [path]
			: [
					...new Set(
						(process.env["PATH"] ?? "")
							.split(delimiter)
							.filter(Boolean)
							.map((directory) => join(directory, "muse"))
					),
					join(homedir(), ".local", "bin", "muse"),
					"/opt/homebrew/bin/muse",
					"/usr/local/bin/muse",
				];
		for (const candidate of candidates) {
			try {
				await access(candidate, constants.X_OK);
				if ((await stat(candidate)).isFile()) return true;
			} catch {}
		}
		return false;
	}
	private async probe(path: string | null, force: boolean) {
		this.live();
		const now = (this.ports.now ?? Date.now)();
		if (!force && this.cache?.path === path && now - this.cache.at < 10000)
			return this.cache.promise;
		const promise = (async () => {
			try {
				const status = MuseCodeStatusSchema.parse(
					await this.ports.probe({ musePath: path }, this.lifetime.signal)
				);
				this.live();
				if (
					status.ready &&
					(!status.installed ||
						status.auth !== "account" ||
						status.billing !== "subscription" ||
						status.error)
				)
					throw new Error("Unverified account status");
				return status;
			} catch {
				this.live();
				return { ...inactive(await this.detected(path)), error: "unavailable" as const };
			}
		})();
		const entry = { path, at: now, promise, value: undefined as MuseCodeStatus | undefined };
		this.cache = entry;
		void promise.then(
			(value) => {
				if (this.cache === entry) entry.value = value;
			},
			() => {}
		);
		return promise;
	}
	async status(force = false) {
		this.live();
		const configuration = this.ports.configuration();
		const settings = await configuration.codingProviderSettings();
		const metaApiConfigured = Boolean(await configuration.get("meta"));
		// API-only startup/settings must not spawn a second agent or probe a different account.
		const museCode =
			settings.provider === "muse-code" || force
				? await this.probe(settings.musePath, force)
				: this.cache?.path === settings.musePath
					? await this.cache.promise
					: inactive(await this.detected(settings.musePath));
		this.live();
		return CodingProviderStatusSchema.parse({
			settings,
			metaApiConfigured,
			museCode,
			ready: settings.provider === "meta-api" ? metaApiConfigured : museCode.ready,
		});
	}
	async readyForCoding() {
		this.live();
		const configuration = this.ports.configuration();
		const settings = await configuration.codingProviderSettings();
		if (settings.provider === "meta-api") return Boolean(await configuration.get("meta"));
		const previous = this.cache?.path === settings.musePath ? this.cache.value : undefined;
		// Home/foreground context must not wait for CLI startup/account I/O. Each actual job rechecks.
		void this.probe(settings.musePath, false).catch(() => {});
		return previous?.ready ?? false;
	}
	async configure(raw: CodingProviderSettings) {
		this.live();
		const settings = CodingProviderSettingsSchema.parse(raw);
		await this.ports.configuration().setCodingProviderSettings(settings);
		this.cache = undefined;
		return this.status(settings.provider === "muse-code");
	}
	openLogin(): Promise<void> {
		if (this.opening) return this.opening;
		const operation = (async () => {
			this.live();
			const status = await this.status(true);
			if (!status.museCode.installed || !status.museCode.version)
				throw new Error("Install Muse Code before signing in");
			const binary = await this.ports.resolveBinary(status.settings.musePath);
			if (!binary) throw new Error("Muse Code launcher is unavailable");
			await mkdir(this.ports.directory, { recursive: true, mode: 0o700 });
			const directory = await realpath(this.ports.directory);
			const path = join(directory, `muse-login-${randomUUID()}.command`);
			await writeFile(path, `#!/bin/sh\nexec ${quote(binary)} login\n`, {
				flag: "wx",
				mode: 0o700,
			});
			this.scripts.add(path);
			this.live();
			await this.ports.openCommand(path);
			this.cache = undefined;
		})().catch(() => {
			throw new Error("Could not open Muse Code sign-in. Run muse login in Terminal.");
		});
		this.opening = operation;
		void operation
			.finally(() => {
				if (this.opening === operation) this.opening = undefined;
			})
			.catch(() => {});
		return operation;
	}
	async dispose() {
		this.lifetime.abort();
		await this.opening?.catch(() => {});
		await Promise.allSettled([...this.scripts].map((path) => rm(path, { force: true })));
		this.scripts.clear();
		this.cache = undefined;
	}
}
