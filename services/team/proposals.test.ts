import assert from "node:assert/strict";
import { test } from "node:test";
import { type ProposalBundle, validateBundle } from "./proposals";
import { digest, sha256 } from "./protocol";

const blob = (text: string) => ({ text, sha256: sha256(text) });
function bundle(): ProposalBundle {
	const candidate = "f".repeat(40);
	const files = [{ path: "a.ts", before: blob("old\r\n"), after: blob("new\r\n") }];
	const checks = [
		{
			command: ["bun", "test"],
			commitSha: candidate,
			startedAt: "2026-11-01T01:00:00Z",
			finishedAt: "2026-11-01T01:00:01Z",
			exitCode: 0,
			environment: "Controlled local check",
			output: blob("1 pass\n"),
		},
	];
	return {
		key: {
			orgId: "10000000-0000-4000-8000-000000000001",
			repositoryId: "42",
			prNumber: 1,
			baseSha: "a".repeat(40),
			headSha: "b".repeat(40),
			contextDigest: "c".repeat(64),
			analysisVersion: "test-v1",
		},
		feedback: {
			kind: "issue-comment",
			id: "9",
			revision: "2026-11-01T00:00:00Z",
			body: "Fix source",
			bodyDigest: sha256("Fix source"),
		},
		baseSha: "b".repeat(40),
		candidateSha: candidate,
		files,
		sourcesDigest: digest(files),
		patch: blob("-old\r\n+new\r\n"),
		checks,
		checksDigest: digest(checks),
		provenance: "reported-local-candidate",
	};
}
test("proposal keeps exact CRLF source/check bytes and rejects tampered or misattributed claims", () => {
	const value = bundle();
	assert.equal(validateBundle(value).files[0]?.after?.text, "new\r\n");
	assert.throws(() =>
		validateBundle({ ...value, files: [{ ...value.files[0], after: blob("other\n") }] })
	);
	assert.throws(() =>
		validateBundle({ ...value, checks: [{ ...value.checks[0], commitSha: value.baseSha }] })
	);
	assert.throws(() =>
		validateBundle({ ...value, patch: { text: "other", sha256: value.patch.sha256 } })
	);
	assert.throws(() =>
		validateBundle({ ...value, files: [{ ...value.files[0], path: "../private.txt" }] })
	);
	assert.throws(() => validateBundle({ ...value, personalNotes: "private context" }));
});
