import { join } from "node:path";
import { z } from "zod";
import {
	ApplyTeamProposalSchema,
	CreateOrganizationSchema,
	DecideTeamProposalSchema,
	PreviewLocalProposalSchema,
	ProposalsInputSchema,
	ReadProposalInputSchema,
	RegisterRepositorySchema,
	SelectScopeSchema,
	ShareLocalProposalSchema,
	type TeamApplyReceipt,
	TeamApplyReceiptSchema,
	type TeamDecision,
	TeamDecisionSchema,
	TeamLocalPreviewSchema,
	TeamMutationResultSchema,
	TeamOrganizationSchema,
	TeamOrganizationsSchema,
	type TeamProposalDetail,
	TeamProposalDetailSchema,
	TeamProposalPageSchema,
	TeamRepositoriesSchema,
	TeamRepositorySchema,
	type TeamScope,
	TeamScopeSchema,
	TeamStatusSchema,
} from "../../../../../services/team/desktop-schemas";
import { type ProposalBundle, validateBundle } from "../../../../../services/team/proposals";
import { TeamError, digest } from "../../../../../services/team/protocol";
import { type ConversationPRContext, ConversationPRContextSchema } from "../../shared/contracts";
import type { SecretEncryption } from "../runtime/credentials";
import { TeamAuth } from "./auth";
import { TeamClient } from "./client";
import { TeamLogin } from "./login";
import { TeamPreparationProvider } from "./provider";
import { EncryptedTeamStore } from "./storage";
export * from "../../../../../services/team/desktop-schemas";

export interface TeamSettings {
	url?: string;
	publishableKey?: string;
	serviceUrl?: string;
}
export interface TeamServiceOptions {
	directory?: string;
	userDataPath?: string;
	encryption: SecretEncryption;
	getSettings: () => TeamSettings | Promise<TeamSettings>;
	getGitHubToken: () => Promise<string | undefined>;
	getAccountRevision: () => number;
	openExternal: (url: string) => Promise<void>;
	readLocalFix?: (
		input: { candidateId: string; scope: TeamScope },
		signal?: AbortSignal
	) => Promise<ProposalBundle>;
	applyProposal?: (input: {
		requestId: string;
		proposalId: string;
		bundleDigest: string;
		userId: string;
		bundle: ProposalBundle;
		decision: TeamDecision;
		signal?: AbortSignal;
	}) => Promise<TeamApplyReceipt>;
	fetch?: typeof fetch;
	allowLocal?: boolean;
}
const PreferencesSchema = z.object({
	users: z.record(z.string(), z.object({ scopes: z.array(TeamScopeSchema).max(100) })),
});
const LedgerSchema = z.record(
	z.string(),
	z.object({ input: ApplyTeamProposalSchema, receipt: TeamApplyReceiptSchema })
);
function decision(raw: unknown): TeamDecision {
	const d = z
		.object({
			id: z.string(),
			proposal_id: z.string(),
			bundle_digest: z.string(),
			decision: z.string(),
			author_id: z.string(),
			github_author_id: z.string(),
			created_at: z.string(),
		})
		.parse(raw);
	return TeamDecisionSchema.parse({
		id: d.id,
		proposalId: d.proposal_id,
		bundleDigest: d.bundle_digest,
		decision: d.decision,
		authorId: d.author_id,
		githubAuthorId: d.github_author_id,
		createdAt: d.created_at,
	});
}
function proposal(raw: unknown): TeamProposalDetail {
	const p = z
		.object({
			id: z.string(),
			key: z.unknown(),
			owner_id: z.string(),
			bundle_digest: z.string(),
			created_at: z.string(),
			bundle: z.unknown(),
			decision: z.unknown().nullable(),
		})
		.parse(raw);
	const bundle = validateBundle(p.bundle);
	if (digest(bundle) !== p.bundle_digest) throw new TeamError("invalid");
	return TeamProposalDetailSchema.parse({
		id: p.id,
		key: p.key,
		ownerId: p.owner_id,
		bundleDigest: p.bundle_digest,
		createdAt: p.created_at,
		bundle,
		decision: p.decision ? decision(p.decision) : null,
	});
}
/** Main-only facade; root owns router/settings/workspace/lifecycle composition. */
export class TeamService {
	private instance: {
		id: string;
		auth: TeamAuth;
		login: TeamLogin;
		client: TeamClient;
		preferences: EncryptedTeamStore;
		ledger: EncryptedTeamStore;
	} | null = null;
	private epoch = 0;
	private pendingLogin: Promise<unknown> | null = null;
	private lastError: "unauthorized" | "unavailable" | null = null;
	private serial: Promise<unknown> = Promise.resolve();
	private disposed = false;
	constructor(private readonly options: TeamServiceOptions) {
		if (!options.directory && !options.userDataPath)
			throw new Error("Team user-data directory required");
	}
	private async configured() {
		if (this.disposed) throw new TeamError("unavailable");
		const settings = await this.options.getSettings();
		if (!settings.url || !settings.publishableKey || !settings.serviceUrl) {
			this.instance?.login.dispose();
			this.instance = null;
			return null;
		}
		const id = digest(settings);
		if (this.instance?.id === id) return this.instance;
		this.instance?.login.dispose();
		this.epoch++;
		const directory = join(
			this.options.directory ?? this.options.userDataPath ?? "",
			"team",
			id.slice(0, 24)
		);
		const auth = new TeamAuth({
			url: settings.url,
			publishableKey: settings.publishableKey,
			store: new EncryptedTeamStore(join(directory, "session.bin"), this.options.encryption),
			fetch: this.options.fetch,
			allowLocal: this.options.allowLocal,
		});
		const client = new TeamClient({
			url: settings.serviceUrl,
			auth,
			getGitHubToken: this.options.getGitHubToken,
			getAccountRevision: () => this.options.getAccountRevision() + this.epoch + auth.revision,
			cache: new EncryptedTeamStore(join(directory, "cache.bin"), this.options.encryption),
			fetch: this.options.fetch,
			allowLocal: this.options.allowLocal,
		});
		this.instance = {
			id,
			auth,
			client,
			login: new TeamLogin(auth, this.options.openExternal),
			preferences: new EncryptedTeamStore(join(directory, "scopes.bin"), this.options.encryption),
			ledger: new EncryptedTeamStore(join(directory, "apply.bin"), this.options.encryption),
		};
		return this.instance;
	}
	private async current() {
		const instance = await this.configured();
		if (!instance) throw new TeamError("unavailable");
		const session = await instance.auth.session();
		return {
			instance,
			userId: session.user.id,
			revision: this.options.getAccountRevision() + this.epoch + instance.auth.revision,
		};
	}
	private fence(context: { instance: NonNullable<TeamService["instance"]>; revision: number }) {
		if (
			this.instance !== context.instance ||
			this.disposed ||
			context.revision !==
				this.options.getAccountRevision() + this.epoch + context.instance.auth.revision
		)
			throw new TeamError("unauthorized");
	}
	private async preferences(instance: NonNullable<TeamService["instance"]>) {
		return PreferencesSchema.parse((await instance.preferences.read()) ?? { users: {} });
	}
	private async scopes(context: Awaited<ReturnType<TeamService["current"]>>) {
		const prefs = await this.preferences(context.instance);
		this.fence(context);
		return prefs.users[context.userId]?.scopes ?? [];
	}
	private async scope(repository?: string) {
		const context = await this.current();
		const scopes = await this.scopes(context);
		const scope = repository
			? scopes.find((s) => s.repository.toLowerCase() === repository.toLowerCase())
			: scopes.length === 1
				? scopes[0]
				: undefined;
		if (!scope) throw new TeamError("invalid");
		return { ...context, scope };
	}
	private write<T>(run: () => Promise<T>): Promise<T> {
		const next = this.serial.then(run);
		this.serial = next.catch(() => {});
		return next;
	}
	async status(_input: unknown = {}) {
		const capabilities = {
			canShare: !!this.options.readLocalFix,
			canApply: !!this.options.applyProposal,
		};
		try {
			const instance = await this.configured();
			if (!instance)
				return TeamStatusSchema.parse({
					configured: false,
					connection: "unconfigured",
					userId: null,
					scopes: [],
					...capabilities,
					error: "configuration",
				});
			const state = await instance.auth.status();
			let scopes: TeamScope[] = [];
			if (state.userId)
				scopes = (await this.preferences(instance)).users[state.userId]?.scopes ?? [];
			return TeamStatusSchema.parse({
				configured: true,
				connection: this.pendingLogin ? "connecting" : state.status,
				userId: state.userId,
				scopes,
				...capabilities,
				error: this.lastError,
			});
		} catch (error) {
			return TeamStatusSchema.parse({
				configured: false,
				connection: "unconfigured",
				userId: null,
				scopes: [],
				...capabilities,
				error: error instanceof TeamError ? error.code : "configuration",
			});
		}
	}
	async login(_input: unknown = {}) {
		const instance = await this.configured();
		if (!instance) throw new TeamError("unavailable");
		if (!this.pendingLogin) {
			this.lastError = null;
			const operation = instance.login
				.connect()
				.then(
					() => {
						if (this.pendingLogin === operation && this.instance === instance) this.epoch++;
					},
					() => {
						if (this.pendingLogin === operation && this.instance === instance)
							this.lastError = "unauthorized";
					}
				)
				.finally(() => {
					if (this.pendingLogin === operation) this.pendingLogin = null;
				});
			this.pendingLogin = operation;
		}
		return this.status();
	}
	async logout(_input: unknown = {}) {
		this.epoch++;
		const instance = await this.configured();
		instance?.login.dispose();
		await instance?.auth.disconnect();
		this.pendingLogin = null;
		this.lastError = null;
		return this.status();
	}
	async organizations(_input: unknown = {}) {
		const c = await this.current();
		const result = TeamOrganizationsSchema.parse(await c.instance.client.organizations());
		this.fence(c);
		return result;
	}
	async createOrganization(raw: unknown) {
		const input = CreateOrganizationSchema.parse(raw);
		const c = await this.current();
		const result = TeamOrganizationSchema.parse(await c.instance.client.createOrganization(input));
		this.fence(c);
		return result;
	}
	async repositories(raw: unknown) {
		const input = z
			.object({ orgId: z.uuid(), offset: z.int().min(0).max(10000).default(0) })
			.parse(raw);
		const c = await this.current();
		const result = TeamRepositoriesSchema.parse(
			await c.instance.client.repositories(input.orgId, input.offset)
		);
		this.fence(c);
		return result;
	}
	async registerRepository(raw: unknown) {
		const input = RegisterRepositorySchema.parse(raw);
		const c = await this.current();
		const result = TeamRepositorySchema.parse(await c.instance.client.registerRepository(input));
		this.fence(c);
		return result;
	}
	async selectScope(raw: unknown) {
		const input = SelectScopeSchema.parse(raw);
		return this.write(async () => {
			const c = await this.current();
			const orgs = TeamOrganizationsSchema.parse(await c.instance.client.organizations());
			if (!orgs.items.some((org) => org.id === input.orgId)) throw new TeamError("forbidden");
			const repository = TeamRepositorySchema.parse(
				await c.instance.client.resolveRepository(input.orgId, input.repositoryId)
			);
			this.fence(c);
			const scope = TeamScopeSchema.parse({
				orgId: input.orgId,
				repositoryId: repository.repositoryId,
				repository: repository.fullName,
				analysisVersion: orgs.analysisVersion,
			});
			const prefs = await this.preferences(c.instance);
			const existing = prefs.users[c.userId]?.scopes ?? [];
			prefs.users[c.userId] = {
				scopes: [
					...existing.filter((s) => s.repository.toLowerCase() !== scope.repository.toLowerCase()),
					scope,
				],
			};
			this.fence(c);
			await c.instance.preferences.write(prefs);
			this.fence(c);
			this.epoch++;
			return scope;
		});
	}
	async scopeForRepository(repository: string) {
		if (!(await this.configured())) return null;
		const c = await this.current();
		return (
			(await this.scopes(c)).find((s) => s.repository.toLowerCase() === repository.toLowerCase()) ??
			null
		);
	}
	async prepare(raw: ConversationPRContext, signal: AbortSignal) {
		const context = ConversationPRContextSchema.parse(raw);
		const c = await this.scope(context.pr.repository);
		signal.throwIfAborted();
		const current = TeamOrganizationsSchema.parse(await c.instance.client.organizations());
		if (!current.items.some((org) => org.id === c.scope.orgId)) throw new TeamError("forbidden");
		this.fence(c);
		const result = await new TeamPreparationProvider(c.instance.client, {
			...c.scope,
			analysisVersion: current.analysisVersion,
		}).prepare(context, signal);
		this.fence(c);
		return result;
	}
	async proposals(raw: unknown = {}) {
		const input = ProposalsInputSchema.parse(raw);
		const c = await this.scope(input.repository);
		const result = z
			.object({
				items: z
					.array(
						z.object({
							id: z.string(),
							key: z.unknown(),
							owner_id: z.string(),
							bundle_digest: z.string(),
							created_at: z.string(),
							decision: z.unknown().nullable(),
						})
					)
					.max(20),
				nextOffset: z.number().nullable(),
			})
			.parse(
				await c.instance.client.browseProposals({
					orgId: c.scope.orgId,
					repositoryId: c.scope.repositoryId,
					prNumber: input.prNumber,
					offset: input.offset,
				})
			);
		this.fence(c);
		return TeamProposalPageSchema.parse({
			items: result.items.map((p) => ({
				id: p.id,
				key: p.key,
				ownerId: p.owner_id,
				bundleDigest: p.bundle_digest,
				createdAt: p.created_at,
				decision: p.decision ? decision(p.decision) : null,
			})),
			nextOffset: result.nextOffset,
		});
	}
	private async find(raw: unknown) {
		const input = ReadProposalInputSchema.parse(raw);
		const c = await this.current();
		const scopes = (await this.scopes(c)).filter(
			(scope) =>
				!input.repository || scope.repository.toLowerCase() === input.repository.toLowerCase()
		);
		for (const scope of scopes) {
			const value = await c.instance.client.getProposal({
				orgId: scope.orgId,
				repositoryId: scope.repositoryId,
				proposalId: input.proposalId,
			});
			this.fence(c);
			if (value) {
				const detail = proposal(value);
				if (detail.key.orgId !== scope.orgId || detail.key.repositoryId !== scope.repositoryId)
					throw new TeamError("invalid");
				return { ...c, scope, detail };
			}
		}
		throw new TeamError("forbidden");
	}
	async readProposal(raw: unknown) {
		return (await this.find(raw)).detail;
	}
	async previewProposal(raw: unknown) {
		const input = PreviewLocalProposalSchema.parse(raw);
		if (!this.options.readLocalFix) throw new TeamError("unavailable");
		const c = await this.scope(input.repository);
		const bundle = validateBundle(
			await this.options.readLocalFix({ candidateId: input.candidateId, scope: c.scope })
		);
		this.fence(c);
		if (
			bundle.key.orgId !== c.scope.orgId ||
			bundle.key.repositoryId !== c.scope.repositoryId ||
			bundle.key.analysisVersion !== c.scope.analysisVersion
		)
			throw new TeamError("conflict");
		return TeamLocalPreviewSchema.parse({
			candidateId: input.candidateId,
			bundle,
			bundleDigest: digest(bundle),
		});
	}
	async shareProposal(raw: unknown) {
		const input = ShareLocalProposalSchema.parse(raw);
		const c = await this.scope(input.repository);
		const preview = await this.previewProposal({
			candidateId: input.candidateId,
			repository: input.repository,
		});
		if (preview.bundleDigest !== input.bundleDigest) throw new TeamError("conflict");
		this.fence(c);
		const result = await c.instance.client.shareProposal({
			requestId: input.requestId,
			bundle: preview.bundle,
			bundleDigest: input.bundleDigest,
		});
		this.fence(c);
		return TeamMutationResultSchema.parse({
			status: result.status,
			proposal: result.value ? proposal({ ...(result.value as object), decision: null }) : null,
			decision: null,
		});
	}
	async decideProposal(raw: unknown) {
		const input = DecideTeamProposalSchema.parse(raw);
		const c = await this.find({ proposalId: input.proposalId, repository: input.repository });
		if (c.detail.bundleDigest !== input.bundleDigest) throw new TeamError("conflict");
		const result = await c.instance.client.decideProposal({
			key: c.detail.key,
			proposalId: input.proposalId,
			bundleDigest: input.bundleDigest,
			requestId: input.requestId,
			decision: input.decision,
			confirmed: input.confirmed,
		});
		this.fence(c);
		return TeamMutationResultSchema.parse({
			status: result.status,
			proposal: null,
			decision: result.value ? decision(result.value) : null,
		});
	}
	async applyProposal(raw: unknown) {
		const input = ApplyTeamProposalSchema.parse(raw);
		const apply = this.options.applyProposal;
		if (!apply) throw new TeamError("unavailable");
		return this.write(async () => {
			const c = await this.find({ proposalId: input.proposalId, repository: input.repository });
			if (c.detail.bundleDigest !== input.bundleDigest) throw new TeamError("conflict");
			const ledger = LedgerSchema.parse((await c.instance.ledger.read()) ?? {});
			const id = `${c.userId}:${input.requestId}`;
			const previous = ledger[id];
			if (previous) {
				if (digest(previous.input) !== digest(input)) throw new TeamError("conflict");
				this.fence(c);
				return previous.receipt;
			}
			const proof = z
				.object({ proposal: z.unknown(), decision: z.unknown(), userId: z.uuid() })
				.parse(
					await c.instance.client.authorizeApply(c.detail.key, input.proposalId, input.bundleDigest)
				);
			const accepted = decision(proof.decision);
			if (
				proof.userId !== c.userId ||
				accepted.authorId !== c.userId ||
				accepted.decision !== "accept" ||
				accepted.bundleDigest !== input.bundleDigest ||
				accepted.proposalId !== input.proposalId
			)
				throw new TeamError("forbidden");
			this.fence(c);
			const receipt = TeamApplyReceiptSchema.parse({
				status: "pending",
				requestId: input.requestId,
				proposalId: input.proposalId,
				bundleDigest: input.bundleDigest,
				baseSha: c.detail.bundle.baseSha,
				candidateSha: c.detail.bundle.candidateSha,
			});
			ledger[id] = { input, receipt };
			await c.instance.ledger.write(ledger);
			this.fence(c);
			try {
				const result = TeamApplyReceiptSchema.parse(
					await apply({
						requestId: input.requestId,
						proposalId: input.proposalId,
						bundleDigest: input.bundleDigest,
						userId: c.userId,
						bundle: c.detail.bundle,
						decision: accepted,
					})
				);
				if (
					result.requestId !== input.requestId ||
					result.proposalId !== input.proposalId ||
					result.bundleDigest !== input.bundleDigest ||
					result.baseSha !== receipt.baseSha ||
					result.candidateSha !== receipt.candidateSha
				)
					throw new TeamError("invalid");
				this.fence(c);
				ledger[id] = { input, receipt: result };
				await c.instance.ledger.write(ledger);
				this.fence(c);
				return result;
			} catch {
				this.fence(c);
				return receipt;
			}
		});
	}
	async progressConflicts(_input: unknown = {}) {
		const c = await this.current();
		const result = await c.instance.client.progressConflicts();
		this.fence(c);
		return result;
	}
	async resolveProgressConflict(input: unknown) {
		const c = await this.current();
		const result = await c.instance.client.resolveProgressConflict(input);
		this.fence(c);
		return result;
	}
	async flushProgress(_input: unknown = {}) {
		const c = await this.current();
		const saved = await c.instance.client.flushProgress();
		const conflicts = await c.instance.client.progressConflicts();
		this.fence(c);
		return { saved, conflicts };
	}

	dispose() {
		this.disposed = true;
		this.epoch++;
		this.instance?.login.dispose();
	}
}
