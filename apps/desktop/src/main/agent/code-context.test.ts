import assert from "node:assert/strict";
import { test } from "node:test";
import { getReviewFixture } from "../../shared/fixtures/review";
import { findCodeContext } from "./code-context";

test("caller analysis resolves imported aliases and callees while excluding comments, strings and shadowed functions", () => {
	const fixture = getReviewFixture();
	const pr = fixture.preparation.pr;
	const result = findCodeContext({
		pr,
		revision: "head",
		evidence: fixture.evidence,
		files: [
			{ path: "pricing/price.ts", source: "export function price(n: number) { return n; }" },
			{
				path: "pricing/discount.ts",
				source:
					'import { price } from "./price";\nexport function discount(n: number) { return price(n); }',
			},
			{
				path: "checkout.ts",
				source:
					'import { discount as apply } from "./pricing/discount";\nexport function checkout() { return apply(1); }\n// apply(2)\nconst note = "apply(3)";\nexport function shadow() { const apply = (n: number) => n; return apply(4); }',
			},
			{
				path: "jobs.ts",
				source:
					'import { discount } from "./pricing/discount";\nexport function reminder() { return discount(2); }\nexport function unresolved(fn: Function) { fn(); }',
			},
		],
		changed: [
			{
				repository: pr.repository,
				revision: "head",
				commitSha: pr.headSha,
				path: "pricing/discount.ts",
				startLine: 2,
				endLine: 2,
			},
		],
	});
	assert.equal(result.functions[0]?.callerCount, 2);
	assert.equal(result.calls.length, 3);
	assert(result.diagram.nodes.some((node) => node.label === "price"));
	assert(!result.diagram.nodes.some((node) => node.label === "shadow"));
	assert(result.unresolvedCalls.some((call) => call.expression === "fn"));
	assert.equal(result.coverage.complete, false);
	assert.equal(result.diagram.evidence.kind, "fixture");
});
