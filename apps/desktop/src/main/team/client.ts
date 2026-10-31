import { z } from "zod";
import {
	ProposalDecisionSchema,
	ShareProposalSchema,
	validateBundle,
} from "../../../../../services/team/proposals";
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

const ExchangeSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("share"), input: ShareProposalSchema }),
	z.object({ kind: z.literal("decide"), input: ProposalDecisionSchema }),
]);
const LocalSchema = z.strictObject({
	userId: z.uuid(),
	artifacts: z.record(z.string(), z.unknown()),
	pending: z.array(ProgressWriteSchema).max(200),
	exchanges: z.array(ExchangeSchema).max(10).default([]),
});
const PrivateCacheSchema = z.object({
	version: z.literal(1),
	accounts: z.record(z.string(), LocalSchema),
});
/** HTTP team adapter. Supabase and GitHub tokens remain in main. Offline results never establish current authorization/display. */
export class TeamClient {
	readonly base: string;
	private pending: Promise<unknown> = Promise.resolve();
	constructor(
		private readonly options: {
			url: string;
			auth: Pick<TeamAuth, "session"> & Partial<Pick<TeamAuth, "revision">>;
			getAccountRevision?: () => number;
			getGitHubToken: () => Promise<string | undefined>;
			cache: TeamStore;
			fetch?: typeof fetch;
			allowLocal?: boolean;
		}
	) {
		this.base = secureUrl(options.url, options.allowLocal).origin;
	}

	private async cacheData() {
		const raw = await this.options.cache.read();
		if (raw === null)
			return { version: 1 as const, accounts: {} as Record<string, z.infer<typeof LocalSchema>> };
		const all = PrivateCacheSchema.safeParse(raw);
		if (all.success) return all.data;
		const legacy = LocalSchema.safeParse(raw);
		if (legacy.success)
			return { version: 1 as const, accounts: { [legacy.data.userId]: legacy.data } };
		throw new TeamError("invalid");
	}
	private async local(userId: string) {
		return (
			(await this.cacheData()).accounts[userId] ?? {
				userId,
				artifacts: {},
				pending: [],
				exchanges: [],
			}
		);
	}
	private async persist(local: z.infer<typeof LocalSchema>) {
		const all = await this.cacheData();
		all.accounts[local.userId] = local;
		const oldest = Object.keys(local.artifacts);
		while (Buffer.byteLength(JSON.stringify(all)) > 32000000 && oldest.length) {
			const id = oldest.shift();
			if (id) delete local.artifacts[id];
		}
		if (Buffer.byteLength(JSON.stringify(all)) > 32000000 || Object.keys(all.accounts).length > 10)
			throw new TeamError("unavailable");
		await this.options.cache.write(all);
	}

	private async request(
		path: string,
		body: unknown,
		expectedUserId?: string
	): Promise<{ userId: string; value: unknown }> {
		const revision = this.options.getAccountRevision?.() ?? this.options.auth.revision ?? 0;
		const session = await this.options.auth.session();
		if (expectedUserId && session.user.id !== expectedUserId) throw new TeamError("unauthorized");
		const token = await this.options.getGitHubToken();
		if (!token) throw new TeamError("unauthorized");
		const before = await this.options.auth.session();
		if (
			(this.options.getAccountRevision?.() ?? this.options.auth.revision ?? 0) !== revision ||
			before.user.id !== session.user.id ||
			before.access_token !== session.access_token
		)
			throw new TeamError("unauthorized");
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
		const value = response.ok ? await boundedJson(response) : null;
		const current = await this.options.auth.session();
		if (
			(this.options.getAccountRevision?.() ?? this.options.auth.revision ?? 0) !== revision ||
			current.user.id !== session.user.id ||
			current.access_token !== session.access_token ||
			(await this.options.getGitHubToken()) !== token
		)
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
		return { userId: session.user.id, value };
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
			const response = await this.request("reviews/read", { key }, userId);
			if (response.value === null) return { status: "pending", artifact: null };
			const value = artifact(response.value);
			if (digest(value.key) !== digest(key)) throw new TeamError("invalid");
			await this.serialize(async () => {
				const local = await this.local(response.userId);
				local.artifacts[digest(key)] = value;
				const ids = Object.keys(local.artifacts);
				for (const id of ids.slice(0, Math.max(0, ids.length - 100))) delete local.artifacts[id];
				await this.persist(local);
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
		input: z.infer<typeof ProgressWriteSchema>,
		expectedUserId?: string
	): Promise<{ status: "saved" | "pending"; progress: TeamProgress }> {
		const write = ProgressWriteSchema.parse(input);
		const userId = (await this.options.auth.session()).user.id;
		if (expectedUserId && expectedUserId !== userId) throw new TeamError("unauthorized");
		return this.serialize(async () => {
			const local = await this.local(userId);
			const existing = local.pending.find((item) => item.requestId === write.requestId);
			if (existing && digest(existing) !== digest(write)) throw new TeamError("conflict");
			if (!existing) {
				if (local.pending.length >= 200) throw new TeamError("unavailable");
				local.pending.push(write);
				await this.persist(local);
			}
			try {
				const response = await this.request("progress/write", write, userId);
				if (response.userId !== userId) throw new TeamError("unauthorized");
				const progress = ProgressSchema.parse(response.value);
				local.pending = local.pending.filter((item) => item.requestId !== write.requestId);
				await this.persist(local);
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
			const result = await this.saveProgress(input, userId);
			if (result.status === "pending") break;
			saved++;
		}
		return saved;
	}

	async organizations() {
		return z
			.object({
				analysisVersion: z.string().min(1).max(160),
				items: z.array(z.object({ id: z.uuid(), name: z.string().min(1).max(160) })).max(100),
			})
			.parse((await this.request("organizations", {})).value);
	}
	async repositories(orgId: string, offset = 0) {
		z.uuid().parse(orgId);
		return z
			.object({
				items: z
					.array(z.object({ orgId: z.uuid(), repositoryId: z.string(), fullName: z.string() }))
					.max(10),
				nextOffset: z.int().nonnegative().nullable(),
			})
			.parse((await this.request("repositories", { orgId, offset })).value);
	}
	async preparationStatus(key: ReviewKey) {
		const response = await this.request("reviews/status", { key: ReviewKeySchema.parse(key) });
		return z
			.object({
				status: z.enum(["missing", "queued", "leased", "ready", "failed"]),
				errorCode: z.string().nullable(),
				attempts: z.int().nonnegative(),
			})
			.parse(response.value);
	}
	async retryPreparation(key: ReviewKey, requestId: string): Promise<void> {
		z.uuid().parse(requestId);
		await this.request("reviews/retry", { key: ReviewKeySchema.parse(key), requestId });
	}
	async requestPreparation(key: ReviewKey): Promise<void> {
		await this.request("reviews/request", { key: ReviewKeySchema.parse(key) });
	}
	async listProposals(key: ReviewKey): Promise<unknown[]> {
		return z
			.array(z.unknown())
			.max(100)
			.parse((await this.request("proposals/list", { key: ReviewKeySchema.parse(key) })).value);
	}
	async readProposal(key: ReviewKey, proposalId: string): Promise<unknown | null> {
		z.uuid().parse(proposalId);
		const response = await this.request("proposals/read", {
			key: ReviewKeySchema.parse(key),
			proposalId,
		});
		if (response.value === null) return null;
		const record = z
			.object({ key: ReviewKeySchema, bundle: z.unknown(), bundle_digest: z.string() })
			.passthrough()
			.parse(response.value);
		const bundle = validateBundle(record.bundle);
		if (digest(record.key) !== digest(key) || digest(bundle) !== record.bundle_digest)
			throw new TeamError("invalid");
		return { ...record, bundle };
	}
	shareProposal(raw: z.infer<typeof ShareProposalSchema>) {
		const input = ShareProposalSchema.parse(raw);
		validateBundle(input.bundle);
		if (digest(input.bundle) !== input.bundleDigest) throw new TeamError("invalid");
		return this.exchange({ kind: "share", input });
	}
	decideProposal(raw: z.infer<typeof ProposalDecisionSchema>) {
		return this.exchange({ kind: "decide", input: ProposalDecisionSchema.parse(raw) });
	}
	private async exchange(
		raw: z.infer<typeof ExchangeSchema>,
		expectedUserId?: string
	): Promise<{ status: "recorded" | "pending"; value: unknown }> {
		const exchange = ExchangeSchema.parse(raw);
		const userId = (await this.options.auth.session()).user.id;
		if (expectedUserId && userId !== expectedUserId) throw new TeamError("unauthorized");
		return this.serialize(async () => {
			const local = await this.local(userId);
			const previous = local.exchanges.find(
				(item) => item.input.requestId === exchange.input.requestId
			);
			if (previous && digest(previous) !== digest(exchange)) throw new TeamError("conflict");
			if (!previous) {
				if (local.exchanges.length >= 10) throw new TeamError("unavailable");
				local.exchanges.push(exchange);
				await this.persist(local);
			}
			try {
				const response = await this.request(`proposals/${exchange.kind}`, exchange.input, userId);
				if (response.userId !== userId) throw new TeamError("unauthorized");
				const record = z
					.object({ id: z.uuid(), bundle_digest: z.string() })
					.passthrough()
					.parse(response.value);
				if (record.bundle_digest !== exchange.input.bundleDigest) throw new TeamError("invalid");
				if (
					exchange.kind === "decide" &&
					(record["proposal_id"] !== exchange.input.proposalId ||
						record["decision"] !== exchange.input.decision)
				)
					throw new TeamError("invalid");
				if (
					exchange.kind === "share" &&
					digest(validateBundle(record["bundle"])) !== exchange.input.bundleDigest
				)
					throw new TeamError("invalid");
				local.exchanges = local.exchanges.filter(
					(item) => item.input.requestId !== exchange.input.requestId
				);
				await this.persist(local);
				return { status: "recorded", value: record };
			} catch (error) {
				if (error instanceof TeamError && error.code === "offline")
					return { status: "pending", value: null };
				throw error;
			}
		});
	}
	/** Explicit retry only; an uncertain proposal/decision never auto-applies or publishes anything. */
	async retryExchange(requestId: string) {
		const userId = (await this.options.auth.session()).user.id;
		const item = (await this.local(userId)).exchanges.find(
			(item) => item.input.requestId === requestId
		);
		if (!item) throw new TeamError("invalid");
		return this.exchange(item, userId);
	}
}
