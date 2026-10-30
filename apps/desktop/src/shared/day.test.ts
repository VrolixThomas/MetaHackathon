import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ChatCitationSchema,
	ChatMessageSchema,
	DaySnapshotSchema,
	DayWorkItemSchema,
	KnowledgeFactSchema,
} from "./contracts";

const at = "2026-10-31T00:00:00Z";
function citation() {
	return {
		source: {
			provider: "slack" as const,
			workspaceId: "workspace",
			conversationId: "channel",
			messageId: "100.000001",
			threadId: null,
			revisionId: "100.000001",
			permalink: null,
		},
		audience: {
			workspaceId: "workspace",
			conversationId: "channel",
			visibility: "direct_message" as const,
			readerIds: ["owner", "requester"],
			membershipRevision: "membership-1",
			observedAt: at,
		},
	};
}
function item() {
	return {
		id: "item",
		revision: 1,
		workspaceId: "workspace",
		ownerUserId: "owner",
		requestedById: "requester",
		kind: "request" as const,
		title: "A real request will be captured by its connector",
		summary: "Test-only contract record",
		source: citation(),
		acceptance: "pending" as const,
		acceptanceBasis: "none" as const,
		acceptedAt: null,
		phase: "preparing" as const,
		priority: { rank: 50, reason: "Inferred urgency", provenance: "inferred" as const },
		questions: [],
		jobId: null,
		repositoryId: null,
		linearIssueId: null,
		nextCheckAt: at,
		reviewedAt: null,
		reviewedHeadSha: null,
		replyDraft: null,
		answerReceipt: null,
		createdAt: at,
		updatedAt: at,
	};
}

test("chat citations bind audience to exact workspace/conversation and deletion removes readable text", () => {
	const ref = citation();
	assert.equal(ChatCitationSchema.safeParse(ref).success, true);
	assert.equal(
		ChatCitationSchema.safeParse({ ...ref, audience: { ...ref.audience, workspaceId: "other" } })
			.success,
		false
	);
	const message = {
		citation: ref,
		authorId: "requester",
		text: "source",
		createdAt: at,
		updatedAt: at,
		deletedAt: null,
		truncated: false,
	};
	assert.equal(ChatMessageSchema.safeParse(message).success, true);
	assert.equal(ChatMessageSchema.safeParse({ ...message, deletedAt: at }).success, false);
	assert.equal(ChatMessageSchema.safeParse({ ...message, deletedAt: at, text: "" }).success, true);
});

test("pending ownership permits preparation but fences execution and unsupported closure", () => {
	const row = item();
	assert.equal(DayWorkItemSchema.safeParse(row).success, true);
	assert.equal(DayWorkItemSchema.safeParse({ ...row, phase: "working" }).success, false);
	const accepted = {
		...row,
		acceptance: "accepted",
		acceptanceBasis: "user_action",
		acceptedAt: at,
	};
	assert.equal(DayWorkItemSchema.safeParse({ ...accepted, phase: "working" }).success, true);
	assert.equal(DayWorkItemSchema.safeParse({ ...accepted, phase: "closed" }).success, false);
	const receipt = {
		requestId: "send",
		source: {
			...row.source.source,
			messageId: "101.000001",
			threadId: "100.000001",
			revisionId: "101.000001",
		},
		bodyDigest: "a".repeat(64),
		deliveredAt: at,
	};
	assert.equal(
		DayWorkItemSchema.safeParse({ ...accepted, phase: "closed", answerReceipt: receipt }).success,
		true
	);
	assert.equal(
		DayWorkItemSchema.safeParse({
			...accepted,
			phase: "closed",
			answerReceipt: { ...receipt, source: { ...receipt.source, threadId: "other-thread" } },
		}).success,
		false
	);
});

test("private work snapshots reject another reviewer and knowledge cannot promote private sources", () => {
	const row = item();
	const snapshot = {
		sequence: 0,
		actor: { workspaceId: "workspace", userId: "owner" },
		items: [row],
		currentItemId: null,
		supervisor: "running",
		errors: [],
	};
	assert.equal(DaySnapshotSchema.safeParse(snapshot).success, true);
	assert.equal(
		DaySnapshotSchema.safeParse({
			...snapshot,
			actor: { workspaceId: "workspace", userId: "someone-else" },
		}).success,
		false
	);
	const fact = {
		id: "fact",
		revision: 1,
		workspaceId: "workspace",
		brain: "private",
		ownerUserId: "owner",
		kind: "intent",
		title: "Source-backed test fact",
		text: "Test-only source",
		provenance: "inferred",
		explanation: "An explicitly inferred test interpretation",
		sources: [citation()],
		state: "active",
		supersededById: null,
		createdAt: at,
		updatedAt: at,
	};
	assert.equal(KnowledgeFactSchema.safeParse(fact).success, true);
	assert.equal(
		KnowledgeFactSchema.safeParse({ ...fact, brain: "company", ownerUserId: null }).success,
		false
	);
	const publicSource = citation();
	assert.equal(
		KnowledgeFactSchema.safeParse({
			...fact,
			brain: "company",
			ownerUserId: null,
			sources: [
				{ ...publicSource, audience: { ...publicSource.audience, visibility: "public_channel" } },
			],
		}).success,
		true
	);
	assert.equal(KnowledgeFactSchema.safeParse({ ...fact, explanation: "" }).success, false);
});
