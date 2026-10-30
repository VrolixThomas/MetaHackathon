import type { ChatMessage } from "../../shared/contracts/chat";
import type { DayPhase, DayWorkItem } from "../../shared/contracts/day";

type Tone = "quiet" | "attention" | "active" | "ready";
export const phasePresentation: Record<DayPhase, { label: string; tone: Tone; focus: string }> = {
	captured: {
		label: "Captured",
		tone: "quiet",
		focus: "Review the captured commitment and confirm ownership when needed.",
	},
	preparing: {
		label: "Preparing in background",
		tone: "active",
		focus: "Background preparation is in progress. Return at the next checkpoint.",
	},
	needs_context: {
		label: "Needs Q&A",
		tone: "attention",
		focus: "Cover this item with Muse to provide the missing context.",
	},
	ready: {
		label: "Prepared",
		tone: "quiet",
		focus: "Preparation is ready for the next step.",
	},
	working: {
		label: "Working in background",
		tone: "active",
		focus: "Work is in progress. Open the recorded job to inspect its current state.",
	},
	ready_review: {
		label: "Ready for review",
		tone: "ready",
		focus: "Open the recorded work to review the result and its checks.",
	},
	awaiting_reply: {
		label: "Awaiting source reply",
		tone: "attention",
		focus: "Review the answer for the original source thread. Delivery completes the commitment.",
	},
	closed: {
		label: "Closed",
		tone: "quiet",
		focus: "The source answer has a recorded delivery receipt.",
	},
	cancelled: {
		label: "Cancelled",
		tone: "quiet",
		focus: "This work item is cancelled.",
	},
};

export function sourceVisibility(item: DayWorkItem) {
	switch (item.source?.audience.visibility) {
		case "public_channel":
			return "Team source · public channel";
		case "private_channel":
			return "Private source · private channel";
		case "direct_message":
			return "Private source · direct message";
		case "group_direct_message":
			return "Private source · group message";
		default:
			return "Private to you · manual capture";
	}
}

export function ownershipLabel(item: DayWorkItem) {
	if (item.acceptance === "pending") return "Acceptance pending";
	if (item.acceptance === "declined") return "Declined";
	return item.acceptanceBasis === "own_explicit_promise" ? "Your explicit promise" : "Accepted";
}

/** Preserve source order. Ranking explains observed priority; it never fabricates a new queue. */
export function activeDayItems(items: DayWorkItem[]) {
	return items.filter((item) => !["closed", "cancelled"].includes(item.phase));
}

export function sameSourceThread(item: DayWorkItem, message: ChatMessage) {
	if (!item.source) return false;
	const expected = item.source.source;
	const actual = message.citation.source;
	return (
		expected.workspaceId === actual.workspaceId &&
		expected.conversationId === actual.conversationId &&
		(expected.threadId ?? expected.messageId) === (actual.threadId ?? actual.messageId)
	);
}

export const checkpointLabel = (value: string) =>
	new Intl.DateTimeFormat("en", {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		timeZone: "UTC",
		timeZoneName: "short",
	}).format(new Date(value));
