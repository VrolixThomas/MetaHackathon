import assert from "node:assert/strict";
import { it } from "node:test";
import { getReviewFixture } from "../../shared/fixtures/review";
import type { SourceAdapter } from "./services";
import { readReviewFile } from "./source-adapter";

const { preparation } = getReviewFixture();
function source(base: string | null, head: string | null): SourceAdapter {
	return {
		read: async (input) => ({
			...input,
			repository: preparation.pr.repository,
			commitSha: input.revision === "base" ? preparation.pr.baseSha : preparation.pr.headSha,
			content: input.revision === "base" ? base : head,
		}),
	};
}
it("preserves full-source whitespace and one-based code locations", async () => {
	const file = await readReviewFile(
		source("\n  old\r\n", "\n  new\r\n"),
		preparation,
		"pricing/applyDiscounts.ts"
	);
	assert.deepEqual(
		file.lines.filter((line) => line.kind !== "remove").map((line) => [line.newLine, line.text]),
		[
			[1, ""],
			[2, "  new\r"],
			[3, ""],
		]
	);
});
it("distinguishes a confirmed empty file from unavailable source", async () => {
	assert.equal(
		(await readReviewFile(source(null, ""), preparation, "empty.ts")).sourceAvailable,
		true
	);
	assert.equal(
		(await readReviewFile(source(null, null), preparation, "absent.ts")).sourceAvailable,
		false
	);
});
it("rejects responses for the wrong PR or revision rather than displaying them", async () => {
	const adapter = source("a", "b");
	await assert.rejects(
		() =>
			readReviewFile(
				{ read: async (input) => ({ ...(await adapter.read(input)), prId: "another/pr" }) },
				preparation,
				"pricing/applyDiscounts.ts"
			),
		/pinned revision/
	);
	await assert.rejects(
		() =>
			readReviewFile(
				{ read: async (input) => ({ ...(await adapter.read(input)), commitSha: "f".repeat(40) }) },
				preparation,
				"pricing/applyDiscounts.ts"
			),
		/pinned revision/
	);
});
