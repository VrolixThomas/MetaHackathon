/** Verified against dev.meta.ai/docs/models and /pricing-rate-limits, 2026-10-26.
 * Documentation availability is not proof of account entitlement. No contributor fallback.
 */
export const MODEL_API_URL = "https://api.meta.ai/v1/responses";
export const STANDARD_MODELS = ["muse-spark-1.3", "muse-wonder-1.0"] as const;
export type StandardModel = (typeof STANDARD_MODELS)[number];
export type Workload = "quick" | "conversation" | "deep";

export function routeModel(workload: Workload): StandardModel {
	return workload === "quick" ? "muse-spark-1.3" : "muse-wonder-1.0";
}

export function assertStandardModel(model: string): asserts model is StandardModel {
	if (!(STANDARD_MODELS as readonly string[]).includes(model)) {
		throw new Error("Unsupported model: only verified Standard mode models are permitted");
	}
}

export interface TokenUsage {
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
}

export const PRICING_VERIFIED_AT = "2026-10-26";
export const USD_PER_MILLION = {
	"muse-spark-1.3": { input: 1.25, cached: 0.15, output: 4.25 },
	"muse-wonder-1.0": { input: 4, cached: 0.2, output: 20 },
} satisfies Record<StandardModel, { input: number; cached: number; output: number }>;

export function estimateCostUsd(model: StandardModel, usage: TokenUsage): number {
	assertStandardModel(model);
	for (const n of Object.values(usage)) {
		if (!Number.isSafeInteger(n) || n < 0) throw new Error("Invalid token usage");
	}
	if (usage.cachedInputTokens > usage.inputTokens) throw new Error("Invalid cached usage");
	const rates = USD_PER_MILLION[model];
	return (
		((usage.inputTokens - usage.cachedInputTokens) * rates.input +
			usage.cachedInputTokens * rates.cached +
			usage.outputTokens * rates.output) /
		1_000_000
	);
}
