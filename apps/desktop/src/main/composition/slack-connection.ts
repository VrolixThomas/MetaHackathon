import { createHash } from "node:crypto";
import { z } from "zod";
import {
	type SlackConnectionStatus,
	SlackConnectionStatusSchema,
} from "../../shared/contracts/chat";
import type { EnvConfiguration } from "../config/env";
import { slackProfile } from "../slack/oauth";
import { SlackTransport } from "../slack/transport";
import {
	type SlackCredential,
	SlackCredentialSchema,
	SlackIdSchema,
	SlackScopesSchema,
} from "../slack/types";

type Settings = Awaited<ReturnType<EnvConfiguration["slackSettings"]>>;
const fingerprint = (settings: Settings) =>
	createHash("sha256")
		.update(JSON.stringify([settings.userToken ?? null, settings.appId ?? null]))
		.digest("hex");
interface Verified {
	credential: SlackCredential;
	account: NonNullable<SlackConnectionStatus["account"]>;
}

/** Main-only development-token import. Browser OAuth awaits an app-owned HTTPS callback service. */
export class SlackConnection {
	private key: string | undefined;
	private value: Verified | undefined;
	private loading: Promise<Verified> | undefined;
	private abort: AbortController | undefined;
	private generation = 0;
	private phase: SlackConnectionStatus["phase"] = "disconnected";
	private error: SlackConnectionStatus["error"] = null;
	private disposed = false;
	private retryAfter = 0;
	constructor(
		private readonly options: { readSettings(): Promise<Settings>; fetch?: typeof fetch }
	) {}
	get epoch() {
		return this.generation;
	}
	async credential(): Promise<SlackCredential | undefined> {
		if (this.disposed) return undefined;
		let settings: Settings;
		try {
			settings = await this.options.readSettings();
		} catch {
			this.reset();
			this.phase = "error";
			this.error = "configuration";
			throw new Error("Slack configuration is unavailable");
		}
		const key = fingerprint(settings);
		if (this.key !== key) {
			this.reset();
			this.key = key;
		}
		if (!settings.userToken || !settings.appId) {
			this.phase = "disconnected";
			return undefined;
		}
		if (this.value) return this.value.credential;
		if (!this.loading && Date.now() < this.retryAfter)
			throw new Error("Slack user connection could not be verified");
		if (!this.loading) {
			const generation = this.generation;
			const controller = new AbortController();
			this.abort = controller;
			this.phase = "checking";
			this.error = null;
			const work = this.verify(settings, key, controller.signal)
				.then((value) => {
					if (this.disposed || generation !== this.generation || this.key !== key)
						throw new Error("Slack account changed");
					this.value = value;
					this.phase = "connected";
					return value;
				})
				.catch(() => {
					if (generation === this.generation && !this.disposed) {
						this.phase = "error";
						this.error = "authentication";
						this.retryAfter = Date.now() + 30_000;
					}
					throw new Error("Slack user connection could not be verified");
				})
				.finally(() => {
					if (this.loading === work) this.loading = undefined;
				});
			this.loading = work;
		}
		return (await this.loading).credential;
	}
	private async verify(settings: Settings, key: string, signal: AbortSignal): Promise<Verified> {
		const appId = SlackIdSchema.parse(settings.appId);
		const token = settings.userToken as string;
		let scopes: string[] = [];
		const fetcher: typeof fetch = async (input, init) => {
			const response = await (this.options.fetch ?? fetch)(input, init);
			if (String(input).endsWith("/auth.test"))
				scopes = SlackScopesSchema.parse(
					(response.headers.get("x-oauth-scopes") ?? "").split(/[ ,]+/).filter(Boolean)
				);
			return response;
		};
		const transport = new SlackTransport({ fetch: fetcher });
		const identity = z
			.object({
				team_id: SlackIdSchema,
				user_id: SlackIdSchema,
				team: z.string().max(300).optional(),
				bot_id: z.string().optional(),
			})
			.parse(await transport.call("auth.test", { token, signal }));
		if (identity.bot_id) throw new Error("A Slack user connection is required");
		const profile = await slackProfile({
			grant: {
				accessToken: token,
				workspaceId: identity.team_id,
				userId: identity.user_id,
				appId,
				scopes,
				refreshToken: null,
				expiresAt: null,
			},
			fetch: fetcher,
			signal,
		});
		if (fingerprint(await this.options.readSettings()) !== key)
			throw new Error("Slack configuration changed");
		return {
			credential: SlackCredentialSchema.parse({
				connectionId: `slack-${key.slice(0, 32)}`,
				accessToken: token,
				tokenKind: "user",
				workspaceId: identity.team_id,
				userId: identity.user_id,
				appId,
				scopes,
			}),
			account: {
				workspaceId: identity.team_id,
				workspaceName: identity.team ?? identity.team_id,
				userId: identity.user_id,
				userName: profile.displayName,
			},
		};
	}
	async status(): Promise<SlackConnectionStatus> {
		await this.credential().catch(() => undefined);
		const settings = await this.options.readSettings().catch(() => ({}) as Settings);
		return SlackConnectionStatusSchema.parse({
			phase: this.phase,
			account: this.value?.account ?? null,
			missing: [
				...(!settings.userToken ? ["SLACK_USER_TOKEN"] : []),
				...(!settings.appId ? ["SLACK_APP_ID"] : []),
			],
			coverage: this.value ? "paused" : "disconnected",
			watching: [],
			error: this.error,
		});
	}
	refresh() {
		this.reset();
		return this.credential();
	}
	private reset() {
		this.generation++;
		this.abort?.abort();
		this.abort = undefined;
		this.value = undefined;
		this.loading = undefined;
		this.phase = "disconnected";
		this.error = null;
		this.retryAfter = 0;
	}
	dispose() {
		this.disposed = true;
		this.reset();
	}
}
