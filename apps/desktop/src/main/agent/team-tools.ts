import { createHash } from "node:crypto";
import { z } from "zod";
import {
	type ConversationTurnInput,
	type PRFixDetail,
	PRFixDetailSchema,
	type PullRequest,
	type ShareLocalProposalSchema,
	TeamLocalPreviewSchema,
	TeamMutationResultSchema,
	type TeamScope,
	type TeamStatus,
	TeamStatusSchema,
	type WorkspaceObservation,
	WorkspaceObservationSchema,
	decodePRFixViewTarget,
} from "../../shared/contracts";
import { throwIfAborted } from "./cancellation";
import type { FunctionTool } from "./meta-client";

/** Captured by main at the actual user ingress, before any model/tool navigation.
 * accountKey includes the GitHub account epoch; teamUserId is the selected Team account.
 * Never construct this from model arguments, source text, or an assistant turn.
 */
export interface ReviewedFixShareIntent {
	candidateId: string;
	baseSha: string;
	headSha: string;
	reviewedAt: string;
	pr: PullRequest;
	accountKey: string;
	teamUserId: string;
	/** Exact selected recipient organization/repository at ingress. */
	teamScope: TeamScope;
}
export interface ConversationTeamPorts {
	/** Durable acknowledged, currently visible primary workspace; null when hidden/modal. */
	observe(
		sessionId: string,
		signal: AbortSignal
	): Promise<{
		workspace: WorkspaceObservation | null;
		accountKey: string;
		/** Fresh authorized original PR, including its current base/head. */
		pr: PullRequest | null;
	}>;
	detail(candidateId: string, signal: AbortSignal): Promise<PRFixDetail>;
	status(): Promise<TeamStatus>;
	/** Read a main-recorded ingress intent. Absent means no write authority. */
	shareIntent(
		turn: ConversationTurnInput
	): ReviewedFixShareIntent | null | Promise<ReviewedFixShareIntent | null>;
	previewProposal(input: { candidateId: string; repository: string }): Promise<
		z.infer<typeof TeamLocalPreviewSchema>
	>;
	shareProposal(
		input: z.infer<typeof ShareLocalProposalSchema>
	): Promise<z.infer<typeof TeamMutationResultSchema>>;
}
/** Deliberately narrow standalone imperative; explanations/quotes/conditions never grant consent. */
export function explicitReviewedFixShareRequested(text: string): boolean {
	return /^(?:please\s+)?(?:share|send)\s+(?:this|the selected)\s+(?:reviewed\s+)?(?:fix|proposal)\s+(?:with|to)\s+(?:the\s+)?(?:author|team)(?:\s+please)?[.!]?$/i.test(
		text.trim()
	);
}
const schemas = {
	inspect_team_sharing: z.strictObject({}),
	share_reviewed_fix: z.strictObject({ candidateId: z.string().min(1).max(200) }),
};
const messages = {
	permission:
		"Ask explicitly to share this reviewed fix with the author or team while that candidate is selected.",
	selection: "Open the exact Suggested fix, review its current head, and request sharing again.",
	connection:
		"Connect Team sharing and select an authorized organization/repository in Settings, then request sharing again.",
	changed:
		"The account, PR, candidate or reviewed selection changed. Reopen and review the current candidate, then request sharing again.",
	unknown:
		"Sharing has an unknown outcome. Check Team proposals before making another request; do not resend automatically.",
	unavailable:
		"Team sharing could not be verified. Check the Team connection and current candidate before requesting sharing again.",
} as const;
class TeamToolError extends Error {
	constructor(
		readonly code: keyof typeof messages,
		options?: ErrorOptions
	) {
		super(`team-sharing-${code}: ${messages[code]}`, options);
	}
}
const samePR = (a: PullRequest, b: PullRequest) =>
	a.id === b.id &&
	a.repository === b.repository &&
	a.number === b.number &&
	a.baseSha === b.baseSha &&
	a.headSha === b.headSha &&
	a.author === b.author;
const sameScope = (a: TeamScope, b: TeamScope) =>
	a.orgId === b.orgId &&
	a.repositoryId === b.repositoryId &&
	a.repository === b.repository &&
	a.analysisVersion === b.analysisVersion;
// Retain outcomes across tool instances for the same long-lived main ports. An unknown
// write is never replayed. Main owns process-restart recovery through Team's existing ledger.
const attempts = new WeakMap<
	ConversationTeamPorts,
	Map<string, { digest: string; result: Promise<unknown> }>
>();
export class ConversationTeamTools {
	constructor(
		private readonly ports: ConversationTeamPorts,
		private readonly turn: ConversationTurnInput,
		private readonly signal: AbortSignal
	) {}
	get tools(): FunctionTool[] {
		return Object.entries(schemas).map(([name, schema]) => ({
			type: "function",
			name,
			parameters: z.toJSONSchema(schema),
			description:
				name === "inspect_team_sharing"
					? "Inspect actual Team connection and repository scopes. Read-only; this grants no share permission."
					: "Share only the actual selected already-reviewed local fix after explicit real-user ingress permission. Candidate ID only. Stores an exact reported proposal in repository-authorized Team storage; does not notify via GitHub or Slack, publish code, accept, apply or merge. Pending/unknown is not shared.",
		}));
	}
	has(name: string) {
		return Object.hasOwn(schemas, name);
	}
	private async validate(intent: ReviewedFixShareIntent) {
		throwIfAborted(this.signal);
		const observation = await this.ports.observe(this.turn.sessionId, this.signal);
		const workspace =
			observation.workspace && WorkspaceObservationSchema.parse(observation.workspace).workspace;
		const canvas = workspace?.canvases.find((c) => c.id === workspace.primaryId);
		if (
			!canvas ||
			canvas.kind !== "center" ||
			canvas.section !== "fixes" ||
			!canvas.selectedId ||
			decodePRFixViewTarget(canvas.selectedId).id !== intent.candidateId ||
			canvas.fixSource?.id !== intent.candidateId ||
			canvas.fixSource.headSha !== intent.headSha ||
			canvas.fixSource.baseSha !== intent.baseSha
		)
			throw new TeamToolError("selection");
		const detail = PRFixDetailSchema.parse(
			await this.ports.detail(intent.candidateId, this.signal)
		);
		const fix = detail.fix;
		if (
			observation.accountKey !== intent.accountKey ||
			!observation.pr ||
			!samePR(observation.pr, intent.pr) ||
			fix.id !== intent.candidateId ||
			fix.phase !== "ready" ||
			!fix.reviewedAt ||
			fix.reviewedAt !== intent.reviewedAt ||
			fix.baseSha !== intent.pr.headSha ||
			fix.headSha !== intent.headSha ||
			fix.baseSha !== intent.baseSha ||
			!samePR(fix.pr, intent.pr) ||
			fix.feedback.prId !== fix.pr.id ||
			!detail.review ||
			detail.review.job.id !== fix.jobId ||
			detail.review.job.headSha !== fix.headSha ||
			detail.review.job.baseSha !== fix.baseSha ||
			detail.review.job.repository !== fix.pr.repository
		)
			throw new TeamToolError("changed");
		const status = TeamStatusSchema.parse(await this.ports.status());
		if (
			!status.configured ||
			status.connection !== "connected" ||
			!status.canShare ||
			!status.userId
		)
			throw new TeamToolError("connection");
		if (
			status.userId !== intent.teamUserId ||
			!status.scopes.some((scope) => sameScope(scope, intent.teamScope))
		)
			throw new TeamToolError("changed");
		throwIfAborted(this.signal);
		return { detail, status };
	}
	async execute(name: string, raw: string): Promise<unknown> {
		if (!this.has(name)) throw new TeamToolError("unavailable");
		const args = schemas[name as keyof typeof schemas].parse(JSON.parse(raw));
		throwIfAborted(this.signal);
		try {
			if (name === "inspect_team_sharing") return TeamStatusSchema.parse(await this.ports.status());
			const intent = await this.ports.shareIntent(this.turn);
			if (
				!explicitReviewedFixShareRequested(this.turn.text) ||
				!intent ||
				!("candidateId" in args) ||
				args.candidateId !== intent.candidateId
			)
				throw new TeamToolError("permission");
			const { detail, status } = await this.validate(intent);
			const preview = TeamLocalPreviewSchema.parse(
				await this.ports.previewProposal({
					candidateId: intent.candidateId,
					repository: intent.pr.repository,
				})
			);
			const bundle = preview.bundle;
			const feedbackId = /:(inline|conversation):([1-9][0-9]*)$/.exec(detail.fix.feedback.id);
			const scope = status.scopes.find(
				(s) =>
					s.repository === intent.pr.repository &&
					s.orgId === bundle.key.orgId &&
					s.repositoryId === bundle.key.repositoryId &&
					s.analysisVersion === bundle.key.analysisVersion
			);
			if (!scope) throw new TeamToolError("connection");
			if (!sameScope(scope, intent.teamScope)) throw new TeamToolError("changed");
			if (
				!feedbackId ||
				bundle.feedback.id !== feedbackId[2] ||
				bundle.feedback.kind !==
					(feedbackId[1] === "inline" ? "pull-review-comment" : "issue-comment") ||
				preview.candidateId !== intent.candidateId ||
				bundle.candidateSha !== intent.headSha ||
				bundle.baseSha !== intent.baseSha ||
				bundle.key.prNumber !== intent.pr.number ||
				bundle.key.baseSha !== intent.pr.baseSha ||
				bundle.key.headSha !== intent.pr.headSha ||
				bundle.feedback.body !== detail.fix.feedback.body ||
				bundle.feedback.revision !== detail.fix.feedback.updatedAt
			)
				throw new TeamToolError("changed");
			const hash = createHash("sha256")
				.update(
					JSON.stringify([
						this.turn.sessionId,
						this.turn.turnId,
						this.turn.generation,
						this.turn.requestId,
						intent.accountKey,
						intent.teamUserId,
						intent.candidateId,
						preview.bundleDigest,
					])
				)
				.digest("hex");
			const requestId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
			await this.validate(intent);
			const fresh = TeamLocalPreviewSchema.parse(
				await this.ports.previewProposal({
					candidateId: intent.candidateId,
					repository: intent.pr.repository,
				})
			);
			if (JSON.stringify(fresh) !== JSON.stringify(preview)) throw new TeamToolError("changed");
			const final = await this.validate(intent);
			if (!final.status.scopes.some((s) => sameScope(s, scope))) throw new TeamToolError("changed");
			let ledger = attempts.get(this.ports);
			if (!ledger) {
				ledger = new Map();
				attempts.set(this.ports, ledger);
			}
			const attemptKey = JSON.stringify([
				this.turn.sessionId,
				this.turn.turnId,
				this.turn.generation,
				this.turn.requestId,
				intent.candidateId,
			]);
			const existing = ledger.get(attemptKey);
			if (existing) {
				if (existing.digest !== preview.bundleDigest) throw new TeamToolError("changed");
				return await existing.result;
			}
			const write = (async () => {
				try {
					const receipt = TeamMutationResultSchema.parse(
						await this.ports.shareProposal({
							candidateId: intent.candidateId,
							repository: intent.pr.repository,
							bundleDigest: preview.bundleDigest,
							requestId,
							confirmed: true,
						})
					);
					if (receipt.status !== "recorded" || !receipt.proposal)
						return {
							status: "pending",
							requestId,
							message:
								"Sharing is pending. Check Team proposals; do not claim delivery or resend automatically.",
						};
					if (
						receipt.proposal.ownerId !== intent.teamUserId ||
						JSON.stringify(receipt.proposal.key) !== JSON.stringify(preview.bundle.key) ||
						receipt.proposal.bundleDigest !== preview.bundleDigest ||
						JSON.stringify(receipt.proposal.bundle) !== JSON.stringify(preview.bundle)
					)
						throw new TeamToolError("unknown");
					await this.validate(intent);
					return {
						status: "shared",
						requestId,
						proposalId: receipt.proposal.id,
						message:
							"Shared in repository-authorized Team storage, available to the author with access. No GitHub or Slack notification was sent.",
					};
				} catch {
					throw new TeamToolError("unknown");
				}
			})();
			ledger.set(attemptKey, { digest: preview.bundleDigest, result: write });
			return await write;
		} catch (error) {
			throwIfAborted(this.signal);
			if (error instanceof TeamToolError) throw error;
			throw new TeamToolError("unavailable", { cause: error });
		}
	}
}
