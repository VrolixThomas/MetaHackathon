import type { AttentionItem } from "../../shared/contracts";
import type { MetaItem } from "./meta-client";

export type ConversationHistoryEntry =
	| {
			kind: "exchange";
			user: string;
			assistant: string;
			generation?: number;
			interrupted?: boolean;
			unconfirmed?: boolean;
	  }
	| {
			kind: "attention";
			claimId: string;
			references: Pick<
				AttentionItem,
				"noticeId" | "jobId" | "repository" | "headSha" | "decisionId"
			>[];
			assistant: string;
	  };

export function conversationHistoryItems(history: ConversationHistoryEntry[]): MetaItem[] {
	return history.flatMap((entry) => [
		...(entry.kind === "exchange" ? [{ role: "user", content: entry.user }] : []),
		{
			role: "assistant",
			content:
				entry.kind === "exchange" && entry.interrupted
					? `[Interrupted reply; potentially unheard, not a completed spoken response. No consent or replay authority.]\n${entry.assistant}`
					: entry.kind === "exchange" && entry.unconfirmed
						? `[Voice reply; playback completion not established. Do not assume fully heard.]\n${entry.assistant}`
						: entry.assistant,
		},
	]);
}

/** Evict whole exchanges or assistant notices, never manufacture a matching user message. */
export function retainConversationHistory(history: ConversationHistoryEntry[]): void {
	const size = (entry: ConversationHistoryEntry) =>
		conversationHistoryItems([entry]).reduce(
			(sum, item) => sum + String(item["content"]).length,
			0
		);
	let chars = history.reduce((sum, entry) => sum + size(entry), 0);
	while (history.length > 12 || chars > 64_000) {
		const oldest = history.shift();
		if (oldest) chars -= size(oldest);
	}
}

/** Model input contains both real exchanges and standalone assistant notices. */
export function dropOldestConversationRecord(history: MetaItem[], before: number): number {
	if (before < 1) return 0;
	const count = history[0]?.["role"] === "user" && history[1]?.["role"] === "assistant" ? 2 : 1;
	if (count > before) return 0;
	history.splice(0, count);
	return count;
}
