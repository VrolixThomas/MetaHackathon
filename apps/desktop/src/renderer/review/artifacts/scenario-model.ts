import type { ScenarioStep, ScenarioTrace } from "../../../shared/contracts";

export type ScenarioRevision = ScenarioStep["location"]["revision"];
export type ScenarioRow = {
	index: number;
	before: ScenarioStep | undefined;
	after: ScenarioStep | undefined;
	shared: boolean;
	divergesHere: boolean;
};

type TraceValue = ScenarioStep["values"][string];

function canonicalValue(value: TraceValue): string {
	if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalValue(entry)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function hasSameBehavior(before: ScenarioStep, after: ScenarioStep) {
	return (
		before.label === after.label &&
		before.outcome === after.outcome &&
		before.location.repository === after.location.repository &&
		before.location.path === after.location.path &&
		canonicalValue(before.values) === canonicalValue(after.values)
	);
}

/** Missing steps stay missing. A missing divergence index is never guessed from values. */
export function scenarioRows(trace: ScenarioTrace): ScenarioRow[] {
	return Array.from(
		{ length: Math.max(trace.before.steps.length, trace.after.steps.length) },
		(_, index) => {
			const before = trace.before.steps[index];
			const after = trace.after.steps[index];
			return {
				index,
				before,
				after,
				shared: !!(
					before &&
					after &&
					trace.divergenceIndex !== undefined &&
					index < trace.divergenceIndex &&
					hasSameBehavior(before, after)
				),
				divergesHere: trace.divergenceIndex === index,
			};
		}
	);
}

export function selectedScenarioIndex(index: number, rowCount: number): number | null {
	if (rowCount === 0) return null;
	return Math.min(rowCount - 1, Math.max(0, Number.isFinite(index) ? Math.trunc(index) : 0));
}

/** Returns the original step, including its pinned revision and full CodeLocation. */
export function scenarioStepAt(trace: ScenarioTrace, index: number, revision: ScenarioRevision) {
	if (!Number.isInteger(index) || index < 0) return undefined;
	return revision === "base"
		? (trace.before.steps[index] ?? trace.after.steps[index])
		: (trace.after.steps[index] ?? trace.before.steps[index]);
}

export function scenarioLocation(step: ScenarioStep): string {
	const { path, startLine, endLine } = step.location;
	return `${path}:${startLine}${endLine === startLine ? "" : `-${endLine}`}`;
}

export function scenarioValue(value: TraceValue): string {
	return typeof value === "string" ? value : JSON.stringify(value);
}
