import { createHash, randomUUID } from "node:crypto";
import {
	type AttentionClaim,
	AttentionClaimSchema,
	type AttentionItem,
	type AttentionPresence,
	AttentionPresenceSchema,
	AttentionReleaseInputSchema,
	AttentionSettleInputSchema,
	type ConversationAttentionInput,
	ConversationAttentionInputSchema,
	type HubPersistence,
	type TurnIdentity,
} from "../../shared/contracts";

type State = Pick<HubPersistence, "jobs" | "notices" | "attentionRecords">;
type Candidate = { item: AttentionItem; key: string };
type Presence = { input: AttentionPresence; since: number; received: number };
type Lease = {
	claim: AttentionClaim;
	candidates: Candidate[];
	activity: number;
	turn?: TurnIdentity;
	settling?: boolean;
};
export interface AttentionPorts {
	read(): Promise<State>;
	update(mutator: (state: HubPersistence) => void): Promise<void>;
	isBusy(sessionId: string): boolean;
	completed(turn: TurnIdentity, claimId: string): boolean;
	interrupt?(turn: TurnIdentity): void;
	focused?(): boolean;
	now?(): number;
	id?(): string;
	quietMs?: number;
	cooldownMs?: number;
	retryMs?: number;
	leaseMs?: number;
}
class AttentionChanged extends Error {
	constructor() {
		super("This attention update is no longer current.");
	}
}
const unavailable = () => new AttentionChanged();
const same = (a: TurnIdentity, b: TurnIdentity) =>
	a.sessionId === b.sessionId && a.turnId === b.turnId && a.generation === b.generation;
const eligible = (p: AttentionPresence) =>
	p.enabled && p.state === "idle" && p.focused && !p.obscured;
const timestamp = (value: string) => Date.parse(value);
const fingerprint = (item: AttentionItem) =>
	createHash("sha256").update(JSON.stringify(item)).digest("hex");

/** Deterministic attention policy. It selects actual events; it never invents a user turn or runs tools. */
export class AttentionScheduler {
	private readonly now: () => number;
	private readonly id: () => string;
	private readonly quietMs: number;
	private readonly cooldownMs: number;
	private readonly retryMs: number;
	private readonly leaseMs: number;
	private presence = new Map<string, Presence>();
	private lease: Lease | null = null;
	private activity = 0;
	private lastActivity = Number.NEGATIVE_INFINITY;
	private queue: Promise<unknown> = Promise.resolve();
	private disposed = false;
	constructor(private readonly ports: AttentionPorts) {
		this.now = ports.now ?? Date.now;
		this.id = ports.id ?? randomUUID;
		this.quietMs = ports.quietMs ?? 2500;
		this.cooldownMs = ports.cooldownMs ?? 20_000;
		this.retryMs = ports.retryMs ?? 60_000;
		this.leaseMs = ports.leaseMs ?? 180_000;
	}
	private serial<T>(work: () => Promise<T>): Promise<T> {
		const job = this.queue.catch(() => {}).then(work);
		this.queue = job;
		return job;
	}
	/** Actual native user input bypasses any pending model, state-write or page-operation queue. */
	noteActivity() {
		this.activity++;
		this.lastActivity = this.now();
		this.invalidate();
	}
	private delivered(lease: Lease) {
		return !!lease.turn && this.ports.completed(lease.turn, lease.claim.id);
	}
	private invalidate(force = false) {
		const lease = this.lease;
		if (lease && !force && this.delivered(lease)) return;
		this.lease = null;
		if (lease?.turn) this.ports.interrupt?.(lease.turn);
	}
	private currentLease(id: string, sessionId: string) {
		const lease = this.lease;
		if (
			this.disposed ||
			!lease ||
			lease.claim.id !== id ||
			lease.claim.sessionId !== sessionId ||
			(!this.delivered(lease) &&
				(timestamp(lease.claim.expiresAt) <= this.now() ||
					lease.activity !== this.activity ||
					this.ports.focused?.() === false))
		)
			throw unavailable();
		return lease;
	}
	private candidates(state: State): Candidate[] {
		const jobs = new Map(state.jobs.map((job) => [job.id, job]));
		const used = new Set<string>();
		const candidates: Candidate[] = [];
		// A newer event replaces an older event for that job. Decision/failed/ready priority follows below.
		for (const notice of [...state.notices].sort(
			(a, b) => timestamp(b.createdAt) - timestamp(a.createdAt)
		)) {
			if (!notice.jobId || used.has(notice.jobId) || notice.seenAt || notice.announcedAt) continue;
			const job = jobs.get(notice.jobId);
			if (!job || (notice.headSha !== undefined && notice.headSha !== job.headSha)) continue;
			const decision =
				notice.kind === "decision"
					? job.decisions.find(
							(d) => d.answer === null && (!notice.decisionId || notice.decisionId === d.id)
						)
					: undefined;
			if (
				!(
					(notice.kind === "decision" && job.state === "needs-input" && decision) ||
					(notice.kind === "work-failed" && job.state === "failed") ||
					(notice.kind === "work-ready" && job.state === "ready" && !job.reviewedAt)
				)
			)
				continue;
			const label = job.ticket
				? `${job.ticket.identifier}: ${job.ticket.title}`
				: job.pullRequest
					? `${job.repository} PR #${job.pullRequest.number}`
					: job.repository;
			const item: AttentionItem = {
				noticeId: notice.id,
				kind: notice.kind as AttentionItem["kind"],
				jobId: job.id,
				repository: job.repository,
				label: label.slice(0, 300),
				headSha: job.headSha,
				decisionId: decision?.id ?? null,
				question: decision?.question.slice(0, 2000) ?? null,
				changedFileCount: job.changedFiles.length,
				applied: !!job.feedbackAppliedAt,
			};
			used.add(job.id);
			candidates.push({ item, key: fingerprint(item) });
		}
		const priority = { decision: 0, "work-failed": 1, "work-ready": 2 };
		return candidates.sort((a, b) => priority[a.item.kind] - priority[b.item.kind]);
	}
	private fresh(lease: Lease, state: State) {
		const actual = new Set(this.candidates(state).map((item) => item.key));
		return lease.candidates.every((candidate) => actual.has(candidate.key));
	}
	private idle(sessionId: string) {
		const presence = this.presence.get(sessionId);
		return (
			!!presence &&
			eligible(presence.input) &&
			this.now() - presence.since >= this.quietMs &&
			this.now() - this.lastActivity >= this.quietMs &&
			this.now() - presence.received < 5000 &&
			!this.ports.isBusy(sessionId) &&
			this.ports.focused?.() !== false
		);
	}
	poll(raw: unknown): Promise<{ claim: AttentionClaim | null }> {
		const input = AttentionPresenceSchema.parse(raw);
		const prior = this.presence.get(input.sessionId);
		const now = this.now();
		if (this.presence.size > 100 && !prior)
			this.presence.delete(this.presence.keys().next().value ?? "");
		this.presence.set(input.sessionId, {
			input,
			received: now,
			since:
				prior &&
				now - prior.received < 5000 &&
				eligible(prior.input) &&
				eligible(input) &&
				prior.input.activitySequence === input.activitySequence
					? prior.since
					: now,
		});
		if (
			this.lease?.claim.sessionId === input.sessionId &&
			(!input.enabled ||
				!input.focused ||
				input.obscured ||
				input.state === "user-speaking" ||
				input.state === "interacting" ||
				prior?.input.activitySequence !== input.activitySequence)
		)
			this.invalidate();
		return this.serial(async () => {
			if (this.disposed) return { claim: null };
			if (this.lease && this.delivered(this.lease)) await this.finishDelivery(this.lease);
			if (this.lease && timestamp(this.lease.claim.expiresAt) <= this.now()) this.invalidate();
			if (this.lease || !this.idle(input.sessionId)) return { claim: null };
			const activity = this.activity;
			const state = await this.ports.read();
			const records = state.attentionRecords ?? [];
			const lastDelivery = Math.max(
				Number.NEGATIVE_INFINITY,
				...records.filter((r) => r.deliveredAt).map((r) => timestamp(r.deliveredAt as string))
			);
			if (this.now() - lastDelivery < this.cooldownMs) return { claim: null };
			const chosen = this.candidates(state)
				.filter(({ key }) => {
					const record = records.find((r) => r.key === key);
					return (
						!record ||
						(!record.deliveredAt &&
							record.attempts < 3 &&
							this.now() - timestamp(record.lastAttemptAt) >= this.retryMs)
					);
				})
				.slice(0, 1);
			if (!chosen.length || activity !== this.activity || !this.idle(input.sessionId))
				return { claim: null };
			const createdAt = new Date(this.now()).toISOString();
			const claim = AttentionClaimSchema.parse({
				id: this.id(),
				sessionId: input.sessionId,
				items: chosen.map((c) => c.item),
				createdAt,
				expiresAt: new Date(this.now() + this.leaseMs).toISOString(),
			});
			await this.ports.update((current) => {
				if (
					activity !== this.activity ||
					!this.idle(input.sessionId) ||
					!this.fresh({ claim, candidates: chosen, activity }, current)
				)
					throw unavailable();
				current.attentionRecords ??= [];
				const ledger = current.attentionRecords;
				for (const candidate of chosen) {
					const old = ledger.find((r) => r.key === candidate.key);
					if (
						old &&
						(old.deliveredAt ||
							old.attempts >= 3 ||
							this.now() - timestamp(old.lastAttemptAt) < this.retryMs)
					)
						throw unavailable();
					if (old) {
						old.attempts++;
						old.lastAttemptAt = createdAt;
					} else
						ledger.push({
							key: candidate.key,
							noticeIds: [candidate.item.noticeId],
							attempts: 1,
							lastAttemptAt: createdAt,
							deliveredAt: null,
						});
				}
				current.attentionRecords = ledger.slice(-500);
			});
			if (activity !== this.activity || !this.idle(input.sessionId)) return { claim: null };
			this.lease = { claim, candidates: chosen, activity };
			return { claim: structuredClone(claim) };
		});
	}
	async resolve(raw: ConversationAttentionInput, signal: AbortSignal): Promise<AttentionClaim> {
		const input = ConversationAttentionInputSchema.parse(raw);
		signal.throwIfAborted();
		const lease = this.currentLease(input.claimId, input.sessionId);
		if (lease.turn && !same(lease.turn, input)) throw unavailable();
		const state = await this.ports.read();
		signal.throwIfAborted();
		if (this.currentLease(input.claimId, input.sessionId) !== lease || !this.fresh(lease, state))
			throw unavailable();
		lease.turn = { sessionId: input.sessionId, turnId: input.turnId, generation: input.generation };
		return structuredClone(lease.claim);
	}
	async validate(input: ConversationAttentionInput, signal: AbortSignal) {
		signal.throwIfAborted();
		const lease = this.currentLease(input.claimId, input.sessionId);
		if (!lease.turn || !same(lease.turn, input) || !this.fresh(lease, await this.ports.read()))
			throw unavailable();
		signal.throwIfAborted();
		if (this.lease !== lease) throw unavailable();
	}
	/** Hub changes revalidate active content; no model runs just because a source refreshes. */
	async changed() {
		const lease = this.lease;
		if (!lease || lease.settling) return;
		const state = await this.ports.read();
		if (this.lease === lease && !this.fresh(lease, state)) this.invalidate();
	}
	private async finishDelivery(lease: Lease): Promise<{ status: "accepted" | "stale" }> {
		lease.settling = true;
		try {
			await this.ports.update((state) => {
				if (this.lease !== lease || this.disposed || !this.fresh(lease, state)) throw unavailable();
				for (const candidate of lease.candidates) {
					const record = state.attentionRecords?.find((r) => r.key === candidate.key);
					if (!record) throw unavailable();
					record.deliveredAt = new Date(this.now()).toISOString();
					const notice = state.notices.find((n) => n.id === candidate.item.noticeId);
					if (notice) notice.announcedAt = record.deliveredAt;
				}
			});
			if (this.lease === lease) this.lease = null;
			return { status: "accepted" };
		} catch (error) {
			if (!(error instanceof AttentionChanged)) throw error;
			if (this.lease === lease) this.lease = null;
			return { status: "stale" };
		} finally {
			lease.settling = false;
		}
	}
	settle(raw: unknown): Promise<{ status: "accepted" | "stale" }> {
		const input = AttentionSettleInputSchema.parse(raw);
		return this.serial(async () => {
			let lease: Lease;
			try {
				lease = this.currentLease(input.claimId, input.sessionId);
			} catch {
				return { status: "stale" };
			}
			if (!lease.turn || !same(lease.turn, input)) return { status: "stale" };
			if (this.delivered(lease)) return this.finishDelivery(lease);
			if (input.status !== "spoken") {
				this.invalidate();
				return { status: "accepted" };
			}
			return { status: "stale" };
		});
	}
	release(raw: unknown) {
		const input = AttentionReleaseInputSchema.parse(raw);
		if (this.lease?.claim.id !== input.claimId || this.lease.claim.sessionId !== input.sessionId)
			return { status: "stale" as const };
		this.invalidate();
		return { status: "accepted" as const };
	}
	dispose() {
		return this.serial(async () => {
			try {
				if (this.lease && this.delivered(this.lease)) await this.finishDelivery(this.lease);
			} finally {
				this.disposed = true;
				this.invalidate(true);
				this.presence.clear();
			}
		});
	}
}
