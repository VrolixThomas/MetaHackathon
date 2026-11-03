import assert from "node:assert/strict";
import { it } from "node:test";
import {
	APPROVAL_TERMS_MAX_BYTES,
	ApprovalConfirmInputSchema,
	ApprovalDraftInputSchema,
	ApprovalTermsSchema,
} from "./pr-approval";
const terms = {
	action: "notify",
	expiresAt: "2026-11-02T12:00:00Z",
	conditions: [{ kind: "check", name: "regression", appId: null }],
};
it("delegation contracts require exact consent, revision and bounded explicit scope", () => {
	assert.ok(ApprovalTermsSchema.safeParse(terms).success);
	assert.equal(ApprovalTermsSchema.safeParse({ ...terms, conditions: [] }).success, false);
	assert.equal(
		ApprovalTermsSchema.safeParse({
			...terms,
			conditions: [...terms.conditions, ...terms.conditions],
		}).success,
		false
	);
	assert.equal(
		ApprovalTermsSchema.safeParse({
			...terms,
			conditions: [{ kind: "source", path: "../secret", expectedContent: "x", reason: "fix" }],
		}).success,
		false
	);
	assert.equal(
		ApprovalTermsSchema.safeParse({
			...terms,
			conditions: [
				{ kind: "source", path: "source.ts", expectedContent: "x".repeat(30001), reason: "fix" },
			],
		}).success,
		false
	);
	assert.equal(
		ApprovalDraftInputSchema.safeParse({ sessionId: "s", terms, id: "p" }).success,
		false
	);
	const confirmation = { id: "p", revision: 1, digest: "a".repeat(64), confirmed: true };
	assert.ok(ApprovalConfirmInputSchema.safeParse(confirmation).success);
	for (const bad of [
		{ ...confirmation, confirmed: false },
		{ ...confirmation, revision: 0 },
		{ ...confirmation, digest: "partial" },
		{ ...confirmation, headSha: "b".repeat(40) },
	])
		assert.equal(ApprovalConfirmInputSchema.safeParse(bad).success, false);
});

it("bounds aggregate serialized UTF-8 bytes, retaining per-file and condition limits", () => {
	const sources = (content: string, count: number) =>
		Array.from({ length: count }, (_, i) => ({
			kind: "source",
			path: `src/file-${i}.ts`,
			reason: "Exact reviewed fix",
			expectedContent: content,
		}));
	const parse = (conditions: unknown[]) => ApprovalTermsSchema.safeParse({ ...terms, conditions });
	assert.ok(parse(sources("x".repeat(30000), 4)).success);
	assert.equal(parse(sources("x".repeat(30000), 5)).success, false);
	// Character count fits, UTF-8 bytes do not. Escaping also counts in the JSON budget.
	assert.equal(parse(sources("é".repeat(23000), 3)).success, false);
	assert.equal(parse(sources("\n".repeat(23000), 3)).success, false);
	assert.equal(parse(sources("x".repeat(30001), 1)).success, false);
	assert.equal(parse(sources("", 11)).success, false);
});

it("accepts exactly 128 KiB of canonical JSON and rejects the next UTF-8 byte", () => {
	const conditions = Array.from({ length: 5 }, (_, i) => ({
		kind: "source",
		path: `file-${i}.ts`,
		reason: "Exact reviewed source",
		expectedContent: i < 4 ? "x".repeat(30000) : "",
	}));
	const value = { ...terms, conditions };
	const last = conditions[4];
	assert.ok(last);
	last.expectedContent = "x".repeat(
		APPROVAL_TERMS_MAX_BYTES - Buffer.byteLength(JSON.stringify(value))
	);
	assert.equal(Buffer.byteLength(JSON.stringify(value)), APPROVAL_TERMS_MAX_BYTES);
	assert.ok(ApprovalTermsSchema.safeParse(value).success);
	last.expectedContent += "x";
	assert.equal(ApprovalTermsSchema.safeParse(value).success, false);
});
