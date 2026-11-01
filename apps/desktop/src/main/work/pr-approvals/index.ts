import { createHash, randomUUID } from "node:crypto";
import {
	type ApprovalConfirmInput,
	ApprovalConfirmInputSchema,
	type ApprovalDraftInput,
	ApprovalDraftInputSchema,
	ApprovalIdentitySchema,
	type ApprovalPolicy,
	ApprovalPolicySchema,
	type HubPersistence,
	type PullRequest,
} from "../../../shared/contracts";
import type { ApprovalObservation, ApprovalProvider } from "./github";

export const policyDigest = (
	p: Pick<
		ApprovalPolicy,
		"id" | "connectionId" | "revision" | "actor" | "pr" | "reviewId" | "contextDigest" | "terms"
	>
) =>
	createHash("sha256")
		.update(
			JSON.stringify([
				p.id,
				p.connectionId,
				p.revision,
				p.actor,
				p.pr,
				p.reviewId,
				p.contextDigest,
				p.terms,
			])
		)
		.digest("hex");
export function evaluatePolicy(
	p: ApprovalPolicy,
	o: ApprovalObservation,
	now: number
): NonNullable<ApprovalPolicy["evaluation"]> {
	const evidence: NonNullable<ApprovalPolicy["evaluation"]>["evidence"] = [];
	const result = (outcome: "waiting" | "satisfied" | "needs-review", explanation: string) => ({
		at: new Date(now).toISOString(),
		headSha: o.headSha,
		outcome,
		explanation,
		evidence,
	});
	if (
		o.contextDigest !== p.contextDigest ||
		o.actor.id !== p.actor.id ||
		o.baseSha !== p.pr.baseSha ||
		!o.open ||
		!o.permitted ||
		!o.descendant
	)
		return result(
			"needs-review",
			"The account, PR scope, base, availability, permission or commit ancestry changed. Review and confirm a new policy."
		);
	if (o.scopeError) return result("needs-review", o.scopeError);
	const sources = p.terms.conditions.filter((c) => c.kind === "source");
	if (o.headSha !== p.pr.headSha && !sources.length)
		return result(
			"needs-review",
			"This check-only delegation covers the inspected head. Review the new head before renewing consent."
		);
	if (
		o.changes.some(
			(c) => !["modified", "added"].includes(c.status) || !sources.some((s) => s.path === c.path)
		)
	)
		return result(
			"needs-review",
			"Changes outside the exact authorized source files require renewed review."
		);
	let judgment = false;
	for (const c of p.terms.conditions) {
		if (c.kind === "judgment") {
			judgment = true;
			evidence.push({
				condition: c.description,
				kind: "inference",
				satisfied: false,
				detail: "This requires human judgment. No execution or automatic approval is inferred.",
				url: null,
			});
		} else if (c.kind === "source") {
			const actual = o.sources.find((s) => s.path === c.path);
			const satisfied = !!actual && actual.content === c.expectedContent;
			evidence.push({
				condition: c.path,
				kind: "source",
				satisfied,
				detail: `${c.reason}\nComplete source ${satisfied ? "matches" : "does not match"} the authorized bytes at ${o.headSha}.`,
				url: null,
			});
			if (!satisfied && o.changes.some((f) => f.path === c.path))
				return result(
					"needs-review",
					"A changed file does not match the exact authorized replacement. Review its new scope."
				);
		}
	}
	const required = [
		...new Map(
			[...o.required, ...p.terms.conditions.filter((c) => c.kind === "check")].map((c) => [
				JSON.stringify([c.name, c.appId]),
				c,
			])
		).values(),
	];
	for (const c of required) {
		const matches = o.checks.filter(
			(r) => r.name === c.name && (c.appId === null || c.appId === r.appId)
		);
		const satisfied = matches.length === 1 && matches[0]?.passed === true;
		evidence.push({
			condition: c.name,
			kind: "github-check",
			satisfied,
			detail: satisfied
				? `GitHub reports success for the evaluated head ${o.headSha}.`
				: "Required execution evidence is missing, ambiguous, pending or unsuccessful.",
			url: matches[0]?.url ?? null,
			providerId: matches[0]?.id ?? null,
		});
	}
	if (o.checks.some((c) => !c.passed))
		evidence.push({
			condition: "All observed checks",
			kind: "github-check",
			satisfied: false,
			detail: "A current check or status is pending or unsuccessful.",
			url: null,
		});
	if (judgment)
		return result(
			"needs-review",
			"A requested condition needs your judgment; automatic approval is blocked."
		);
	if (evidence.some((e) => !e.satisfied))
		return result(
			"waiting",
			"Waiting for every authorized source condition and required check to pass."
		);
	return result(
		"satisfied",
		"Every authorized condition holds with fresh source and GitHub check evidence."
	);
}
export interface ApprovalPorts {
	read(): Promise<ApprovalPolicy[]>;
	update(mutator: (state: HubPersistence) => void): Promise<void>;
	reviewed(sessionId: string, signal: AbortSignal): Promise<{ pr: PullRequest; reviewId: string }>;
	provider: ApprovalProvider;
	epoch(): number;
	connection(): Promise<string | null>;
	awake(): boolean;
	now?(): number;
}
const active = (p: ApprovalPolicy) => ["monitoring", "offline", "paused"].includes(p.status);
/** A monitor owns its cancellation separately from foreground voice/typing. Revocation bypasses network work. */
export class PRApprovals {
	private readonly pending = new Set<Promise<void>>();
	private readonly revoked = new Set<string>();
	private readonly editing = new Set<string>();
	private readonly running = new Map<string, AbortController>();
	private timer?: ReturnType<typeof setTimeout>;
	private stopped = false;
	private readonly now: () => number;
	constructor(private readonly ports: ApprovalPorts) {
		this.now = ports.now ?? Date.now;
	}
	private async actor(signal = AbortSignal.timeout(30000)) {
		return this.ports.provider.account(signal);
	}
	async list() {
		const epoch = this.ports.epoch();
		const connectionId = await this.ports.connection();
		const rows = await this.ports.read();
		if (epoch !== this.ports.epoch()) throw new Error("GitHub account changed");
		return rows.filter((p) => p.connectionId === connectionId);
	}
	async beginEdit(raw: unknown) {
		const input = ApprovalIdentitySchema.parse(raw);
		const key = `${input.id}:${input.revision}`;
		this.editing.add(key);
		this.running.get(input.id)?.abort();
		try {
			const epoch = this.ports.epoch();
			const connectionId = await this.ports.connection();
			await this.ports.update((state) => {
				const p = state.approvalPolicies?.find((p) => p.id === input.id);
				if (
					this.stopped ||
					epoch !== this.ports.epoch() ||
					!p ||
					p.connectionId !== connectionId ||
					p.revision !== input.revision ||
					p.attempt ||
					p.status === "revoked"
				)
					throw new Error("Policy changed; inspect it before editing");
				p.status = "needs-review";
				p.evaluation = {
					at: new Date(this.now()).toISOString(),
					headSha: p.evaluation?.headSha ?? p.pr.headSha,
					outcome: "needs-review",
					explanation:
						"Editing paused this delegation. Review and confirm the revised policy before monitoring resumes.",
					evidence: [],
				};
				for (const n of state.notices)
					if (n.kind === "pr-approval" && n.jobId === p.id)
						n.seenAt = new Date(this.now()).toISOString();
			});
		} finally {
			this.editing.delete(key);
		}
	}
	async draft(raw: ApprovalDraftInput) {
		const input = ApprovalDraftInputSchema.parse(raw);
		if (input.id) await this.beginEdit({ id: input.id, revision: input.revision });
		const signal = AbortSignal.timeout(60000);
		const epoch = this.ports.epoch();
		const actor = await this.actor(signal);
		const connectionId = await this.ports.connection();
		if (!connectionId) throw new Error("GitHub connection required");
		const reviewed = await this.ports.reviewed(input.sessionId, signal);
		const contextDigest = await this.ports.provider.pin(reviewed.pr, signal);
		const now = this.now();
		if (
			Date.parse(input.terms.expiresAt) <= now ||
			Date.parse(input.terms.expiresAt) > now + 30 * 86400000
		)
			throw new Error("Choose an expiry within the next 30 days");
		let result!: ApprovalPolicy;
		if (input.id) this.running.get(input.id)?.abort();
		await this.ports.update((state) => {
			if (epoch !== this.ports.epoch() || this.stopped) throw new Error("GitHub account changed");
			state.approvalPolicies ??= [];
			const old = state.approvalPolicies.find((p) => p.id === input.id);
			if (
				input.id &&
				(!old ||
					old.actor.id !== actor.id ||
					old.connectionId !== connectionId ||
					old.revision !== input.revision ||
					old.attempt ||
					old.status === "revoked")
			)
				throw new Error("Policy changed or already attempted; inspect it again");
			if (old && old.pr.id !== reviewed.pr.id)
				throw new Error("Open the policy's actual PR before editing");
			if (
				!old &&
				state.approvalPolicies.some(
					(p) =>
						p.actor.id === actor.id &&
						p.pr.id === reviewed.pr.id &&
						!["revoked", "expired", "approved", "notified"].includes(p.status)
				)
			)
				throw new Error("Inspect or revoke the existing delegation for this PR first");
			const value = {
				id: old?.id ?? randomUUID(),
				connectionId,
				contextDigest,
				revision: (old?.revision ?? 0) + 1,
				actor,
				...reviewed,
				terms: input.terms,
			};
			result = ApprovalPolicySchema.parse({
				...value,
				digest: policyDigest(value),
				createdAt: old?.createdAt ?? new Date(now).toISOString(),
				confirmedAt: null,
				status: "draft",
				evaluation: null,
				attempt: null,
			});
			if (old) state.approvalPolicies[state.approvalPolicies.indexOf(old)] = result;
			else state.approvalPolicies.push(result);
			for (const n of state.notices)
				if (n.kind === "pr-approval" && n.jobId === result.id)
					n.seenAt = new Date(now).toISOString();
		});
		return result;
	}
	async assertReviewed(sessionId: string, policy: ApprovalPolicy, signal: AbortSignal) {
		const reviewed = await this.ports.reviewed(sessionId, signal);
		signal.throwIfAborted();
		if (
			reviewed.pr.id !== policy.pr.id ||
			reviewed.pr.headSha !== policy.pr.headSha ||
			reviewed.pr.baseSha !== policy.pr.baseSha ||
			reviewed.reviewId !== policy.reviewId
		)
			throw new Error(
				"The displayed review changed. Present and confirm a fresh delegation for the intended PR."
			);
	}
	async confirm(raw: ApprovalConfirmInput) {
		const input = ApprovalConfirmInputSchema.parse(raw);
		const epoch = this.ports.epoch();
		const actor = await this.actor();
		const connectionId = await this.ports.connection();
		let result!: ApprovalPolicy;
		await this.ports.update((state) => {
			const p = state.approvalPolicies?.find((p) => p.id === input.id);
			if (
				this.stopped ||
				!p ||
				this.revoked.has(`${p.id}:${p.revision}`) ||
				this.editing.has(`${p.id}:${p.revision}`) ||
				epoch !== this.ports.epoch() ||
				p.actor.id !== actor.id ||
				p.connectionId !== connectionId ||
				p.revision !== input.revision ||
				p.digest !== input.digest ||
				policyDigest(p) !== input.digest ||
				Date.parse(p.terms.expiresAt) <= this.now()
			)
				throw new Error("Stale policy confirmation");
			if (p.status !== "draft") {
				if (p.confirmedAt && active(p)) {
					result = structuredClone(p);
					return;
				}
				throw new Error("Policy cannot be confirmed");
			}
			p.confirmedAt = new Date(this.now()).toISOString();
			p.status = "monitoring";
			result = structuredClone(p);
		});
		void this.tick().catch(() => {});
		return result;
	}
	async revoke(raw: unknown) {
		const input = ApprovalIdentitySchema.parse(raw);
		this.revoked.add(`${input.id}:${input.revision}`);
		this.running.get(input.id)?.abort();
		const epoch = this.ports.epoch();
		const connectionId = await this.ports.connection();
		await this.ports.update((state) => {
			const p = state.approvalPolicies?.find((p) => p.id === input.id);
			if (
				epoch !== this.ports.epoch() ||
				!p ||
				p.connectionId !== connectionId ||
				p.revision !== input.revision
			)
				throw new Error("Stale policy revocation");
			p.status = "revoked";
			for (const n of state.notices)
				if (n.kind === "pr-approval" && n.jobId === p.id)
					n.seenAt = new Date(this.now()).toISOString();
		});
	}
	/** Called synchronously on account, sleep and shutdown boundaries. Abort before queued persistence. */
	fence() {
		for (const c of this.running.values()) c.abort();
	}
	async accountChanged() {
		this.fence();
		await this.ports.update((state) => {
			for (const p of state.approvalPolicies ?? [])
				if (p.status === "submitting") p.status = "uncertain";
				else if (active(p)) {
					p.status = "needs-review";
					p.evaluation = {
						at: new Date(this.now()).toISOString(),
						headSha: p.pr.headSha,
						outcome: "needs-review",
						explanation:
							"The GitHub connection changed. Review and explicitly reconfirm a new policy.",
						evidence: [],
					};
				}
			state.notices = state.notices.filter((n) => n.kind !== "pr-approval");
		});
	}
	async restore() {
		const connectionId = await this.ports.connection().catch(() => null);
		await this.ports.update((state) => {
			const allowed = new Set(
				(state.approvalPolicies ?? [])
					.filter((p) => p.connectionId === connectionId)
					.map((p) => p.id)
			);
			state.notices = state.notices.filter(
				(n) => n.kind !== "pr-approval" || (n.jobId !== null && allowed.has(n.jobId))
			);
			for (const p of state.approvalPolicies ?? []) {
				if (p.status === "submitting") p.status = "uncertain";
				if (p.status === "uncertain" && p.connectionId === connectionId)
					this.notice(
						state,
						p,
						"The approval outcome is uncertain. Inspect GitHub before taking any further action; no automatic retry will occur."
					);
			}
		});
		this.start();
	}
	private start() {
		if (this.stopped || this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.tick()
				.catch(() => {})
				.finally(() => this.start());
		}, 30000);
		this.timer.unref?.();
	}
	private notice(state: HubPersistence, p: ApprovalPolicy, detail: string) {
		const id = `pr-approval-${p.id}-${p.revision}-${p.status}`;
		if (state.notices.some((n) => n.id === id)) return;
		state.notices.push({
			id,
			kind: "pr-approval",
			title: `PR approval: ${p.pr.repository} #${p.pr.number}`,
			detail,
			jobId: p.id,
			prId: p.pr.id,
			headSha: p.evaluation?.headSha ?? p.pr.headSha,
			createdAt: new Date(this.now()).toISOString(),
			announcedAt: null,
			seenAt: null,
		});
	}
	async tick() {
		if (this.stopped) return;
		const rows = await this.ports.read();
		let connectionId: string | null;
		try {
			connectionId = await this.ports.connection();
		} catch {
			await this.ports.update((s) => {
				for (const p of s.approvalPolicies ?? [])
					if (active(p)) p.status = this.ports.awake() ? "offline" : "paused";
			});
			return;
		}
		for (const p of rows) {
			if (this.stopped) return;
			if (p.connectionId !== connectionId) {
				await this.ports.update((s) => {
					const live = s.approvalPolicies?.find((r) => r.id === p.id);
					if (live && active(live)) live.status = "needs-review";
					s.notices = s.notices.filter((n) => n.kind !== "pr-approval" || n.jobId !== p.id);
				});
				continue;
			}
			if (
				Date.parse(p.terms.expiresAt) <= this.now() &&
				["draft", "needs-review", "monitoring", "offline", "paused"].includes(p.status)
			) {
				await this.ports.update((s) => {
					const live = s.approvalPolicies?.find((r) => r.id === p.id);
					if (
						live &&
						live.revision === p.revision &&
						["draft", "needs-review", "monitoring", "offline", "paused"].includes(live.status)
					) {
						live.status = "expired";
						if (live.confirmedAt)
							this.notice(s, live, "The delegation expired without approving the PR.");
					}
				});
				continue;
			}
			if (
				!active(p) ||
				this.running.has(p.id) ||
				this.revoked.has(`${p.id}:${p.revision}`) ||
				this.editing.has(`${p.id}:${p.revision}`)
			)
				continue;
			if (!this.ports.awake()) {
				await this.ports.update((s) => {
					const live = s.approvalPolicies?.find((r) => r.id === p.id);
					if (live && live.revision === p.revision && active(live)) live.status = "paused";
				});
				continue;
			}
			const job = this.evaluate(p);
			this.pending.add(job);
			try {
				await job;
			} finally {
				this.pending.delete(job);
			}
		}
	}
	private async evaluate(p: ApprovalPolicy) {
		const controller = new AbortController();
		this.running.set(p.id, controller);
		const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]);
		const epoch = this.ports.epoch();
		const current = (state: HubPersistence, attempt = false) => {
			signal.throwIfAborted();
			const live = state.approvalPolicies?.find((r) => r.id === p.id);
			if (
				this.stopped ||
				this.revoked.has(`${p.id}:${p.revision}`) ||
				this.editing.has(`${p.id}:${p.revision}`) ||
				epoch !== this.ports.epoch() ||
				!this.ports.awake() ||
				!live ||
				live.revision !== p.revision ||
				live.digest !== p.digest ||
				!(attempt ? live.status === "submitting" : active(live)) ||
				!live.confirmedAt ||
				policyDigest(live) !== live.digest ||
				Date.parse(live.terms.expiresAt) <= this.now()
			)
				throw new Error("Policy evaluation retired");
			return live;
		};
		try {
			const observation = await this.ports.provider.observe(p, signal);
			const evaluation = evaluatePolicy(p, observation, this.now());
			let shouldApprove = false;
			await this.ports.update((state) => {
				const live = current(state);
				live.evaluation = evaluation;
				if (evaluation.outcome === "needs-review") {
					live.status = "needs-review";
					this.notice(state, live, evaluation.explanation);
				} else if (evaluation.outcome === "waiting") live.status = "monitoring";
				else if (live.terms.action === "notify") {
					live.status = "notified";
					this.notice(
						state,
						live,
						"The authorized conditions hold. Notification only: no GitHub approval was submitted."
					);
				} else shouldApprove = true;
			});
			if (!shouldApprove) return;
			// Independently refresh all evidence immediately before reserving the single write.
			const fresh = await this.ports.provider.observe(p, signal);
			const final = evaluatePolicy(p, fresh, this.now());
			if (fresh.headSha !== observation.headSha || final.outcome !== "satisfied") {
				await this.ports.update((state) => {
					const live = current(state);
					live.evaluation = final;
					live.status = final.outcome === "needs-review" ? "needs-review" : "monitoring";
					if (live.status === "needs-review") this.notice(state, live, final.explanation);
				});
				return;
			}
			const attempt = {
				id: randomUUID(),
				headSha: fresh.headSha,
				startedAt: new Date(this.now()).toISOString(),
				receipt: null,
			};
			await this.ports.update((state) => {
				const live = current(state);
				if (live.attempt) throw new Error("An approval was already attempted");
				live.evaluation = final;
				live.status = "submitting";
				live.attempt = attempt;
			});
			// A revoke/account change racing durable admission must fence the provider dispatch.
			await this.ports.update((state) => {
				current(state, true);
			});
			const receipt = await this.ports.provider.approve(p, fresh.headSha, attempt.id, signal);
			await this.ports.update((state) => {
				const live = state.approvalPolicies?.find((r) => r.id === p.id);
				if (!live || live.attempt?.id !== attempt.id) throw new Error("Approval attempt changed");
				live.attempt.receipt = receipt;
				if (live.status === "submitting" && epoch === this.ports.epoch()) {
					live.status = "approved";
					this.notice(
						state,
						live,
						`GitHub approval submitted for ${fresh.headSha}. This does not merge or publish work or complete Linear.`
					);
				}
			});
		} catch {
			await this.ports.update((state) => {
				const live = state.approvalPolicies?.find((r) => r.id === p.id);
				if (!live || live.revision !== p.revision || live.status === "revoked") return;
				if (live.attempt && live.status === "submitting") {
					live.status = "uncertain";
					this.notice(
						state,
						live,
						"GitHub approval may have been submitted. Inspect the provider; this attempt will not be retried automatically."
					);
				} else if (active(live)) live.status = !this.ports.awake() ? "paused" : "offline";
			});
		} finally {
			if (this.running.get(p.id) === controller) this.running.delete(p.id);
		}
	}
	async dispose() {
		this.stopped = true;
		clearTimeout(this.timer);
		this.fence();
		await Promise.allSettled([...this.pending]);
	}
}
