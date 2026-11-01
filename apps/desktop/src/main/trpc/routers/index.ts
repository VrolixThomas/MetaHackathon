import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { mergeRouters, publicProcedure, router } from "..";
import {
	ApprovalConfirmInputSchema,
	ApprovalDraftInputSchema,
	ApprovalIdentitySchema,
	ApprovalPolicySchema,
	ApprovalPresentationSchema,
} from "../../../shared/contracts";
import {
	AgentActionReceiptResultSchema,
	AgentActionSchema,
	AttentionPollResultSchema,
	AttentionPresenceSchema,
	AttentionReceiptResultSchema,
	AttentionReleaseInputSchema,
	AttentionSettleInputSchema,
	ChatConversationSchema,
	ChatMessageSchema,
	CodingProviderSettingsSchema,
	CodingProviderStatusSchema,
	ConfirmCommentInputSchema,
	DayOperateInputSchema,
	DayOperationResultSchema,
	DaySnapshotSchema,
	DayWorkItemSchema,
	DraftedCommentSchema,
	GitHubRepositorySchema,
	HUB_ERROR_MESSAGES,
	HubOperationResultSchema,
	HubOperationSchema,
	HubSnapshotSchema,
	IdSchema,
	ImageReadResultSchema,
	KnowledgeFactSchema,
	LinearScopeSchema,
	LinearTicketSchema,
	OAuthProviderInputSchema,
	OAuthStartInputSchema,
	OAuthStatusListSchema,
	OAuthStatusSchema,
	PRCommentCreateInputSchema,
	PRCommentEditInputSchema,
	PRCommentPresentationReceiptSchema,
	PRFixDetailSchema,
	PRFixReviewInputSchema,
	PRFixStartInputSchema,
	PRFixSummarySchema,
	PinnedSourceSchema,
	PullRequestFeedbackSchema,
	RepositoryChoiceSchema,
	SlackConnectionStatusSchema,
	SlackFollowConfigurationSchema,
	SlackMessagePageSchema,
	SlackViewTargetSchema,
	SourceRangeRequestSchema,
	SourceSearchRequestSchema,
	WORKSPACE_GITHUB_REQUIRED,
	WorkJobSchema,
	WorkLogPageSchema,
	WorkReviewSchema,
	WorkspaceActionReceiptSchema,
	WorkspaceCommandSchema,
	WorkspaceObservationSchema,
} from "../../../shared/contracts";
import { createConversationRouter } from "../../agent/conversation-router";
import { createAgentScreenRouter } from "../../agent/screen-context";
import { createCompositionRouters } from "../../composition";
import { createBrowserRouter } from "../../composition/browser-router";
import { createLocalBrowserRouter } from "../../composition/browser-surface";
import { operatePublicDay, publicDaySnapshot } from "../../composition/day-clarification";
import { createDiagnosticsRouter } from "../../composition/diagnostics";
import { createReviewRouter } from "../../composition/reviews-router";
import { createConfiguredVoiceRouter } from "../../composition/voice";
import { createAppConfigurationRouter } from "../../config/router";
import { createRuntimeRouter } from "../../runtime/router";
import { approvalConfirmation, getPRApprovals } from "../../services";
import { readCurrentDayClarification } from "../../services";
import {
	agentComposition,
	commentPresentations,
	conversationService,
	getAttention,
	getBrowser,
	getCodingProvider,
	getConfiguration,
	getConfigurationPorts,
	getDay,
	getDiagnostics,
	getGitHubToken,
	getHub,
	getImages,
	getLocalBrowser,
	getOAuth,
	getPRFixes,
	getPreparedComments,
	getReviews,
	getRuntime,
	getSlackConnection,
	getSlackReader,
	getSlackWorkspace,
	getTeam,
	getVoice,
	getWorkJobs,
	getWorkspace,
	pickReviewRepository,
	readCurrentDaySource,
	reconnectSlackSources,
	screenContexts,
	searchCurrentKnowledge,
} from "../../services";
import {
	ApplyTeamProposalSchema,
	CreateOrganizationSchema,
	DecideTeamProposalSchema,
	PreviewLocalProposalSchema,
	ProgressConflictListSchema,
	ProposalsInputSchema,
	ReadProposalInputSchema,
	RegisterRepositorySchema,
	ResolveProgressConflictSchema,
	SelectScopeSchema,
	ShareLocalProposalSchema,
	TeamApplyReceiptSchema,
	TeamLocalPreviewSchema,
	TeamMutationResultSchema,
	TeamOrganizationSchema,
	TeamOrganizationsSchema,
	TeamProposalDetailSchema,
	TeamProposalPageSchema,
	TeamRepositoriesSchema,
	TeamRepositorySchema,
	TeamScopeSchema,
	TeamStatusSchema,
} from "../../team/service";
import { HubFailure } from "../../work/hub";
import { bootstrapRouter } from "./bootstrap";

const hubCall = async <T>(work: () => Promise<T>): Promise<T> => {
	try {
		return await work();
	} catch (error) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: error instanceof HubFailure ? error.message : HUB_ERROR_MESSAGES.failed,
		});
	}
};
// Register feature routers here as the application grows.
export const appRouter = router({
	team: router({
		progressConflicts: publicProcedure
			.input(z.strictObject({}).optional())
			.output(ProgressConflictListSchema)
			.query(() => getTeam().progressConflicts()),
		resolveProgressConflict: publicProcedure
			.input(ResolveProgressConflictSchema)
			.output(ProgressConflictListSchema)
			.mutation(({ input }) => getTeam().resolveProgressConflict(input)),
		flushProgress: publicProcedure
			.input(z.strictObject({}).optional())
			.output(
				z.strictObject({ saved: z.int().nonnegative(), conflicts: ProgressConflictListSchema })
			)
			.mutation(() => getTeam().flushProgress()),
		status: publicProcedure
			.input(z.strictObject({}).optional())
			.output(TeamStatusSchema)
			.query(() => getTeam().status()),
		login: publicProcedure
			.input(z.strictObject({}).optional())
			.output(TeamStatusSchema)
			.mutation(() => getTeam().login()),
		logout: publicProcedure
			.input(z.strictObject({}).optional())
			.output(TeamStatusSchema)
			.mutation(() => getTeam().logout()),
		organizations: publicProcedure
			.input(z.strictObject({}).optional())
			.output(TeamOrganizationsSchema)
			.query(() => getTeam().organizations()),
		createOrganization: publicProcedure
			.input(CreateOrganizationSchema)
			.output(TeamOrganizationSchema)
			.mutation(({ input }) => getTeam().createOrganization(input)),
		repositories: publicProcedure
			.input(z.strictObject({ orgId: z.uuid(), offset: z.int().min(0).max(10000).optional() }))
			.output(TeamRepositoriesSchema)
			.query(({ input }) => getTeam().repositories(input)),
		registerRepository: publicProcedure
			.input(RegisterRepositorySchema)
			.output(TeamRepositorySchema)
			.mutation(({ input }) => getTeam().registerRepository(input)),
		selectScope: publicProcedure
			.input(SelectScopeSchema)
			.output(TeamScopeSchema)
			.mutation(({ input }) => getTeam().selectScope(input)),
		proposals: publicProcedure
			.input(ProposalsInputSchema)
			.output(TeamProposalPageSchema)
			.query(({ input }) => getTeam().proposals(input)),
		readProposal: publicProcedure
			.input(ReadProposalInputSchema)
			.output(TeamProposalDetailSchema)
			.query(({ input }) => getTeam().readProposal(input)),
		previewProposal: publicProcedure
			.input(PreviewLocalProposalSchema)
			.output(TeamLocalPreviewSchema)
			.query(({ input }) => getTeam().previewProposal(input)),
		shareProposal: publicProcedure
			.input(ShareLocalProposalSchema)
			.output(TeamMutationResultSchema)
			.mutation(({ input }) => getTeam().shareProposal(input)),
		decideProposal: publicProcedure
			.input(DecideTeamProposalSchema)
			.output(TeamMutationResultSchema)
			.mutation(({ input }) => getTeam().decideProposal(input)),
		applyProposal: publicProcedure
			.input(ApplyTeamProposalSchema)
			.output(TeamApplyReceiptSchema)
			.mutation(({ input }) => getTeam().applyProposal(input)),
	}),
	images: router({
		read: publicProcedure
			.input(z.strictObject({ id: IdSchema.max(200) }))
			.output(ImageReadResultSchema)
			.query(({ input }) => getImages().read(input.id)),
	}),
	codingProvider: router({
		status: publicProcedure
			.input(z.strictObject({}))
			.output(CodingProviderStatusSchema)
			.query(() => getCodingProvider().status()),
		refresh: publicProcedure
			.input(z.strictObject({}))
			.output(CodingProviderStatusSchema)
			.mutation(() => getCodingProvider().status(true)),
		configure: publicProcedure
			.input(CodingProviderSettingsSchema)
			.output(CodingProviderStatusSchema)
			.mutation(({ input }) => getCodingProvider().configure(input)),
		openLogin: publicProcedure
			.input(z.strictObject({}))
			.output(z.void())
			.mutation(() => getCodingProvider().openLogin()),
	}),
	prApprovals: router({
		beginEdit: publicProcedure
			.input(ApprovalIdentitySchema)
			.output(z.void())
			.mutation(({ input }) => getPRApprovals().beginEdit(input)),
		list: publicProcedure
			.input(z.strictObject({}))
			.output(z.array(ApprovalPolicySchema).max(100))
			.query(() => getPRApprovals().list()),
		draft: publicProcedure
			.input(ApprovalDraftInputSchema)
			.output(ApprovalPolicySchema)
			.mutation(({ input }) => getPRApprovals().draft(input)),
		confirm: publicProcedure
			.input(ApprovalConfirmInputSchema)
			.output(ApprovalPolicySchema)
			.mutation(({ input }) => getPRApprovals().confirm(input)),
		revoke: publicProcedure
			.input(ApprovalIdentitySchema)
			.output(z.void())
			.mutation(({ input }) => getPRApprovals().revoke(input)),
		pending: publicProcedure
			.input(z.strictObject({ sessionId: IdSchema }))
			.output(ApprovalPresentationSchema.nullable())
			.query(({ input }) => approvalConfirmation.pending(input.sessionId)),
		presented: publicProcedure
			.input(ApprovalPresentationSchema)
			.output(z.void())
			.mutation(async ({ input }) => {
				const p = (await getPRApprovals().list()).find((p) => p.id === input.id);
				if (
					!p ||
					p.status !== "draft" ||
					p.revision !== input.revision ||
					p.digest !== input.digest
				)
					throw new Error("Stale delegation presentation");
				approvalConfirmation.presented(input);
			}),
	}),
	prComments: router({
		presented: publicProcedure
			.input(PRCommentPresentationReceiptSchema)
			.output(AgentActionReceiptResultSchema)
			.mutation(({ input }) => commentPresentations.applied(input)),
		invalidate: publicProcedure
			.input(z.strictObject({ sessionId: IdSchema }))
			.output(z.void())
			.mutation(({ input }) => commentPresentations.invalidate(input.sessionId)),
		create: publicProcedure
			.input(PRCommentCreateInputSchema)
			.output(DraftedCommentSchema)
			.mutation(({ input }) => getPreparedComments().create(input)),
		edit: publicProcedure
			.input(PRCommentEditInputSchema)
			.output(DraftedCommentSchema)
			.mutation(({ input }) => getPreparedComments().edit(input)),
		confirm: publicProcedure
			.input(ConfirmCommentInputSchema)
			.output(z.strictObject({ url: z.url() }))
			.mutation(({ input }) => getPreparedComments().confirm(input)),
		cancel: publicProcedure
			.input(z.strictObject({ requestId: IdSchema }))
			.output(z.void())
			.mutation(({ input }) => {
				getPreparedComments().cancel(input.requestId);
			}),
	}),
	prFixes: router({
		list: publicProcedure
			.input(z.strictObject({}).optional())
			.output(z.array(PRFixSummarySchema).max(100))
			.query(() => getPRFixes().list()),
		detail: publicProcedure
			.input(z.strictObject({ id: IdSchema.max(200) }))
			.output(PRFixDetailSchema)
			.query(({ input }) => getPRFixes().detail(input.id)),
		start: publicProcedure
			.input(PRFixStartInputSchema)
			.output(PRFixSummarySchema)
			.mutation(({ input }) => getPRFixes().start(input)),
		reviewed: publicProcedure
			.input(PRFixReviewInputSchema)
			.output(PRFixSummarySchema)
			.mutation(({ input }) => getPRFixes().markReviewed(input)),
		cancel: publicProcedure
			.input(z.strictObject({ id: IdSchema.max(200) }))
			.output(z.void())
			.mutation(async ({ input }) => {
				await getPRFixes().cancel(input.id);
			}),
	}),
	slack: router({
		conversation: publicProcedure
			.input(SlackViewTargetSchema.pick({ conversationId: true }))
			.output(ChatConversationSchema)
			.query(({ input }) => getSlackReader().conversation(input.conversationId)),
		history: publicProcedure
			.input(
				z.strictObject({
					conversationId: SlackViewTargetSchema.shape.conversationId,
					cursor: z.string().max(2000).optional(),
				})
			)
			.output(SlackMessagePageSchema)
			.query(({ input }) => getSlackReader().read({ ...input, threadTs: null })),
		thread: publicProcedure
			.input(
				SlackViewTargetSchema.extend({ cursor: z.string().max(2000).optional() }).refine(
					(input) => input.threadTs !== null
				)
			)
			.output(SlackMessagePageSchema)
			.query(({ input }) => getSlackReader().read(input)),
		status: publicProcedure
			.input(z.strictObject({}).optional())
			.output(SlackConnectionStatusSchema)
			.query(async () => {
				const connection = getSlackConnection();
				const status = await connection.status();
				const epoch = connection.epoch;
				const source = getSlackWorkspace();
				const watching = await source.watching().catch(() => []);
				const view = source.status();
				if (getSlackConnection() !== connection || connection.epoch !== epoch)
					throw new TRPCError({ code: "CONFLICT", message: "The active source account changed" });
				const sameActor =
					status.account &&
					view.actor?.workspaceId === status.account.workspaceId &&
					view.actor.userId === status.account.userId;
				return {
					...status,
					watching: sameActor ? watching : [],
					followMode: sameActor ? view.followMode : ("all_joined" as const),
					excludedConversationIds: sameActor ? view.excludedConversationIds : [],
					membershipSync: sameActor
						? view.membershipSync
						: { phase: "pending" as const, discoveredCount: 0, completedAt: null },
					coverage:
						status.phase !== "connected"
							? ("disconnected" as const)
							: !view.watchCount ||
									["stopped", "unconfigured", "sleeping", "offline", "backoff"].includes(view.mode)
								? ("paused" as const)
								: view.transport === "socket"
									? ("socket" as const)
									: ("bounded-poll" as const),
					error: status.error ?? (view.error ? ("source-unavailable" as const) : null),
				};
			}),
		connect: publicProcedure
			.input(z.strictObject({}).optional())
			.output(z.void())
			.mutation(async () => {
				await reconnectSlackSources();
			}),
		openSetup: publicProcedure
			.input(z.strictObject({}).optional())
			.output(z.void())
			.mutation(async () => {
				const config = getConfiguration();
				await config.ensureSlackTemplate();
				await getConfigurationPorts().openEnv(config.path);
			}),
		conversations: publicProcedure
			.input(z.strictObject({ cursor: z.string().max(2000).optional() }))
			.output(
				z.strictObject({
					items: z.array(ChatConversationSchema).max(15),
					nextCursor: z.string().nullable(),
					hasMore: z.boolean(),
				})
			)
			.query(({ input }) => getSlackReader().conversations(input)),
		watch: publicProcedure
			.input(z.strictObject({ conversationIds: z.array(IdSchema).max(1000) }))
			.output(z.void())
			.mutation(async ({ input }) => {
				await getSlackWorkspace().watch(input);
			}),
		follow: publicProcedure
			.input(SlackFollowConfigurationSchema)
			.output(z.void())
			.mutation(async ({ input }) => {
				await getSlackWorkspace().follow(input);
			}),
	}),
	brain: router({
		search: publicProcedure
			.input(
				z.strictObject({ brain: z.enum(["company", "private"]), text: z.string().min(1).max(256) })
			)
			.output(z.array(KnowledgeFactSchema).max(20))
			.query(({ input }) => searchCurrentKnowledge(input, AbortSignal.timeout(30_000))),
	}),
	day: router({
		clarification: publicProcedure
			.input(z.strictObject({ itemId: IdSchema, expectedRevision: z.int().positive() }))
			.output(DayWorkItemSchema)
			.query(({ input }) => readCurrentDayClarification(input, AbortSignal.timeout(30_000))),
		thread: publicProcedure
			.input(z.strictObject({ itemId: IdSchema, expectedRevision: z.int().positive() }))
			.output(z.array(ChatMessageSchema).max(15))
			.query(({ input }) => readCurrentDaySource(input, AbortSignal.timeout(30_000))),
		snapshot: publicProcedure
			.input(z.strictObject({}).optional())
			.output(DaySnapshotSchema)
			.query(async () => {
				const current = getDay();
				const snapshot = await current.snapshot();
				if (getDay() !== current)
					throw new TRPCError({ code: "CONFLICT", message: "The active source account changed" });
				return publicDaySnapshot(snapshot);
			}),
		operate: publicProcedure
			.input(DayOperateInputSchema)
			.output(DayOperationResultSchema)
			.mutation(async ({ input }) => {
				return hubCall(() => operatePublicDay(getDay, input));
			}),
	}),
	oauth: router({
		status: publicProcedure
			.input(z.strictObject({}).optional())
			.output(OAuthStatusListSchema)
			.query(() => hubCall(() => getOAuth().status())),
		start: publicProcedure
			.input(OAuthStartInputSchema)
			.output(OAuthStatusSchema)
			.mutation(({ input }) => hubCall(() => getOAuth().start(input))),
		cancel: publicProcedure
			.input(OAuthProviderInputSchema)
			.output(OAuthStatusSchema)
			.mutation(({ input }) => hubCall(() => getOAuth().cancel(input.provider))),
		disconnect: publicProcedure
			.input(OAuthProviderInputSchema)
			.output(OAuthStatusSchema)
			.mutation(({ input }) => hubCall(() => getOAuth().disconnect(input.provider))),
		openSetup: publicProcedure
			.input(z.strictObject({}).optional())
			.output(z.void())
			.mutation(async () => {
				const config = getConfiguration();
				await config.ensureOAuthTemplate();
				await getConfigurationPorts().openEnv(config.path);
			}),
	}),
	attention: router({
		poll: publicProcedure
			.input(AttentionPresenceSchema)
			.output(AttentionPollResultSchema)
			.mutation(({ input }) => hubCall(() => getAttention().poll(input))),
		settle: publicProcedure
			.input(AttentionSettleInputSchema)
			.output(AttentionReceiptResultSchema)
			.mutation(({ input }) => hubCall(() => getAttention().settle(input))),
		release: publicProcedure
			.input(AttentionReleaseInputSchema)
			.output(AttentionReceiptResultSchema)
			.mutation(({ input }) => getAttention().release(input)),
	}),
	hub: router({
		snapshot: publicProcedure
			.input(z.strictObject({}).optional())
			.output(HubSnapshotSchema)
			.query(() => hubCall(() => getHub().snapshot())),
		operate: publicProcedure
			.input(z.strictObject({ requestId: IdSchema, operation: HubOperationSchema }))
			.output(HubOperationResultSchema)
			.mutation(({ input }) => hubCall(() => getHub().operate(input.operation, input.requestId))),
		ticket: publicProcedure
			.input(z.strictObject({ id: IdSchema }))
			.output(LinearTicketSchema)
			.query(({ input }) => hubCall(() => getHub().ticket(input.id))),
		job: publicProcedure
			.input(z.strictObject({ id: IdSchema }))
			.output(WorkJobSchema)
			.query(({ input }) => hubCall(() => getHub().job(input.id))),
		jobLog: publicProcedure
			.input(
				z.strictObject({
					jobId: IdSchema,
					cursor: z.int().nonnegative().default(0),
					limit: z.int().min(1).max(200).default(100),
				})
			)
			.output(WorkLogPageSchema)
			.query(({ input }) =>
				hubCall(() => getWorkJobs().log(input.jobId, input.cursor, input.limit))
			),
		reviewWork: publicProcedure
			.input(z.strictObject({ jobId: IdSchema }))
			.output(WorkReviewSchema)
			.query(({ input }) => hubCall(() => getWorkJobs().review(input.jobId))),
		feedback: publicProcedure
			.input(z.strictObject({ prId: IdSchema }))
			.output(z.array(PullRequestFeedbackSchema).max(1000))
			.query(({ input }) => hubCall(() => getHub().feedback(input.prId))),
		repositories: publicProcedure
			.input(z.strictObject({}).optional())
			.output(z.array(RepositoryChoiceSchema).max(1000))
			.query(() => hubCall(() => getHub().repositories())),
		linearScopes: publicProcedure
			.input(z.strictObject({}).optional())
			.output(z.array(LinearScopeSchema).max(1000))
			.query(() => hubCall(() => getHub().linearScopes())),
		source: publicProcedure
			.input(SourceRangeRequestSchema)
			.output(PinnedSourceSchema)
			.query(({ input }) => hubCall(() => getHub().source(input))),
		search: publicProcedure
			.input(SourceSearchRequestSchema)
			.output(z.array(PinnedSourceSchema).max(12))
			.query(({ input }) => hubCall(() => getHub().search(input))),
	}),
	workspace: router({
		observe: publicProcedure
			.input(z.strictObject({ sessionId: IdSchema }))
			.output(WorkspaceObservationSchema)
			.query(({ input }) => getWorkspace().observe(input.sessionId)),
		prepare: publicProcedure
			.input(
				z.strictObject({
					sessionId: IdSchema,
					requestId: IdSchema,
					expectedSequence: z.int().nonnegative(),
					command: WorkspaceCommandSchema,
				})
			)
			.output(AgentActionSchema)
			.mutation(async ({ input }) => {
				if (input.command.kind === "show-review") {
					const connected = await getGitHubToken()
						.then(Boolean)
						.catch(() => false);
					if (!connected)
						throw new TRPCError({ code: "UNAUTHORIZED", message: WORKSPACE_GITHUB_REQUIRED });
				}
				return getWorkspace().prepare(input);
			}),
		applied: publicProcedure
			.input(WorkspaceActionReceiptSchema)
			.output(AgentActionReceiptResultSchema)
			.mutation(({ input }) => getWorkspace().applied(input)),
		release: publicProcedure
			.input(z.strictObject({ sessionId: IdSchema }))
			.output(z.void())
			.mutation(({ input }) => getWorkspace().release(input.sessionId)),
	}),
	diagnostics: createDiagnosticsRouter(getDiagnostics),
	app: createAppConfigurationRouter(getConfigurationPorts),
	conversation: createConversationRouter(conversationService),
	reviews: mergeRouters(
		createReviewRouter(getReviews),
		router({
			chooseRepository: publicProcedure
				.output(
					z
						.strictObject({ repository: GitHubRepositorySchema, localPath: z.string().min(1) })
						.nullable()
				)
				.mutation(pickReviewRepository),
		})
	),
	bootstrap: bootstrapRouter,
	runtime: createRuntimeRouter(getRuntime),
	browser: createBrowserRouter(getBrowser),
	localBrowser: createLocalBrowserRouter(getLocalBrowser),
	voice: createConfiguredVoiceRouter(getVoice),
	screen: createAgentScreenRouter(screenContexts),
	...createCompositionRouters(agentComposition),
});
export type AppRouter = typeof appRouter;
