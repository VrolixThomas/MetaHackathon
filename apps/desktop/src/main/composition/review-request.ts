import { join } from "node:path";
import {
	type ConversationTurnInput,
	WorkReviewSchema,
	type WorkspaceSnapshot,
} from "../../shared/contracts";
import type { ConversationReviewRequestPorts } from "../agent/review-request-tools";
import {
	IntentSchema,
	ReviewRequestError,
	type ReviewRequestIntent,
	ReviewRequestLedger,
	ReviewRequests,
	requestedReviewers,
} from "../work/review-requests";
import { GitHubReviewRequestProvider } from "../work/review-requests/github";

export interface ReviewRequestCompositionPorts {
	/** Synchronous credential generation; increment on disconnect/account replacement. */
	epoch(): string | number;
	/** Main's acknowledged snapshot only; null if hidden, obscured, modal or not focused. */
	observe(sessionId: string, signal: AbortSignal): Promise<WorkspaceSnapshot | null>;
	/** Fresh canonical WorkJobs.review, not renderer/model data. */
	review(jobId: string, signal: AbortSignal): Promise<unknown>;
	/** Stable GitHub account identity (NOT epoch): ledger dedup must survive reconnect. */
	account(signal: AbortSignal): Promise<{ accountKey: string; login: string }>;
	token(signal: AbortSignal): Promise<string | null>;
	publish(jobId: string): Promise<unknown>;
	/** Controlled HTTP transport for unit probes; production defaults to fetch. */
	transport?: typeof fetch;
}
const identity = (turn: ConversationTurnInput) =>
	JSON.stringify([turn.sessionId, turn.turnId, turn.generation, turn.requestId]);
function target(snapshot: WorkspaceSnapshot | undefined | null) {
	const canvas = snapshot?.canvases.find((item) => item.id === snapshot.primaryId);
	if (
		!snapshot ||
		canvas?.kind !== "center" ||
		!["completed", "activity"].includes(canvas.section) ||
		!canvas.selectedId
	)
		return null;
	return {
		jobId: canvas.selectedId,
		stamp: JSON.stringify([
			snapshot.contentSequence ?? snapshot.sequence,
			canvas.id,
			canvas.section,
			canvas.selectedId,
		]),
	};
}
type Entry = {
	turn: ConversationTurnInput;
	epoch: string | number;
	controller: AbortController;
	value: Promise<ReviewRequestIntent | null>;
	intent?: ReviewRequestIntent;
};

/** One instance per private profile. No authority is accepted from tool arguments.
 * Capture synchronously at actual ingress, before any model navigation. Clear on
 * session release, explicit cancellation, account change and shutdown. The tool
 * awaits capture, then every service stage revalidates this same session's view.
 * A single active send bounds provider/publication concurrency across sessions.
 */
export class ReviewRequestComposition {
	private readonly entries = new Map<string, Entry>();
	private readonly seen = new Set<string>();
	private readonly ledger: ReviewRequestLedger;
	private pending = 0;
	private sending = false;
	readonly tools: ConversationReviewRequestPorts;
	constructor(
		private readonly ports: ReviewRequestCompositionPorts,
		userData: string
	) {
		this.ledger = new ReviewRequestLedger(join(userData, "review-requests"));
		this.tools = {
			intent: (turn, signal) => this.get(turn, signal),
			send: (intent, names, signal) => this.send(intent, names, signal),
		};
	}
	capture(input: ConversationTurnInput, signal?: AbortSignal): void {
		this.clear(input.sessionId);
		const id = identity(input);
		// Tombstones are never evicted into renewed send authority. Exhaustion fails closed.
		if (this.seen.has(id) || this.seen.size >= 10000) return;
		this.seen.add(id);
		if (!requestedReviewers(input.text) || !target(input.workspace)) return;
		if (this.pending >= 16 || this.entries.size >= 100 || signal?.aborted) return;
		const controller = new AbortController();
		const entry: Entry = {
			turn: structuredClone(input),
			epoch: this.ports.epoch(),
			controller,
			value: Promise.resolve(null),
		};
		this.entries.set(id, entry);
		const cancel = () => this.retire(entry);
		signal?.addEventListener("abort", cancel, { once: true });
		controller.signal.addEventListener(
			"abort",
			() => signal?.removeEventListener("abort", cancel),
			{
				once: true,
			}
		);
		this.pending++;
		entry.value = this.captureIntent(entry)
			.catch(() => null)
			.finally(() => this.pending--);
	}
	cancel(turn: Pick<ConversationTurnInput, "sessionId" | "turnId" | "generation">): void {
		for (const entry of this.entries.values())
			if (
				entry.turn.sessionId === turn.sessionId &&
				entry.turn.turnId === turn.turnId &&
				entry.turn.generation === turn.generation
			)
				this.retire(entry);
	}
	clear(sessionId?: string): void {
		for (const entry of this.entries.values())
			if (sessionId === undefined || entry.turn.sessionId === sessionId) this.retire(entry);
	}
	private retire(entry: Entry) {
		entry.controller.abort();
		if (this.entries.get(identity(entry.turn)) === entry) this.entries.delete(identity(entry.turn));
	}
	private check(entry: Entry, signal: AbortSignal) {
		signal.throwIfAborted();
		if (
			entry.controller.signal.aborted ||
			this.entries.get(identity(entry.turn)) !== entry ||
			this.ports.epoch() !== entry.epoch
		)
			throw new ReviewRequestError("changed");
	}
	private async selected(entry: Entry, signal: AbortSignal) {
		this.check(entry, signal);
		const initial = target(entry.turn.workspace);
		const observed = target(await this.ports.observe(entry.turn.sessionId, signal));
		this.check(entry, signal);
		if (!initial || observed?.stamp !== initial.stamp) throw new ReviewRequestError("changed");
		const review = WorkReviewSchema.parse(await this.ports.review(initial.jobId, signal));
		const after = target(await this.ports.observe(entry.turn.sessionId, signal));
		this.check(entry, signal);
		if (
			after?.stamp !== initial.stamp ||
			review.job.id !== initial.jobId ||
			review.job.state !== "ready"
		)
			throw new ReviewRequestError("changed");
		return review;
	}
	private async account(entry: Entry, signal: AbortSignal) {
		this.check(entry, signal);
		const account = await this.ports.account(signal);
		this.check(entry, signal);
		if (
			entry.intent &&
			(account.accountKey !== entry.intent.accountKey ||
				account.login.toLowerCase() !== entry.intent.actor.toLowerCase())
		)
			throw new ReviewRequestError("changed");
		return account;
	}
	private async captureIntent(entry: Entry) {
		const signal = AbortSignal.any([entry.controller.signal, AbortSignal.timeout(15000)]);
		const { job } = await this.selected(entry, signal);
		const account = await this.account(entry, signal);
		const intent = IntentSchema.parse({
			requestId: entry.turn.requestId,
			text: entry.turn.text,
			jobId: job.id,
			repository: job.repository,
			headSha: job.headSha,
			accountKey: account.accountKey,
			actor: account.login,
		});
		entry.intent = Object.freeze(intent);
		await this.account(entry, signal);
		return entry.intent;
	}
	private async get(turn: ConversationTurnInput, signal?: AbortSignal) {
		const entry = this.entries.get(identity(turn));
		if (!entry || turn.text !== entry.turn.text) return null;
		if (signal?.aborted) {
			this.retire(entry);
			return null;
		}
		const cancel = () => this.retire(entry);
		signal?.addEventListener("abort", cancel, { once: true });
		let intent: ReviewRequestIntent | null;
		try {
			intent = await entry.value;
		} finally {
			signal?.removeEventListener("abort", cancel);
		}
		if (entry.controller.signal.aborted || this.entries.get(identity(turn)) !== entry) return null;
		return intent;
	}
	private async send(intent: ReviewRequestIntent, names: string[], caller: AbortSignal) {
		const entry = [...this.entries.values()].find((candidate) => candidate.intent === intent);
		if (!entry) throw new ReviewRequestError("denied");
		if (this.sending) throw new ReviewRequestError("busy");
		this.sending = true;
		const cancel = () => this.retire(entry);
		caller.addEventListener("abort", cancel, { once: true });
		const signal = AbortSignal.any([caller, entry.controller.signal, AbortSignal.timeout(60000)]);
		try {
			this.check(entry, signal);
			const provider = new GitHubReviewRequestProvider(async (active) => {
				await this.account(entry, active);
				const token = await this.ports.token(active);
				await this.account(entry, active);
				const { job } = await this.selected(entry, active);
				if (job.headSha !== intent.headSha || job.repository !== intent.repository)
					throw new ReviewRequestError("changed");
				if (!token) throw new ReviewRequestError("unavailable");
				return token;
			}, this.ports.transport);
			const service = new ReviewRequests(
				{
					selected: (jobId, active) => {
						if (jobId !== intent.jobId) throw new ReviewRequestError("changed");
						return this.selected(entry, active);
					},
					account: (active) => this.account(entry, active),
					publish: async (jobId) => {
						await this.account(entry, signal);
						const { job } = await this.selected(entry, signal);
						if (job.headSha !== intent.headSha || job.repository !== intent.repository)
							throw new ReviewRequestError("changed");
						this.check(entry, signal);
						return this.ports.publish(jobId);
					},
					provider,
				},
				this.ledger
			);
			return await service.send(intent, names, signal);
		} finally {
			caller.removeEventListener("abort", cancel);
			this.retire(entry);
			this.sending = false;
		}
	}
}
