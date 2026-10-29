import { z } from "zod";
import { CodeLocationSchema, CommitShaSchema, IdSchema, RepositoryPathSchema } from "./common";
import { GitHubRepositorySchema, ReviewCacheSchema, ReviewFileSchema } from "./prepared-review";
import { PullRequestSchema } from "./review";

export const CenterSectionSchema = z.enum([
	"home",
	"reviews",
	"feedback",
	"tickets",
	"completed",
	"activity",
]);
export const WatchedRepositorySchema = z.strictObject({
	id: IdSchema,
	repository: GitHubRepositorySchema,
	localPath: z.string().max(4096).nullable(),
	defaultBranch: z.string().min(1).max(200).nullable(),
	addedAt: z.iso.datetime(),
	linearTeamIds: z.array(IdSchema).max(50).default([]),
	linearProjectIds: z.array(IdSchema).max(100).default([]),
});
export const RepositoryChoiceSchema = z.strictObject({
	repository: GitHubRepositorySchema,
	defaultBranch: z.string().min(1).max(200),
	private: z.boolean(),
});
export const ReviewQueueItemSchema = z.strictObject({
	pr: PullRequestSchema,
	repositoryId: IdSchema,
	kind: z.enum(["incoming", "own"]),
	baseBranch: z.string().max(200),
	headBranch: z.string().max(200),
	updatedAt: z.iso.datetime(),
	draft: z.boolean(),
	reviewState: z.enum(["requested", "waiting", "commented", "changes-requested", "approved"]),
	feedbackCount: z.int().nonnegative(),
	lastFeedbackAt: z.iso.datetime().nullable(),
	preparationStatus: z.enum(["queued", "preparing", "ready", "error"]).optional(),
});
export const PullRequestFeedbackSchema = z.strictObject({
	id: IdSchema,
	prId: IdSchema,
	author: z.string().max(100),
	body: z.string().max(12000),
	url: z.url(),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
	kind: z.enum(["review", "inline", "conversation"]),
	state: z.string().max(100).nullable(),
	path: RepositoryPathSchema.nullable(),
	line: z.int().positive().nullable(),
	startLine: z.int().positive().nullable().optional(),
	commitSha: CommitShaSchema.nullable(),
	suggestion: z.string().max(20000).nullable(),
});
export const LinearScopeSchema = z.strictObject({
	id: IdSchema,
	name: z.string().max(200),
	kind: z.enum(["team", "project"]),
	key: z.string().max(50).optional(),
});
export const LinearTicketSchema = z.strictObject({
	id: IdSchema,
	identifier: z.string().min(1).max(100),
	title: z.string().min(1).max(1000),
	description: z.string().max(30000),
	url: z.url(),
	updatedAt: z.iso.datetime(),
	state: z.strictObject({
		id: IdSchema,
		name: z.string().max(100),
		type: z.enum(["triage", "backlog", "unstarted", "started", "completed", "canceled"]),
	}),
	priority: z.int().min(0).max(4),
	teamId: IdSchema,
	teamName: z.string().max(200),
	projectId: IdSchema.nullable(),
	projectName: z.string().max(200).nullable(),
	assigneeId: IdSchema,
	assigneeName: z.string().max(200),
});
export const WorkCheckSchema = z.strictObject({
	id: IdSchema,
	command: z.string().max(500),
	args: z.array(z.string().max(1000)).max(50),
	commitSha: CommitShaSchema,
	startedAt: z.iso.datetime(),
	finishedAt: z.iso.datetime(),
	exitCode: z.int(),
	logId: IdSchema,
});
export const WorkDecisionSchema = z.strictObject({
	id: IdSchema,
	question: z.string().min(1).max(6000),
	reason: z.string().max(6000),
	createdAt: z.iso.datetime(),
	answer: z.string().max(10000).nullable(),
	answeredAt: z.iso.datetime().nullable(),
});
export const WorkJobSchema = z.strictObject({
	id: IdSchema,
	ticket: LinearTicketSchema.nullable(),
	feedback: PullRequestFeedbackSchema.nullable().optional(),
	repositoryId: IdSchema,
	repository: GitHubRepositorySchema,
	state: z.enum([
		"queued",
		"running",
		"needs-input",
		"paused",
		"validating",
		"ready",
		"failed",
		"cancelled",
	]),
	pauseReason: z.enum(["user", "shutdown"]).nullable().optional(),
	reviewedAt: z.iso.datetime().nullable().optional(),
	publishedHeadSha: CommitShaSchema.nullable().optional(),
	feedbackAppliedAt: z.iso.datetime().nullable().optional(),
	revisions: z
		.array(
			z.strictObject({ instruction: z.string().min(1).max(10000), createdAt: z.iso.datetime() })
		)
		.max(50)
		.optional(),
	branch: z.string().min(1).max(250),
	worktreePath: z.string().max(4096).nullable(),
	baseSha: CommitShaSchema.nullable(),
	headSha: CommitShaSchema.nullable(),
	brief: z.string().min(1).max(20000),
	summary: z.string().max(12000),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
	decisions: z.array(WorkDecisionSchema).max(50),
	checks: z.array(WorkCheckSchema).max(100),
	changedFiles: z.array(RepositoryPathSchema).max(300),
	pullRequest: PullRequestSchema.nullable(),
	error: z.string().max(1000).nullable(),
});
export const WorkNoticeSchema = z.strictObject({
	id: IdSchema,
	kind: z.enum(["work-ready", "decision", "work-failed", "feedback", "connection"]),
	title: z.string().min(1).max(300),
	detail: z.string().max(3000),
	jobId: IdSchema.nullable(),
	prId: IdSchema.nullable(),
	createdAt: z.iso.datetime(),
	announcedAt: z.iso.datetime().nullable(),
	seenAt: z.iso.datetime().nullable(),
});
export const LinearTicketSummarySchema = LinearTicketSchema.omit({ description: true });
export const WorkJobSummarySchema = WorkJobSchema.omit({
	brief: true,
	decisions: true,
	checks: true,
	changedFiles: true,
}).extend({
	ticket: LinearTicketSummarySchema.nullable(),
	pendingDecisions: z.int().nonnegative(),
	changedFileCount: z.int().nonnegative(),
});
export const HubPreferencesSchema = z.strictObject({
	linearTeamIds: z.array(IdSchema).max(50),
	linearProjectIds: z.array(IdSchema).max(100),
	maxWorkers: z.int().min(1).max(4).default(2),
	autoApplySuggestions: z.boolean().default(true),
});
export const HubPersistenceSchema = z.strictObject({
	version: z.literal(1),
	repositories: z.array(WatchedRepositorySchema).max(30),
	preferences: HubPreferencesSchema,
	tickets: z.array(LinearTicketSchema).max(500),
	jobs: z.array(WorkJobSchema).max(200),
	notices: z.array(WorkNoticeSchema).max(500),
});
export const HubSnapshotSchema = z.strictObject({
	sequence: z.int().nonnegative(),
	refreshedAt: z.iso.datetime().nullable(),
	refreshing: z.boolean(),
	viewer: z.strictObject({
		githubLogin: z.string().max(100).nullable(),
		linearName: z.string().max(200).nullable(),
	}),
	connections: z.strictObject({ github: z.boolean(), linear: z.boolean(), model: z.boolean() }),
	repositories: z.array(WatchedRepositorySchema).max(30),
	reviews: z.array(ReviewQueueItemSchema).max(1000),
	tickets: z.array(LinearTicketSummarySchema).max(500),
	jobs: z.array(WorkJobSummarySchema).max(200),
	notices: z.array(WorkNoticeSchema).max(500),
	preferences: HubPreferencesSchema,
	errors: z
		.array(
			z.strictObject({
				source: z.enum(["github", "linear", "worker"]),
				message: z.string().max(1000),
				repositoryId: IdSchema.optional(),
			})
		)
		.max(40),
});
export const HubOperationSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("refresh") }),
	z.strictObject({ kind: z.literal("retry-review"), prId: IdSchema }),
	z.strictObject({
		kind: z.literal("add-repository"),
		repository: GitHubRepositorySchema,
		localPath: z.string().max(4096).nullable().optional(),
	}),
	z.strictObject({ kind: z.literal("remove-repository"), repositoryId: IdSchema }),
	z.strictObject({ kind: z.literal("preferences"), preferences: HubPreferencesSchema }),
	z.strictObject({
		kind: z.literal("start-work"),
		ticketId: IdSchema,
		repositoryId: IdSchema,
		brief: z.string().min(1).max(20000),
	}),
	z.strictObject({ kind: z.literal("start-feedback-work"), prId: IdSchema, feedbackId: IdSchema }),
	z.strictObject({
		kind: z.literal("answer-decision"),
		jobId: IdSchema,
		decisionId: IdSchema,
		answer: z.string().min(1).max(10000),
	}),
	z.strictObject({ kind: z.literal("resume-work"), jobId: IdSchema }),
	z.strictObject({ kind: z.literal("pause-work"), jobId: IdSchema }),
	z.strictObject({ kind: z.literal("cancel-work"), jobId: IdSchema }),
	z.strictObject({ kind: z.literal("publish-work"), jobId: IdSchema }),
	z.strictObject({
		kind: z.literal("revise-work"),
		jobId: IdSchema,
		instruction: z.string().min(1).max(10000),
	}),
	z.strictObject({
		kind: z.literal("approve-work"),
		jobId: IdSchema,
		headSha: CommitShaSchema,
		confirmed: z.literal(true),
	}),
	z.strictObject({ kind: z.literal("seen-notice"), noticeId: IdSchema }),
	z.strictObject({ kind: z.literal("announced-notices"), noticeIds: z.array(IdSchema).max(20) }),
]);
export const HubOperationResultSchema = z.strictObject({
	snapshot: HubSnapshotSchema,
	jobId: IdSchema.optional(),
});
export const WorkLogPageSchema = z.strictObject({
	jobId: IdSchema,
	cursor: z.int().nonnegative(),
	lines: z.array(z.string().max(12000)).max(200),
	truncated: z.boolean(),
});
export const WorkReviewSchema = z.strictObject({
	job: WorkJobSchema,
	files: z.array(ReviewFileSchema.omit({ prId: true })).max(300),
});
export const SourceRangeRequestSchema = z.strictObject({
	repository: GitHubRepositorySchema,
	commitSha: CommitShaSchema,
	revision: z.enum(["base", "head"]).default("head"),
	path: RepositoryPathSchema,
	startLine: z.int().positive().default(1),
	endLine: z.int().positive().optional(),
});
export const SourceSearchRequestSchema = z.strictObject({
	repository: GitHubRepositorySchema,
	commitSha: CommitShaSchema,
	revision: z.enum(["base", "head"]).optional(),
	query: z.string().trim().min(1).max(200),
});
export const PinnedSourceSchema = z.strictObject({
	location: CodeLocationSchema,
	text: z.string().max(100000),
	language: z.string().max(100).nullable(),
	truncated: z.boolean(),
});
export const CodeFlowStepSchema = z.strictObject({
	id: IdSchema,
	title: z.string().max(200),
	explanation: z.string().max(4000),
	source: PinnedSourceSchema,
});
export const CodeFlowSchema = z.strictObject({
	title: z.string().min(1).max(200),
	summary: z.string().max(6000),
	steps: z.array(CodeFlowStepSchema).min(1).max(20),
	provenance: z.literal("source-with-inferred-order"),
});
export const RepositoryReviewCacheSchema = z.strictObject({
	repository: GitHubRepositorySchema,
	cache: ReviewCacheSchema,
});
export type CenterSection = z.infer<typeof CenterSectionSchema>;
export type WatchedRepository = z.infer<typeof WatchedRepositorySchema>;
export type RepositoryChoice = z.infer<typeof RepositoryChoiceSchema>;
export type ReviewQueueItem = z.infer<typeof ReviewQueueItemSchema>;
export type PullRequestFeedback = z.infer<typeof PullRequestFeedbackSchema>;
export type LinearScope = z.infer<typeof LinearScopeSchema>;
export type LinearTicket = z.infer<typeof LinearTicketSchema>;
export type WorkJob = z.infer<typeof WorkJobSchema>;
export type WorkJobSummary = z.infer<typeof WorkJobSummarySchema>;
export type LinearTicketSummary = z.infer<typeof LinearTicketSummarySchema>;
export type WorkCheck = z.infer<typeof WorkCheckSchema>;
export type WorkNotice = z.infer<typeof WorkNoticeSchema>;
export type WorkDecision = z.infer<typeof WorkDecisionSchema>;
export type HubPreferences = z.infer<typeof HubPreferencesSchema>;
export type HubPersistence = z.infer<typeof HubPersistenceSchema>;
export type HubSnapshot = z.infer<typeof HubSnapshotSchema>;
export type HubOperation = z.infer<typeof HubOperationSchema>;
export type HubOperationResult = z.infer<typeof HubOperationResultSchema>;
export type PinnedSource = z.infer<typeof PinnedSourceSchema>;
export type CodeFlow = z.infer<typeof CodeFlowSchema>;
export type WorkReview = z.infer<typeof WorkReviewSchema>;
export type WorkChangedFile = WorkReview["files"][number];

export const HUB_ERROR_MESSAGES = {
	github: "Connect GitHub in Settings to load repositories and reviews.",
	linear: "Add your Linear API key in Settings to load your assigned tickets.",
	repository: "Add and select a repository for this work.",
	notFound: "This item is unavailable. Refresh its source and try again.",
	busy: "Finish or pause this repository's active work before removing it.",
	failed: "The work request could not complete. Check its connection and try again.",
} as const;
