// Numeric acceptance is independent of qualitative review of the actual model answers.
const fs = require("node:fs");
const file = process.argv[2];
if (!file) throw Error("Pass the report.json from a completed live rehearsal");
const report = JSON.parse(fs.readFileSync(file, "utf8"));
const commonIds = new Set([
	"scope-choice",
	"scope-consequence",
	"scope-rationale",
	"scope-failure",
	"scope-continue",
	"variant-recommendation",
	"variant-choice",
	"variant-downside",
	"variant-rationale",
	"variant-decisions",
]);
const common = report.turns.filter((t) => commonIds.has(t.id));
const sorted = common
	.map((t) => t.textAcceptedToAudioMs)
	.filter(Number.isFinite)
	.sort((a, b) => a - b);
const percentile = (q) =>
	sorted.length ? sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] : null;
const median = percentile(0.5);
const p90 = percentile(0.9);
const navigation = report.turns.filter((t) =>
	["ticket-navigation", "ticket-design"].includes(t.id)
);
const checks = {
	complete: report.status === "completed",
	enoughSamples: sorted.length >= 5,
	commonMedian: median !== null && median <= 3000,
	commonP90: p90 !== null && p90 <= 5000,
	navigation: navigation.length === 2 && navigation.every((t) => t.textAcceptedToAudioMs <= 5000),
	quietStop:
		report.suite === "variants"
			? null
			: report.turns.some((t) => t.id === "stop" && t.modelRounds === 0 && t.firstAudioAt === null),
};
console.log(
	JSON.stringify(
		{
			sourceCommit: report.sourceCommit,
			scriptedASR: true,
			actualModelAndTTS: true,
			physicalAcousticsTested: false,
			checks,
			medianMs: median,
			p90Ms: p90,
			turns: report.turns.map((t) => ({
				id: t.id,
				firstAudioMs: t.textAcceptedToAudioMs,
				modelRounds: t.modelRounds,
				words: t.answer.trim().split(/\s+/).length,
				answer: t.answer,
			})),
			qualitativeAcceptance:
				"not assessed by this numeric CLI: inspect consequences, recommendation, continuity, evidence and actual side-effect ledger",
		},
		null,
		2
	)
);
if (Object.values(checks).some((value) => value === false)) process.exitCode = 1;
