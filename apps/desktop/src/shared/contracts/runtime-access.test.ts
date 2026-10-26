import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	CredentialProviderSchema,
	type CredentialStatus,
	CredentialStatusListSchema,
	CredentialStatusSchema,
	RemoveCredentialInputSchema,
	SetCredentialInputSchema,
	type SourceFile,
	type SourceFileRequest,
	SourceFileRequestSchema,
	SourceFileSchema,
} from ".";

describe("renderer credential contracts", () => {
	it("round-trips provider status rows compatible with the settings adapter", () => {
		const rows: CredentialStatus[] = CredentialProviderSchema.options.map((provider) => ({
			provider,
			configured: provider === "github",
			storage: "os-encrypted",
		}));
		assert.deepEqual(CredentialStatusListSchema.parse(JSON.parse(JSON.stringify(rows))), rows);
		assert.deepEqual(CredentialStatusListSchema.parse([]), []);
		assert.equal(CredentialStatusListSchema.safeParse([rows[0], rows[0]]).success, false);
		assert.equal(CredentialStatusListSchema.safeParse([...rows, rows[0]]).success, false);
		assert.equal(
			CredentialStatusListSchema.safeParse({
				github: { configured: true, storage: "os-encrypted" },
			}).success,
			false
		);
	});

	it("rejects secret-returning fields, unknown providers and unsupported storage", () => {
		const status = { provider: "meta", configured: true, storage: "os-encrypted" };
		for (const field of ["secret", "value", "token", "encrypted", "path"]) {
			assert.equal(
				CredentialStatusSchema.safeParse({ ...status, [field]: "test-only-value" }).success,
				false
			);
		}
		for (const change of [
			{ provider: "unknown" },
			{ provider: "GitHub" },
			{ configured: "true" },
			{ configured: undefined },
			{ storage: "plaintext" },
			{ storage: "test-only-secret" },
		]) {
			assert.equal(CredentialStatusSchema.safeParse({ ...status, ...change }).success, false);
		}
	});

	it("bounds raw credential input before trimming and rejects blank or non-string values", () => {
		for (const provider of CredentialProviderSchema.options) {
			const input = SetCredentialInputSchema.parse({ provider, secret: " \t test-only-key \n" });
			assert.deepEqual(input, { provider, secret: "test-only-key" });
			assert.deepEqual(SetCredentialInputSchema.parse(JSON.parse(JSON.stringify(input))), input);
		}
		assert.equal(
			SetCredentialInputSchema.parse({ provider: "meta", secret: "x".repeat(16_384) }).secret
				.length,
			16_384
		);
		for (const secret of ["", " \t\r\n", "x".repeat(16_385), `${" ".repeat(16_384)}x`, null, 42]) {
			assert.equal(SetCredentialInputSchema.safeParse({ provider: "meta", secret }).success, false);
		}
		assert.equal(
			SetCredentialInputSchema.safeParse({ provider: "meta", value: "test-only-key" }).success,
			false
		);
		assert.equal(
			SetCredentialInputSchema.safeParse({
				provider: "meta",
				secret: "test-only-key",
				path: "keys",
			}).success,
			false
		);
	});

	it("only accepts a known provider when removing credentials", () => {
		for (const provider of CredentialProviderSchema.options) {
			const input = { provider };
			assert.deepEqual(RemoveCredentialInputSchema.parse(JSON.parse(JSON.stringify(input))), input);
		}
		for (const input of [
			{},
			{ provider: "unknown" },
			{ provider: "github", secret: "test-only-key" },
		]) {
			assert.equal(RemoveCredentialInputSchema.safeParse(input).success, false);
		}
		assert.equal(
			SetCredentialInputSchema.safeParse({ provider: "unknown", secret: "test-only-key" }).success,
			false
		);
	});
});

const request: SourceFileRequest = {
	prId: "example/review#1",
	revision: "head",
	path: "src/checkout.ts",
};
const source: SourceFile = {
	...request,
	repository: "example/review",
	commitSha: "2".repeat(40),
	content: '\n  const label = "☕";\r\n\n\treturn label;\n',
};

describe("pinned source-file contracts", () => {
	it("round-trips each revision and preserves all whitespace and original line positions", () => {
		for (const revision of ["base", "head"] as const) {
			const input = { ...request, revision };
			assert.deepEqual(SourceFileRequestSchema.parse(JSON.parse(JSON.stringify(input))), input);
			const file = { ...source, revision };
			const parsed = SourceFileSchema.parse(JSON.parse(JSON.stringify(file)));
			assert.deepEqual(parsed, file);
			assert.deepEqual(parsed.content?.split("\n"), [
				"",
				'  const label = "☕";\r',
				"",
				"\treturn label;",
				"",
			]);
		}
	});

	it("distinguishes an empty file from an absent file without inventing source text", () => {
		for (const content of ["", null]) {
			const file = { ...source, content };
			assert.deepEqual(SourceFileSchema.parse(JSON.parse(JSON.stringify(file))), file);
		}
		for (const content of [undefined, [], { text: "source" }]) {
			assert.equal(SourceFileSchema.safeParse({ ...source, content }).success, false);
		}
		const maximum = "x".repeat(1_000_000);
		assert.equal(SourceFileSchema.parse({ ...source, content: maximum }).content, maximum);
		assert.equal(SourceFileSchema.safeParse({ ...source, content: `${maximum}x` }).success, false);
	});

	it("rejects filesystem roots, command options, arbitrary revisions and partial-file requests", () => {
		for (const extra of [
			{ repository: "other/repository" },
			{ repositoryPath: "/tmp/repository" },
			{ cwd: "/tmp/repository" },
			{ commitSha: "3".repeat(40) },
			{ ref: "HEAD" },
			{ command: "git" },
			{ args: ["show", "HEAD:src/checkout.ts"] },
			{ startLine: 2, endLine: 4 },
		]) {
			assert.equal(SourceFileRequestSchema.safeParse({ ...request, ...extra }).success, false);
		}
		for (const revision of ["HEAD", "main", "before", "2".repeat(40), null]) {
			assert.equal(SourceFileRequestSchema.safeParse({ ...request, revision }).success, false);
			assert.equal(SourceFileSchema.safeParse({ ...source, revision }).success, false);
		}
		assert.equal(SourceFileSchema.safeParse({ ...source, cwd: "/tmp/repository" }).success, false);
		assert.equal(SourceFileSchema.safeParse({ ...source, truncated: true }).success, false);
	});

	it("requires safe shared paths, PR/repository identity and full pinned commit SHAs", () => {
		for (const path of [
			"",
			"/etc/passwd",
			"../key",
			"src/../key",
			"./src/a.ts",
			"src\\a.ts",
			"a//b",
			"a\0b",
		]) {
			assert.equal(SourceFileRequestSchema.safeParse({ ...request, path }).success, false);
			assert.equal(SourceFileSchema.safeParse({ ...source, path }).success, false);
		}
		for (const prId of [undefined, "", " ", null]) {
			assert.equal(SourceFileRequestSchema.safeParse({ ...request, prId }).success, false);
			assert.equal(SourceFileSchema.safeParse({ ...source, prId }).success, false);
		}
		for (const commitSha of [undefined, "HEAD", "123abcd", "g".repeat(40)]) {
			assert.equal(SourceFileSchema.safeParse({ ...source, commitSha }).success, false);
		}
		assert.equal(SourceFileSchema.safeParse({ ...source, repository: "" }).success, false);
		assert.equal(SourceFileSchema.safeParse({ ...source, repository: undefined }).success, false);
		const spacedPath = "src/ space ☕ .ts";
		assert.equal(SourceFileRequestSchema.parse({ ...request, path: spacedPath }).path, spacedPath);
	});
});
