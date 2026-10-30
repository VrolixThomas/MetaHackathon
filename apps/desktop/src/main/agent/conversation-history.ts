import type { MetaItem } from "./meta-client";

export type ConversationHistoryEntry =
	| { kind: "exchange"; user: string; assistant: string }
	| { kind: "attention"; claimId: string; assistant: string };

export function conversationHistoryItems(history: ConversationHistoryEntry[]): MetaItem[] {
	return history.flatMap((entry) => [
		...(entry.kind === "exchange" ? [{ role: "user", content: entry.user }] : []),
		{ role: "assistant", content: entry.assistant },
	]);
}

/** Evict whole exchanges or assistant notices, never manufacture a matching user message. */
export function retainConversationHistory(history: ConversationHistoryEntry[]): void {
	const size = (entry: ConversationHistoryEntry) =>
		entry.assistant.length + (entry.kind === "exchange" ? entry.user.length : 0);
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
