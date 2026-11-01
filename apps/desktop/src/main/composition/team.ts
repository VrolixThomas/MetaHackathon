import { randomUUID } from "node:crypto";
import { sha256 } from "../../../../../services/team/protocol";
import type {
	CodingProviderSettings,
	ConversationPRContext,
	PRFixDetail,
	PullRequest,
} from "../../shared/contracts";
import type { SecretEncryption } from "../runtime/credentials";
import { applyAcceptedTeamProposal } from "../runtime/team-proposal-apply";
import type { WorkJobRuntime } from "../runtime/work-job-runtime";
import { TeamService, type TeamSettings } from "../team/service";
import type { CommandCenterService } from "../work/hub";
import { localFixProposal } from "./team-proposal-source";

type Ports = {
	userDataPath: string;
	encryption: SecretEncryption;
	getSettings(): Promise<TeamSettings>;
	getGitHubToken(): Promise<string | undefined>;
	getAccountRevision(): number;
	codingSettings(): Promise<CodingProviderSettings>;
	openExternal(url: string): Promise<unknown>;
	hub(): CommandCenterService;
	runtime(): WorkJobRuntime;
	fix(id: string): Promise<PRFixDetail>;
	context(prId: string, signal: AbortSignal): Promise<ConversationPRContext>;
	readPR(prId: string, signal: AbortSignal): Promise<PullRequest>;
	account(signal: AbortSignal): Promise<{ login: string }>;
};
/** The shared service never owns Git execution or substitutes reports for local check receipts. */
export function createTeamComposition(ports: Ports) {
	const applications = new Set<AbortController>();
	const service: TeamService = new TeamService({
		userDataPath: ports.userDataPath,
		encryption: ports.encryption,
		getSettings: ports.getSettings,
		getGitHubToken: ports.getGitHubToken,
		getAccountRevision: ports.getAccountRevision,
		openExternal: async (url) => {
			await ports.openExternal(url);
		},
		readLocalFix: async (input, signal = AbortSignal.timeout(60000)) =>
			localFixProposal(
				await ports.fix(input.candidateId),
				input.scope,
				{ context: ports.context, log: (id) => ports.runtime().getLog(id) },
				signal
			),
		applyProposal: async (input) => {
			const codingProvider = await ports.codingSettings();
			const controller = new AbortController();
			applications.add(controller);
			const signal = AbortSignal.any([
				controller.signal,
				input.signal ?? AbortSignal.timeout(10 * 60_000),
			]);
			try {
				const scope = (await service.status()).scopes.find(
					(item) =>
						item.orgId === input.bundle.key.orgId &&
						item.repositoryId === input.bundle.key.repositoryId
				);
				if (!scope) throw new Error("Select this proposal's team repository before applying it.");
				const repositoryName = scope.repository;
				const prId = `${repositoryName}#${input.bundle.key.prNumber}`;
				const repository = (await ports.hub().snapshot()).repositories.find(
					(item) => item.repository.toLowerCase() === repositoryName.toLowerCase()
				);
				if (!repository?.localPath)
					throw new Error(
						"Connect this repository's local checkout before applying the accepted fix."
					);
				const authorizeCurrent = async () => {
					const [detail, current, account, status] = await Promise.all([
						service.readProposal({ proposalId: input.proposalId, repository: repositoryName }),
						ports.readPR(prId, signal),
						ports.account(signal),
						service.status(),
					]);
					if (
						detail.bundleDigest !== input.bundleDigest ||
						detail.decision?.decision !== "accept" ||
						detail.decision.authorId !== input.userId ||
						status.userId !== input.userId ||
						current.headSha !== input.bundle.baseSha ||
						current.author.toLowerCase() !== account.login.toLowerCase()
					)
						throw new Error("The proposal's author acceptance or current PR head changed.");
					return {
						proposalId: input.proposalId,
						bundleDigest: input.bundleDigest,
						decisionId: detail.decision.id,
						decision: "accept" as const,
						repository: repository.repository,
						headSha: current.headSha,
						authorUserId: detail.decision.authorId,
						acceptedByUserId: input.userId,
					};
				};
				const applied = await applyAcceptedTeamProposal(
					{
						requestId: input.requestId,
						proposalId: input.proposalId,
						bundleDigest: input.bundleDigest,
						bundle: input.bundle,
					},
					{ runtime: ports.runtime(), repository, authorizeCurrent },
					signal
				);
				const current = await ports.readPR(prId, signal);
				const feedback = (await ports.hub().feedback(prId, signal)).find((item) =>
					item.id.endsWith(
						`:${input.bundle.feedback.kind === "issue-comment" ? "conversation" : "inline"}:${input.bundle.feedback.id}`
					)
				);
				if (
					!feedback ||
					current.headSha !== applied.baseSha ||
					sha256(feedback.body) !== input.bundle.feedback.bodyDigest ||
					Date.parse(feedback.updatedAt) !== Date.parse(input.bundle.feedback.revision)
				)
					throw new Error("The original feedback or PR head changed after local application.");
				const job = {
					...applied.review.job,
					codingProvider,
					feedback,
					pullRequest: current,
					reviewedAt: null,
				};
				await ports.hub().update((state) => {
					const existing = state.jobs.find((item) => item.id === job.id);
					if (existing && existing.headSha !== job.headSha)
						throw new Error("The local application result changed.");
					if (!existing) {
						state.jobs.push(job);
						state.notices.push({
							id: randomUUID(),
							kind: "work-ready",
							title: `Ready to review: ${current.title}`.slice(0, 300),
							detail: `The accepted shared fix was applied locally with ${applied.checks.length} recorded checks. Review its actual diff before publishing.`,
							jobId: job.id,
							prId: current.id,
							headSha: applied.appliedSha,
							decisionId: null,
							createdAt: new Date().toISOString(),
							announcedAt: null,
							seenAt: null,
						});
					}
				});
				return {
					status: "applied" as const,
					requestId: input.requestId,
					proposalId: input.proposalId,
					bundleDigest: input.bundleDigest,
					baseSha: input.bundle.baseSha,
					candidateSha: input.bundle.candidateSha,
					appliedHeadSha: applied.appliedSha,
					jobId: applied.jobId,
					message: applied.checks.length
						? "Applied in an isolated checkout with actual checks. Review it in Completed work before publishing."
						: "Applied in an isolated checkout. No configured validation commands ran. Review it in Completed work before publishing.",
				};
			} finally {
				applications.delete(controller);
			}
		},
	});
	return {
		service,
		abortApplications() {
			for (const application of applications) application.abort();
		},
		dispose() {
			for (const application of applications) application.abort();
			service.dispose();
		},
	};
}
