import assert from "node:assert/strict";
import { it } from "node:test";
import {
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
				{ kind: "source", path: "source.ts", expectedContent: "x".repeat(24000), reason: "fix" },
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
