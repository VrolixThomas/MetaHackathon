import assert from "node:assert/strict";
import { test } from "node:test";
import { CodeExcerptSchema, MAX_CODE_EXCERPTS, PRPreparationSchema } from "../../shared/contracts";
import { getReviewFixture } from "../../shared/fixtures/review";
import { sourceExcerpts } from "./excerpts";

test("preparation retains verbatim pinned source context without inventing Why notes", () => {
	const fixture = getReviewFixture();
	const files = [
		{
			path: "pricing/applyDiscounts.ts",
			baseContent: "\nreturn loyalty;\n",
			headContent: "\nreturn Math.min(loyalty + promo, 40);\n",
		},
	];
	const context = sourceExcerpts(fixture.preparation.pr, files, () => fixture.evidence);
	assert.equal(context.length, 2);
	assert.equal(context[0]?.text, files[0]?.headContent);
	assert.equal(context[0]?.location.endLine, 3);
	assert.equal(context[1]?.location.commitSha, fixture.preparation.pr.baseSha);
	const prepared = PRPreparationSchema.parse({
		...fixture.preparation,
		whyNotes: [],
		sourceContext: context,
	});
	assert.deepEqual(prepared.sourceContext, context);
	assert.deepEqual(prepared.whyNotes, []);
	assert.equal(
		PRPreparationSchema.safeParse({
			...prepared,
			sourceContext: [
				{ ...context[0], location: { ...context[0]?.location, commitSha: "3".repeat(40) } },
			],
		}).success,
		false
	);
	assert.equal(CodeExcerptSchema.safeParse({ ...context[0], text: "one line" }).success, false);
});

test("source context bounds whole lines and count, skips missing/binary sources", () => {
	const fixture = getReviewFixture();
	const context = sourceExcerpts(
		fixture.preparation.pr,
		Array.from({ length: 30 }, (_, index) => ({
			path: `src/${index}.ts`,
			baseContent: null,
			headContent: `${"x".repeat(1000)}\n${"y".repeat(11900)}`,
		})),
		() => fixture.evidence
	);
	assert.equal(context.length, MAX_CODE_EXCERPTS);
	assert.ok(
		context.every((entry) => entry.text === "x".repeat(1000) && entry.location.endLine === 1)
	);
	assert.deepEqual(
		sourceExcerpts(
			fixture.preparation.pr,
			[{ path: "asset.bin", baseContent: null, headContent: "\0binary" }],
			() => fixture.evidence
		),
		[]
	);
});
