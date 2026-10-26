import assert from "node:assert/strict";
import { test } from "node:test";
import { getReviewFixture } from "../../shared/fixtures/review";
import { MetaClient } from "./meta-client";
import { assessRequestedScope } from "./scope-analysis";
import { completed, transport } from "./test-support";

test("unrequested-code findings remain inferred and must cite actual recorded wording for conflicts", async () => {
	const fixture = getReviewFixture();
	const pr = fixture.preparation.pr;
	const input = {
		requestId: "scope",
		pr,
		screenContext: fixture.screenContext,
		changes: [
			{
				id: "cache",
				location: {
					repository: pr.repository,
					revision: "head",
					commitSha: pr.headSha,
					path: "promo/PromoCache.ts",
					startLine: 1,
					endLine: 10,
				},
				diff: "+ export class PromoCache {}",
			},
		],
		intentSources: [
			{
				id: "author-1",
				source: {
					kind: "author-session",
					url: "https://example.test/session",
					excerpt: "Use the existing PromoRepository. Do not add new services.",
					evidence: fixture.evidence,
				},
			},
		],
	};
	let quote = "Do not add new services.";
	const client = new MetaClient({
		getApiKey: async () => "test-key",
		recordUsage: () => {},
		fetch: async () => {
			const terminal = completed();
			terminal.response.model = "muse-wonder-1.0";
			return transport([
				{
					type: "response.output_text.delta",
					delta: JSON.stringify([
						{
							changeId: "cache",
							relation: "conflicts",
							explanation: "A new cache appears outside the recorded service constraint",
							citations: [{ sourceId: "author-1", quote }],
						},
					]),
				},
				terminal,
			]);
		},
	});
	const findings = await assessRequestedScope(client, input, new AbortController().signal);
	assert.equal(findings[0]?.provenance, "inferred");
	assert.equal(findings[0]?.citedSources[0]?.quote, quote);
	assert.equal(findings[0]?.coverage, "provided-sources-only");
	quote = "Author explicitly requested a cache";
	await assert.rejects(
		assessRequestedScope(client, input, new AbortController().signal),
		/citation is not present/
	);
});
