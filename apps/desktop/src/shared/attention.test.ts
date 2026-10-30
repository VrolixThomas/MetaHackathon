import assert from "node:assert/strict";
import { test } from "node:test";
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
	assert.equal(ConversationAttentionInputSchema.safeParse(input).success, true);
	assert.equal(
		ConversationAttentionInputSchema.safeParse({ ...input, text: "fake user" }).success,
		false
	);
	assert.equal(ConversationTurnInputSchema.safeParse(input).success, false);
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
	assert.equal(AttentionClaimSchema.safeParse(claim).success, true);
	assert.equal(AttentionClaimSchema.safeParse({ ...claim, items: [item, item] }).success, false);
	assert.equal(
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
		}).success,
		true
	);
});
