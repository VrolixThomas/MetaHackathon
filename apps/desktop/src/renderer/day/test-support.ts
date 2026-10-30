import type { z } from "zod";
import {
	ChatCitationSchema,
	ChatMessageSchema,
	type ChatVisibilitySchema,
} from "../../shared/contracts/chat";
import {
	type DaySnapshot,
	DaySnapshotSchema,
	type DayWorkItem,
	DayWorkItemSchema,
} from "../../shared/contracts/day";

/** Controlled records for unit/SSR tests only. Never imported by product modules. */
export const stamp = "2026-10-31T09:00:00.000Z";
export function citation(visibility: z.infer<typeof ChatVisibilitySchema> = "private_channel") {
	return ChatCitationSchema.parse({
		source: {
			provider: "slack",
			workspaceId: "workspace",
			conversationId: "channel",
			messageId: "original",
			threadId: "thread",
			revisionId: "source-revision",
			permalink: "https://test.slack.com/archives/channel/original",
		},
		audience: {
			workspaceId: "workspace",
			conversationId: "channel",
			visibility,
			readerIds: ["owner"],
			membershipRevision: "membership",
			observedAt: stamp,
		},
	});
}
export function workItem(overrides: Partial<DayWorkItem> = {}): DayWorkItem {
	return DayWorkItemSchema.parse({
		id: "item",
		revision: 3,
		workspaceId: "workspace",
		ownerUserId: "owner",
		requestedById: "requester",
		kind: "request",
		title: "Controlled captured request",
		summary: "Controlled brief",
		source: citation(),
		acceptance: "pending",
		acceptanceBasis: "none",
		acceptedAt: null,
		phase: "captured",
		priority: { rank: 60, reason: "A source deadline needs attention", provenance: "inferred" },
		questions: [],
		jobId: null,
		repositoryId: null,
		linearIssueId: null,
		nextCheckAt: stamp,
		reviewedAt: null,
		reviewedHeadSha: null,
		replyDraft: null,
		answerReceipt: null,
		createdAt: stamp,
		updatedAt: stamp,
		...overrides,
	});
}
export function snapshot(
	items: DayWorkItem[] = [],
	overrides: Partial<DaySnapshot> = {}
): DaySnapshot {
	return DaySnapshotSchema.parse({
		sequence: 1,
		actor: { workspaceId: "workspace", userId: "owner" },
		items,
		currentItemId: null,
		supervisor: "running",
		errors: [],
		...overrides,
	});
}
export function message(text = "Exact source\r\n\t<script>& text") {
	return ChatMessageSchema.parse({
		citation: citation(),
		authorId: "requester",
		text,
		createdAt: stamp,
		updatedAt: stamp,
		deletedAt: null,
		truncated: false,
	});
}
export function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}
