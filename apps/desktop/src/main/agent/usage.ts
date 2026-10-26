import { z } from "zod";
import type { UsageRecord } from "./meta-client";
import { PRICING_VERIFIED_AT, STANDARD_MODELS, estimateCostUsd } from "./models";

const recordSchema = z.strictObject({
	attemptId: z.string().min(1),
	requestId: z.string().min(1),
	responseId: z.string().nullable(),
	model: z.enum(STANDARD_MODELS),
	status: z.enum(["completed", "failed", "incomplete", "cancelled", "interrupted"]),
	usage: z
		.strictObject({
			inputTokens: z.int().nonnegative(),
			cachedInputTokens: z.int().nonnegative(),
			outputTokens: z.int().nonnegative(),
		})
		.nullable(),
	estimatedUsd: z.number().nonnegative().nullable(),
	pricingVerifiedAt: z.literal(PRICING_VERIFIED_AT),
});

/** Main-process accounting. Inject a durable sink from runtime for restart persistence. */
export class UsageLedger {
	private readonly records = new Map<string, { prId: string; record: UsageRecord }>();
	constructor(private readonly persist: (entry: { prId: string; record: UsageRecord }) => void) {}

	record(prId: string, raw: UsageRecord) {
		const record = recordSchema.parse(raw);
		const estimated = record.usage ? estimateCostUsd(record.model, record.usage) : null;
		if (record.estimatedUsd !== estimated)
			throw new Error("Cost record does not match reported tokens and pricing");
		const entry = { prId: z.string().min(1).parse(prId), record };
		const existing = this.records.get(record.attemptId);
		if (existing) {
			if (JSON.stringify(existing) !== JSON.stringify(entry))
				throw new Error("Conflicting usage attempt");
			return;
		}
		this.persist(structuredClone(entry));
		this.records.set(record.attemptId, entry);
	}

	summary(prId: string) {
		const records = [...this.records.values()]
			.filter((entry) => entry.prId === prId)
			.map((entry) => entry.record);
		return {
			prId,
			requests: records.length,
			knownEstimatedUsd: records.reduce((cost, record) => cost + (record.estimatedUsd ?? 0), 0),
			unknownCostRequests: records.filter((record) => record.estimatedUsd === null).length,
			pricingVerifiedAt: PRICING_VERIFIED_AT,
		};
	}

	canStart(prId: string, budgetUsd: number, reserveUsd: number) {
		if (
			!Number.isFinite(budgetUsd) ||
			budgetUsd < 0 ||
			!Number.isFinite(reserveUsd) ||
			reserveUsd < 0
		)
			throw new Error("Invalid cost budget");
		const summary = this.summary(prId);
		return summary.unknownCostRequests === 0 && summary.knownEstimatedUsd + reserveUsd <= budgetUsd;
	}
}
