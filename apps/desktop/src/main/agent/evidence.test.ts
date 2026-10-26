import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExecutionEvidence } from "../../shared/contracts";
import { getReviewFixture } from "../../shared/fixtures/review";
import {
	captureRecordedTrail,
	explainIntent,
	inferredWhyNote,
	prepareIntentHook,
	publishIntentHook,
	readRecordedTrail,
	recordedWhyNote,
} from "./intent";
import { MetaClient } from "./meta-client";
import { preparePullRequest } from "./preparation";
import { completed, transport } from "./test-support";

function run(commitSha: string, exitCode = 0): ExecutionEvidence {
	return {
		kind: "execution",
		runId: `test-${commitSha}`,
		commitSha,
		command: ["node", "build.mjs"],
		startedAt: "2026-10-26T20:00:00Z",
		completedAt: "2026-10-26T20:00:01Z",
		exitCode,
		logUrl: "file:///test-build-log",
	};
}
test("mechanical triage requires actual matching build evidence and describes its limited check", async () => {
	const { preparation } = getReviewFixture();
	const input = {
		pr: preparation.pr,
		evidence: preparation.evidence,
		files: [
			{
				path: "format.json",
				baseContent: '{"hello":1}',
				headContent: '{ "hello": 1 }',
				evidence: preparation.evidence,
			},
			{
				path: "pricing/rule.ts",
				baseContent: 'return "a b";',
				headContent: 'return "ab";',
				evidence: preparation.evidence,
			},
		],
	};
	const execute = async (baseSha = input.pr.baseSha, headExit = 0) =>
		preparePullRequest(
			input,
			{ runBuilds: async () => ({ base: run(baseSha), head: run(input.pr.headSha, headExit) }) },
			new AbortController().signal
		);
	const prep = await execute();
	assert.equal(prep.files[0]?.path, "pricing/rule.ts");
	assert.equal(prep.files[0]?.category, "needs-review");
	assert.equal(prep.files[1]?.category, "mechanical-verified");
	assert(prep.files[1]?.reason.includes("does not establish behavior equivalence"));
	assert.equal((await execute("a".repeat(40))).files[1]?.category, "mechanical-candidate");
	assert.equal((await execute(input.pr.baseSha, 1)).files[1]?.category, "mechanical-candidate");
	const noRuntime = await preparePullRequest(
		input,
		{
			runBuilds: async () => {
				throw new Error("Unavailable");
			},
		},
		new AbortController().signal
	);
	assert.equal(noRuntime.files[1]?.category, "mechanical-candidate");
});

test("intent trail removes credentials, preserves citations, and separates author evidence from inference", async () => {
	const fixture = getReviewFixture();
	const location = fixture.draftComment.location;
	assert(location);
	const source = {
		kind: "author-session" as const,
		url: "https://user:secret@example.test/session?token=querysecret",
		excerpt: 'Use the existing repository. API_KEY="private-value"',
		evidence: {
			kind: "source" as const,
			url: "https://example.test/session?token=querysecret",
			retrievedAt: "2026-10-26T20:00:00Z",
		},
	};
	const prepared = prepareIntentHook(
		{
			entries: [
				{
					id: "entry-1",
					speaker: "author",
					text: "Use existing repository. Bearer ghp_secretToken and known-value",
					source,
					locations: [location],
				},
			],
		},
		["known-value"]
	);
	for (const secret of [
		"private-value",
		"secretToken",
		"known-value",
		"querysecret",
		"user:secret",
	])
		assert(!prepared.body.includes(secret));
	const trail = readRecordedTrail(prepared.body);
	assert(trail?.entries[0]);
	const entry = trail.entries[0];
	const note = recordedWhyNote(entry, location);
	assert.equal(note.provenance.kind, "recorded");
	assert.throws(
		() => recordedWhyNote({ ...entry, speaker: "agent" }, location),
		/cannot establish/
	);
	const inferred = inferredWhyNote({
		id: "inference",
		location,
		text: "This may reduce work",
		explanation: "No author trail covers this code",
		sources: [{ ...source, kind: "code" }],
	});
	assert.equal(inferred.provenance.kind, "inferred");
	let posted = "";
	await publishIntentHook(
		{ prId: fixture.preparation.pr.id, body: prepared.body, authorApproved: true },
		{
			postIntentSummary: async (_id, body) => {
				posted = body;
				return { url: "https://example.test/comment" };
			},
		},
		new AbortController().signal
	);
	assert.equal(posted, prepared.body);
	assert.equal(readRecordedTrail("This is only inferred"), null);
});

test("absent intent trail produces only inferred notes with supplied code citations", async () => {
	const fixture = getReviewFixture();
	const location = fixture.draftComment.location;
	assert(location);
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
							id: "changed-rule",
							text: "May enforce promo validity",
							explanation: "Derived from the added throw; no author trail covers it",
						},
					]),
				},
				terminal,
			]);
		},
	});
	const source = {
		kind: "code" as const,
		url: "https://example.test/pr/files",
		excerpt: "if (promo.expired) throw new PromoExpiredError(code)",
		evidence: fixture.evidence,
	};
	const notes = await explainIntent(
		client,
		{
			requestId: "why-inferred",
			pr: fixture.preparation.pr,
			screenContext: fixture.screenContext,
			trail: null,
			targets: [{ id: "changed-rule", location, source }],
		},
		new AbortController().signal
	);
	assert.equal(notes[0]?.provenance.kind, "inferred");
	assert.equal(notes[0]?.evidence.kind, "fixture");
	assert.deepEqual(notes[0]?.provenance.sources, [source]);
});

test("mechanical JSON comparison preserves number tokens, duplicate members and string whitespace", async () => {
	const { preparation } = getReviewFixture();
	for (const [baseContent, headContent] of [
		['{"limit":9007199254740992}', '{"limit":9007199254740993}'],
		['{"limit":1,"limit":2}', '{"limit":2}'],
		['{"offset":-0}', '{"offset":0}'],
		['{"label":"a b"}', '{"label":"ab"}'],
	]) {
		let builds = 0;
		const result = await preparePullRequest(
			{
				pr: preparation.pr,
				evidence: preparation.evidence,
				files: [{ path: "config.json", baseContent, headContent, evidence: preparation.evidence }],
			},
			{
				runBuilds: async () => {
					builds++;
					return { base: run(preparation.pr.baseSha), head: run(preparation.pr.headSha) };
				},
			},
			new AbortController().signal
		);
		assert.equal(result.files[0]?.category, "needs-review", `${baseContent} -> ${headContent}`);
		assert.equal(builds, 0);
	}
});

test("cancelled preparation does not start builds or publish a ready result", async () => {
	const { preparation } = getReviewFixture();
	const controller = new AbortController();
	controller.abort();
	let builds = 0;
	for (const headContent of ["same", "different"]) {
		await assert.rejects(
			preparePullRequest(
				{
					pr: preparation.pr,
					evidence: preparation.evidence,
					files: [
						{ path: "file.ts", baseContent: "same", headContent, evidence: preparation.evidence },
					],
				},
				{
					runBuilds: async () => {
						builds++;
						return { base: run(preparation.pr.baseSha), head: run(preparation.pr.headSha) };
					},
				},
				controller.signal
			),
			{ name: "AbortError" }
		);
	}
	assert.equal(builds, 0);
});

test("recorded intent rejects credential patterns in metadata and validates direct provenance", () => {
	const fixture = getReviewFixture();
	const location = fixture.draftComment.location;
	assert(location);
	const entry = {
		id: "author-entry",
		speaker: "author" as const,
		text: "Keep the reminder running",
		locations: [location],
		source: {
			kind: "author-session" as const,
			url: "https://example.test/session",
			excerpt: "Keep the reminder running",
			evidence: {
				kind: "source" as const,
				url: "https://example.test/session",
				retrievedAt: "2026-10-26T20:00:00Z",
			},
		},
	};
	for (const unsafe of [
		{ ...entry, id: "ghp_testSecretInMetadata" },
		{ ...entry, locations: [{ ...location, path: "ghp_testSecretInPath.ts" }] },
	]) {
		assert.throws(() => captureRecordedTrail({ entries: [unsafe] }), /metadata/);
	}
	assert.throws(() =>
		recordedWhyNote({ ...entry, source: { ...entry.source, kind: "code" } }, location)
	);
	assert.throws(() =>
		recordedWhyNote({ ...entry, source: { ...entry.source, evidence: fixture.evidence } }, location)
	);
	assert.equal(recordedWhyNote(entry, location).provenance.kind, "recorded");
});

test("build adapters cannot change the PR revisions used for mechanical verification", async () => {
	const { preparation } = getReviewFixture();
	const prepared = await preparePullRequest(
		{
			pr: preparation.pr,
			evidence: preparation.evidence,
			files: [
				{
					path: "config.json",
					baseContent: "{}",
					headContent: "{ }",
					evidence: preparation.evidence,
				},
			],
		},
		{
			runBuilds: async (pr) => {
				pr.baseSha = "a".repeat(40);
				return { base: run(pr.baseSha), head: run(pr.headSha) };
			},
		},
		new AbortController().signal
	);
	assert.deepEqual(prepared.pr, preparation.pr);
	assert.equal(prepared.files[0]?.category, "mechanical-candidate");
});
