import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageRecord } from "./meta-client";
import { UsageLedger } from "./usage";

test("cost accounting counts distinct attempts, deduplicates delivery, and leaves missing costs unknown", () => {
	let persisted = 0;
	const ledger = new UsageLedger(() => {
		persisted++;
	});
	const record: UsageRecord = {
		attemptId: "attempt-1",
		requestId: "same-logical-request",
		responseId: "resp-1",
		model: "muse-spark-1.3",
		status: "completed",
		usage: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 10 },
		estimatedUsd: 0.0001455,
		pricingVerifiedAt: "2026-10-26",
	};
	ledger.record("pr-1", record);
	ledger.record("pr-1", record);
	ledger.record("pr-1", { ...record, attemptId: "attempt-2", responseId: "resp-2" });
	assert.equal(persisted, 2);
	assert.equal(ledger.summary("pr-1").requests, 2);
	assert(ledger.canStart("pr-1", 1, 0.1));
	ledger.record("pr-1", {
		...record,
		attemptId: "attempt-3",
		responseId: null,
		status: "cancelled",
		usage: null,
		estimatedUsd: null,
	});
	assert.equal(ledger.summary("pr-1").unknownCostRequests, 1);
	assert(!ledger.canStart("pr-1", 1, 0.1));
	assert.throws(() => ledger.record("pr-1", { ...record, estimatedUsd: 0 }));
});
