import { type ApprovalPorts, PRApprovals, policyDigest } from ".";
import {
	type ApprovalPolicy,
	ApprovalPolicySchema,
	type ApprovalTerms,
	HubPersistenceSchema,
} from "../../../shared/contracts";
import type { ApprovalObservation, ApprovalProvider } from "./github";
export const at = Date.parse("2026-11-01T12:00:00Z");
export const actor = { id: 7, login: "reviewer" };
export const head = "b".repeat(40);
export const base = "a".repeat(40);
export const later = "c".repeat(40);
export const connectionId = "d".repeat(64);
export const pr = {
	id: "owner/repo#1",
	repository: "owner/repo",
	number: 1,
	url: "https://github.com/owner/repo/pull/1",
	title: "Real source",
	author: "author",
	baseSha: base,
	headSha: head,
};
export const terms: ApprovalTerms = {
	action: "approve",
	expiresAt: new Date(at + 86400000).toISOString(),
	conditions: [{ kind: "check", name: "regression", appId: 42 }],
};
export function policy(overrides: Partial<ApprovalPolicy> = {}) {
	const p = ApprovalPolicySchema.parse({
		id: "policy",
		connectionId,
		contextDigest: "e".repeat(64),
		revision: 1,
		actor,
		pr,
		reviewId: "review",
		terms,
		createdAt: new Date(at).toISOString(),
		confirmedAt: new Date(at).toISOString(),
		status: "monitoring",
		evaluation: null,
		attempt: null,
		digest: "0".repeat(64),
		...overrides,
	});
	p.digest = policyDigest(p);
	return p;
}
export function observation(overrides: Partial<ApprovalObservation> = {}): ApprovalObservation {
	return {
		actor,
		contextDigest: "e".repeat(64),
		headSha: head,
		baseSha: base,
		open: true,
		permitted: true,
		descendant: true,
		changes: [],
		checks: [
			{
				name: "regression",
				appId: 42,
				passed: true,
				url: "https://github.com/owner/repo/actions/runs/1",
			},
		],
		required: [],
		sources: [],
		...overrides,
	};
}
export function harness(policies: ApprovalPolicy[] = [policy()]) {
	const state = HubPersistenceSchema.parse({
		version: 1,
		repositories: [],
		preferences: {
			linearTeamIds: [],
			linearProjectIds: [],
			maxWorkers: 1,
			autoApplySuggestions: false,
		},
		tickets: [],
		jobs: [],
		notices: [],
		approvalPolicies: policies,
	});
	const control = {
		now: at,
		epoch: 0,
		awake: true,
		connection: connectionId as string | null,
		account: actor,
		observation: observation(),
		writes: 0,
		reads: 0,
	};
	const submitted: { p: ApprovalPolicy; head: string; attempt: string; signal: AbortSignal }[] = [];
	const provider: ApprovalProvider = {
		pin: async () => "e".repeat(64),
		account: async () => control.account,
		observe: async () => {
			control.reads++;
			return structuredClone(control.observation);
		},
		approve: async (p, head, attempt, signal) => {
			submitted.push({ p, head, attempt, signal });
			return { id: 99, url: "https://github.com/owner/repo/pull/1#pullrequestreview-99" };
		},
	};
	const ports: ApprovalPorts = {
		read: async () => structuredClone(state.approvalPolicies ?? []),
		update: async (mutate) => {
			const next = structuredClone(state);
			mutate(next);
			Object.assign(state, HubPersistenceSchema.parse(next));
			control.writes++;
		},
		reviewed: async () => ({ pr, reviewId: "review" }),
		provider,
		epoch: () => control.epoch,
		connection: async () => control.connection,
		awake: () => control.awake,
		now: () => control.now,
	};
	return {
		state,
		control,
		submitted,
		provider,
		ports,
		service: new PRApprovals(ports),
		get p() {
			return state.approvalPolicies?.[0] as ApprovalPolicy;
		},
	};
}
export function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}
