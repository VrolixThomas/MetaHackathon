import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type ConversationHistoryEntry,
	conversationHistoryItems,
	dropOldestConversationRecord,
	retainConversationHistory,
} from "./conversation-history";

test("mixed history retains bounded whole exchanges and standalone assistant notices", () => {
	for (const chars of [10, 6000]) {
		const history: ConversationHistoryEntry[] = [];
		for (let i = 0; i < 30; i++) {
			history.push(
				i % 2
					? { kind: "attention", claimId: `claim-${i}`, assistant: "a".repeat(chars) }
					: { kind: "exchange", user: "u".repeat(chars), assistant: "a".repeat(chars) }
			);
			retainConversationHistory(history);
		}
		assert(history.length <= 12);
		const items = conversationHistoryItems(history);
		assert(items.reduce((sum, item) => sum + String(item["content"]).length, 0) <= 64_000);
		assert.equal(
			items.filter((item) => item["role"] === "user").length,
			history.filter((entry) => entry.kind === "exchange").length
		);
	}
});

test("source/workspace budget eviction handles singleton notices without splitting real exchanges or current question", () => {
	const history = [
		{ role: "assistant", content: "Notice" },
		{ role: "user", content: "Real earlier question" },
		{ role: "assistant", content: "Real earlier answer" },
		{ role: "assistant", content: "Another notice" },
		{ role: "user", content: "Current real question" },
	];
	assert.equal(dropOldestConversationRecord(history, 4), 1);
	assert.equal(dropOldestConversationRecord(history, 3), 2);
	assert.equal(dropOldestConversationRecord(history, 1), 1);
	assert.equal(dropOldestConversationRecord(history, 0), 0);
	assert.deepEqual(history, [{ role: "user", content: "Current real question" }]);
});
