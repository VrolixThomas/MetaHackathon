import { expect, test } from "bun:test";
import {
	AttentionClaimSchema,
	ConversationAttentionInputSchema,
	ConversationTurnInputSchema,
	HubPersistenceSchema,
} from "./contracts";

test("assistant initiative carries a claim and cannot masquerade as a user utterance", () => {
	const input = {
		sessionId: "session",
		turnId: "turn",
		generation: 1,
		requestId: "request",
		claimId: "claim",
	};
	expect(ConversationAttentionInputSchema.safeParse(input).success).toBe(true);
	expect(ConversationAttentionInputSchema.safeParse({ ...input, text: "fake user" }).success).toBe(
		false
	);
	expect(ConversationTurnInputSchema.safeParse(input).success).toBe(false);
});
test("delivery claims have bounded unique job identity and old hub snapshots remain readable", () => {
	const item = {
		noticeId: "notice",
		kind: "work-ready",
		jobId: "job",
		repository: "owner/repo",
		label: "MET-50",
		headSha: "a".repeat(40),
		decisionId: null,
		question: null,
		changedFileCount: 1,
		applied: false,
	};
	const claim = {
		id: "claim",
		sessionId: "session",
		items: [item],
		createdAt: "2026-10-30T15:00:00Z",
		expiresAt: "2026-10-30T15:02:00Z",
	};
	expect(AttentionClaimSchema.safeParse(claim).success).toBe(true);
	expect(AttentionClaimSchema.safeParse({ ...claim, items: [item, item] }).success).toBe(false);
	expect(
		HubPersistenceSchema.safeParse({
			version: 1,
			repositories: [],
			tickets: [],
			jobs: [],
			notices: [],
			preferences: {
				linearTeamIds: [],
				linearProjectIds: [],
				maxWorkers: 2,
				autoApplySuggestions: true,
			},
		}).success
	).toBe(true);
});
