import { z } from "zod";
import {
	ProgressSchema,
	ProgressWriteSchema,
	type ReviewKey,
	ReviewKeySchema,
	type TeamArtifact,
	TeamError,
	type TeamProgress,
	artifact,
	boundedJson,
	digest,
	secureUrl,
} from "../../../../../services/team/protocol";
import type { TeamAuth } from "./auth";
import type { TeamStore } from "./storage";

const LocalSchema = z.strictObject({
	userId: z.uuid(),
	artifacts: z.record(z.string(), z.unknown()),
	pending: z.array(ProgressWriteSchema).max(200),
});
/** HTTP team adapter. Supabase and GitHub tokens remain in main. Offline results never establish current authorization/display. */
export class TeamClient {
	readonly base: string;
	private pending: Promise<unknown> = Promise.resolve();
	constructor(
		private readonly options: {
			url: string;
			auth: Pick<TeamAuth, "session">;
			getGitHubToken: () => Promise<string | undefined>;
			cache: TeamStore;
			fetch?: typeof fetch;
			allowLocal?: boolean;
		}
	) {
		this.base = secureUrl(options.url, options.allowLocal).origin;
	}
	private async local(userId: string) {
		const raw = await this.options.cache.read();
		const parsed = LocalSchema.safeParse(raw);
		return parsed.success && parsed.data.userId === userId
			? parsed.data
			: { userId, artifacts: {}, pending: [] };
	}
	private async request(path: string, body: unknown): Promise<{ userId: string; value: unknown }> {
		const session = await this.options.auth.session();
		const token = await this.options.getGitHubToken();
		if (!token) throw new TeamError("unauthorized");
		let response: Response;
		try {
			response = await (this.options.fetch ?? fetch)(`${this.base}/v1/${path}`, {
				method: "POST",
				redirect: "error",
				signal: AbortSignal.timeout(20000),
				headers: {
					Authorization: `Bearer ${session.access_token}`,
					"X-GitHub-Token": token,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
			});
		} catch {
			throw new TeamError("offline");
		}
		if ((await this.options.auth.session()).user.id !== session.user.id)
			throw new TeamError("unauthorized");
		if (!response.ok)
			throw new TeamError(
				response.status === 401
					? "unauthorized"
					: response.status === 403
						? "forbidden"
						: response.status === 409
							? "conflict"
							: response.status >= 500
								? "unavailable"
								: "invalid",
				response.status
			);
		return { userId: session.user.id, value: await boundedJson(response) };
	}
	private serialize<T>(run: () => Promise<T>): Promise<T> {
		const next = this.pending.then(run);
		this.pending = next.catch(() => {});
		return next;
	}
	async load(
		raw: ReviewKey
	): Promise<{ status: "current" | "offline-cache" | "pending"; artifact: TeamArtifact | null }> {
		const key = ReviewKeySchema.parse(raw);
		const userId = (await this.options.auth.session()).user.id;
		try {
			const response = await this.request("reviews/read", { key });
			if (response.value === null) return { status: "pending", artifact: null };
			const value = artifact(response.value);
			if (digest(value.key) !== digest(key)) throw new TeamError("invalid");
			await this.serialize(async () => {
				const local = await this.local(response.userId);
				local.artifacts[digest(key)] = value;
				const ids = Object.keys(local.artifacts);
				for (const id of ids.slice(0, Math.max(0, ids.length - 100))) delete local.artifacts[id];
				await this.options.cache.write(local);
			});
			return { status: "current", artifact: value };
		} catch (error) {
			if (!(error instanceof TeamError) || error.code !== "offline") throw error;
			if ((await this.options.auth.session()).user.id !== userId)
				throw new TeamError("unauthorized");
			const cached = (await this.local(userId)).artifacts[digest(key)];
			return { status: "offline-cache", artifact: cached ? artifact(cached) : null };
		}
	}
	async readProgress(key: ReviewKey): Promise<TeamProgress | null> {
		const response = await this.request("progress/read", { key: ReviewKeySchema.parse(key) });
		return response.value === null ? null : ProgressSchema.parse(response.value);
	}
	async saveProgress(
		input: z.infer<typeof ProgressWriteSchema>
	): Promise<{ status: "saved" | "pending"; progress: TeamProgress }> {
		const write = ProgressWriteSchema.parse(input);
		const userId = (await this.options.auth.session()).user.id;
		return this.serialize(async () => {
			const local = await this.local(userId);
			const existing = local.pending.find((item) => item.requestId === write.requestId);
			if (existing && digest(existing) !== digest(write)) throw new TeamError("conflict");
			if (!existing) {
				if (local.pending.length >= 200) throw new TeamError("unavailable");
				local.pending.push(write);
				await this.options.cache.write(local);
			}
			try {
				const response = await this.request("progress/write", write);
				if (response.userId !== userId) throw new TeamError("unauthorized");
				const progress = ProgressSchema.parse(response.value);
				local.pending = local.pending.filter((item) => item.requestId !== write.requestId);
				await this.options.cache.write(local);
				return { status: "saved", progress };
			} catch (error) {
				if (error instanceof TeamError && error.code === "offline")
					return { status: "pending", progress: write.progress };
				throw error;
			}
		});
	}
	async flushProgress(): Promise<number> {
		const userId = (await this.options.auth.session()).user.id;
		const items = (await this.local(userId)).pending;
		let saved = 0;
		for (const input of items) {
			const result = await this.saveProgress(input);
			if (result.status === "pending") break;
			saved++;
		}
		return saved;
	}
}
