import { createHash } from "node:crypto";
import {
	type GeneratedScenario,
	GeneratedScenarioSchema,
	type ScenarioPlan,
	ScenarioPlanSchema,
	type ScenarioTrace,
	ScenarioTraceSchema,
} from "../../shared/contracts";
import { abortable } from "./cancellation";
export {
	ScenarioPlanSchema,
	type ScenarioPlan,
	type GeneratedScenario,
} from "../../shared/contracts";

/** Generates data-driven tests, never executable model-supplied expressions. Runtime executes.
 * expectation.path addresses {returnValue, arguments, error}; mutation of arguments is observable.
 */
export function generateScenario(raw: unknown): GeneratedScenario {
	const plan = ScenarioPlanSchema.parse(raw);
	if (
		plan.expectation.path.some(
			(key) => key === "__proto__" || key === "constructor" || key === "prototype"
		)
	)
		throw new Error("Unsafe expectation path");
	const source = `import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const spec = JSON.parse(${JSON.stringify(JSON.stringify({ modulePath: plan.modulePath, exportName: plan.exportName, anchor: plan.anchor, arguments: plan.arguments, expectation: plan.expectation }))});
const lines = readFileSync(spec.modulePath, "utf8").split("\\n");
const matches = lines.flatMap((line, index) => line.includes(spec.anchor) ? [index + 1] : []);
assert.equal(matches.length, 1, "Scenario anchor must match exactly once in this revision");
function jsonValue(value) {
  const seen = new WeakSet();
  return JSON.parse(JSON.stringify(value, (_key, item) => {
    if (typeof item === "bigint") return String(item);
    if (item && typeof item === "object") { if (seen.has(item)) return "[Circular]"; seen.add(item); }
    return item === undefined ? null : item;
  }));
}
function trace(id, label, values, outcome = "continue") {
  console.log("METAHACKATHON_TRACE " + JSON.stringify({ id, file: spec.modulePath, line: matches[0], label, values: jsonValue(values), outcome }));
}
const args = spec.arguments;
let returnValue = null;
let error = null;
trace("invoke", "Invoke " + spec.exportName, { arguments: args });
try {
  const subject = await import("./" + spec.modulePath);
  assert.equal(typeof subject[spec.exportName], "function", "Scenario export must exist");
  returnValue = jsonValue(await subject[spec.exportName](...args));
  trace("returned", "Return from " + spec.exportName, { returnValue, arguments: args }, "return");
} catch (caught) {
  error = { name: caught instanceof Error ? caught.name : "Error", message: caught instanceof Error ? caught.message : String(caught) };
  trace("threw", "Throw from " + spec.exportName, { error, arguments: args }, "throw");
}
const result = { returnValue, arguments: args, error };
console.log("METAHACKATHON_RESULT " + JSON.stringify(result));
let actual = result;
for (const key of spec.expectation.path) actual = actual == null ? undefined : actual[key];
assert.deepEqual(actual, spec.expectation.equals, spec.expectation.description);
`;
	return GeneratedScenarioSchema.parse({
		plan,
		filename: `scenario-${plan.id}.mjs`,
		source,
		sourceSha256: createHash("sha256").update(source).digest("hex"),
		execution: "not-run",
	});
}

export interface GeneratedTestRuntime {
	runGeneratedTest: (input: {
		pr: ScenarioPlan["pr"];
		title: string;
		inputs: ScenarioPlan["inputs"];
		source: string;
		filename: string;
		timeoutMs: number;
		signal: AbortSignal;
	}) => Promise<{ trace: ScenarioTrace; results: { base: unknown; head: unknown } }>;
}
export async function requestScenarioExecution(
	rawGenerated: GeneratedScenario,
	runtime: GeneratedTestRuntime,
	signal: AbortSignal
) {
	const generated = GeneratedScenarioSchema.parse(rawGenerated);
	const verified = generateScenario(generated.plan);
	if (
		verified.sourceSha256 !== generated.sourceSha256 ||
		verified.source !== generated.source ||
		verified.filename !== generated.filename
	)
		throw new Error("Generated test changed; review a fresh test");
	const result = await abortable(
		runtime.runGeneratedTest({
			pr: verified.plan.pr,
			title: verified.plan.title,
			inputs: verified.plan.inputs,
			source: verified.source,
			filename: verified.filename,
			timeoutMs: 30_000,
			signal,
		}),
		signal
	);
	const trace = ScenarioTraceSchema.parse(result.trace);
	if (
		trace.prId !== verified.plan.pr.id ||
		trace.before.commitSha !== verified.plan.pr.baseSha ||
		trace.after.commitSha !== verified.plan.pr.headSha ||
		trace.before.evidence.kind !== "execution" ||
		trace.after.evidence.kind !== "execution"
	)
		throw new Error("Runtime must return execution evidence at both requested revisions");
	return { generated: verified, trace, results: result.results };
}
