import { WorkReviewSchema } from "../../../shared/contracts";
import { type ReviewRequestLedger, digest } from "./ledger";
import {
	IntentSchema,
	PRSchema,
	ReviewRequestError,
	type ReviewRequestIntent,
	type ReviewRequestPR,
	type ReviewRequestPorts,
	type ReviewRequestReceipt,
	requestedReviewers,
} from "./types";
export * from "./types";
export { ReviewRequestLedger } from "./ledger";
export class ReviewRequests {
	private readonly active = new Set<string>();
	constructor(
		private readonly ports: ReviewRequestPorts,
		private readonly ledger: ReviewRequestLedger
	) {}
	async send(
		raw: ReviewRequestIntent,
		reviewers: string[],
		signal: AbortSignal
	): Promise<ReviewRequestReceipt> {
		let admitted = false;
		let lock = "";
		let locked = false;
		try {
			const intent = IntentSchema.parse(raw);
			const names = requestedReviewers(intent.text);
			const requested = [...new Set(reviewers.map((n) => n.toLowerCase()))].sort();
			if (
				!names ||
				JSON.stringify(names) !== JSON.stringify(requested) ||
				names.includes(intent.actor.toLowerCase())
			)
				throw new ReviewRequestError("denied");
			// Repository/job/head scope serializes different recipient sets as well.
			lock = digest([intent.accountKey, intent.jobId, intent.headSha]);
			if (this.active.has(lock)) throw new ReviewRequestError("busy");
			this.active.add(lock);
			locked = true;
			const key = digest([
				intent.accountKey,
				intent.jobId,
				intent.repository,
				intent.headSha,
				names,
			]);
			const validate = async () => {
				signal.throwIfAborted();
				const account = await this.ports.account(signal);
				const rawReview = await this.ports.selected(intent.jobId, signal);
				signal.throwIfAborted();
				if (!rawReview) throw new ReviewRequestError("changed");
				const { job } = WorkReviewSchema.parse(rawReview);
				if (
					account.accountKey !== intent.accountKey ||
					account.login.toLowerCase() !== intent.actor.toLowerCase() ||
					job.id !== intent.jobId ||
					job.repository !== intent.repository ||
					job.headSha !== intent.headSha ||
					job.state !== "ready" ||
					!job.changedFiles.length ||
					!job.checks.length ||
					job.checks.some((c) => c.exitCode !== 0 || c.commitSha !== intent.headSha) ||
					job.decisions.some((d) => d.answer === null)
				)
					throw new ReviewRequestError("changed");
				return job;
			};
			const inspect = async (): Promise<ReviewRequestPR> => {
				const job = await validate();
				if (!job.pullRequest || job.publishedHeadSha !== intent.headSha)
					throw new ReviewRequestError("changed");
				const pr = PRSchema.parse(
					await this.ports.provider.read(intent.repository, job.pullRequest.number, signal)
				);
				if (
					pr.repository !== intent.repository ||
					pr.number !== job.pullRequest.number ||
					pr.headSha !== intent.headSha ||
					job.pullRequest.headSha !== intent.headSha ||
					pr.author.toLowerCase() !== intent.actor.toLowerCase() ||
					job.pullRequest.author.toLowerCase() !== intent.actor.toLowerCase() ||
					!pr.open
				)
					throw new ReviewRequestError("changed");
				await validate();
				return pr;
			};
			await validate();
			for (const name of names)
				if (!(await this.ports.provider.canReview(intent.repository, name, signal)))
					throw new ReviewRequestError("denied");
			await validate();
			const previous = await this.ledger.read(key);
			if (!previous) {
				if (!(await this.ledger.admit(key))) throw new ReviewRequestError("unknown");
				admitted = true;
				const job = await validate();
				if (!job.pullRequest) await this.ports.publish(intent.jobId);
			}
			let pr = await inspect();
			const complete = async (evidence: ReviewRequestReceipt["evidence"]) => {
				const receipt: ReviewRequestReceipt = {
					operationId: key,
					jobId: intent.jobId,
					repository: intent.repository,
					prNumber: pr.number,
					prUrl: pr.url,
					headSha: pr.headSha,
					reviewers: names,
					requestedAt: new Date().toISOString(),
					evidence,
				};
				await this.ledger.write({ key, phase: "sent", receipt });
				return receipt;
			};
			if (!pr.draft && names.every((n) => pr.reviewers.some((r) => r.toLowerCase() === n)))
				return previous?.receipt ?? (await complete("already-requested"));
			if (previous) throw new ReviewRequestError("unknown");
			if (pr.draft) {
				await this.ledger.write({ key, phase: "readying", receipt: null });
				await validate();
				await this.ports.provider.ready(pr, signal);
				pr = await inspect();
				if (pr.draft) throw new ReviewRequestError("unknown");
			}
			// Recheck access and exact remote head immediately before notification dispatch.
			for (const name of names)
				if (!(await this.ports.provider.canReview(intent.repository, name, signal)))
					throw new ReviewRequestError("denied");
			pr = await inspect();
			if (pr.draft) throw new ReviewRequestError("changed");
			if (names.every((n) => pr.reviewers.some((r) => r.toLowerCase() === n)))
				return await complete("already-requested");
			await this.ledger.write({ key, phase: "requesting", receipt: null });
			await validate();
			signal.throwIfAborted();
			const response = PRSchema.parse(
				await this.ports.provider.request(
					pr,
					names.filter((n) => !pr.reviewers.some((r) => r.toLowerCase() === n)),
					signal
				)
			);
			await validate();
			if (
				response.number !== pr.number ||
				response.repository !== pr.repository ||
				response.headSha !== pr.headSha ||
				response.author !== pr.author ||
				response.draft ||
				!response.open ||
				!names.every((n) => response.reviewers.some((r) => r.toLowerCase() === n))
			)
				throw new ReviewRequestError("unknown");
			pr = await inspect();
			if (pr.draft || !names.every((n) => pr.reviewers.some((r) => r.toLowerCase() === n)))
				throw new ReviewRequestError("unknown");
			return await complete("request-response");
		} catch (error) {
			if (error instanceof ReviewRequestError) throw error;
			throw new ReviewRequestError(admitted ? "unknown" : "unavailable");
		} finally {
			if (locked) this.active.delete(lock);
		}
	}
}
