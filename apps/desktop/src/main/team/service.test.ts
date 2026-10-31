import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { digest, sha256 } from "../../../../../services/team/protocol";
import type { ProposalBundle } from "../../../../../services/team/schemas";
import { TeamService } from "./service";
import { EncryptedTeamStore } from "./storage";
const user = "00000000-0000-4000-8000-000000000001";
const org = "10000000-0000-4000-8000-000000000001";
const settings = {
	url: "https://auth.example",
	publishableKey: "sb_publishable_controlled",
	serviceUrl: "https://team.example",
};
const encryption = {
	isEncryptionAvailable: () => true,
	encryptString: (text: string) => Buffer.from(Buffer.from(text).map((byte) => byte ^ 90)),
	decryptString: (bytes: Buffer) => Buffer.from(bytes.map((byte) => byte ^ 90)).toString(),
};
const blob = (text: string) => ({ text, sha256: sha256(text) });
function candidate(): ProposalBundle {
	const files = [{ path: "a.ts", before: blob("old\n"), after: blob("new\n") }];
	return {
		key: {
			orgId: org,
			repositoryId: "42",
			prNumber: 1,
			baseSha: "a".repeat(40),
			headSha: "b".repeat(40),
			contextDigest: "c".repeat(64),
			analysisVersion: "test-v1",
		},
		baseSha: "b".repeat(40),
		candidateSha: "f".repeat(40),
		feedback: {
			kind: "pull-review-comment",
			id: "9",
			revision: "2026-11-01T00:00:00Z",
			body: "Fix this",
			bodyDigest: sha256("Fix this"),
		},
		files,
		sourcesDigest: digest(files),
		patch: blob("@@ -1 +1 @@\n-old\n+new\n"),
		checks: [],
		checksDigest: digest([]),
		provenance: "reported-local-candidate",
	};
}
async function setup() {
	const directory = await mkdtemp(join(tmpdir(), "muse-team-service-"));
	await new EncryptedTeamStore(
		join(directory, "team", digest(settings).slice(0, 24), "session.bin"),
		encryption
	).write({
		access_token: "supabase-user",
		refresh_token: "refresh",
		expires_at: 2000000000,
		user: { id: user },
	});
	return directory;
}

test("TeamService persists real selected scope, shares only observed exact local candidate, keeps acceptance and apply separate", async () => {
	const directory = await setup();
	let bundle = candidate();
	let shares = 0;
	let applies = 0;
	let rawDecision: Record<string, unknown> | null = null;
	const record = () => ({
		id: "20000000-0000-4000-8000-000000000001",
		key: bundle.key,
		owner_id: user,
		bundle_digest: digest(bundle),
		created_at: "2026-11-01T00:00:00Z",
		bundle,
		decision: rawDecision,
	});
	const transport = (async (raw: unknown, init?: RequestInit) => {
		const path = new URL(String(raw)).pathname;
		const input = JSON.parse(String(init?.body ?? "{}"));
		if (path === "/v1/organizations")
			return Response.json({
				analysisVersion: "test-v1",
				items: [{ id: org, name: "Real response org" }],
			});
		if (path === "/v1/repositories/resolve")
			return Response.json({ orgId: org, repositoryId: "42", fullName: "test/repo" });
		if (path === "/v1/proposals/share") {
			shares++;
			return Response.json(record());
		}
		if (path === "/v1/proposals/get") return Response.json(record());
		if (path === "/v1/proposals/decide") {
			rawDecision = {
				id: randomUUID(),
				proposal_id: input.proposalId,
				bundle_digest: input.bundleDigest,
				decision: input.decision,
				author_id: user,
				github_author_id: "101",
				created_at: "2026-11-01T00:00:01Z",
			};
			return Response.json(rawDecision);
		}
		if (path === "/v1/proposals/authorize-apply")
			return Response.json({ proposal: record(), decision: rawDecision, userId: user });
		throw new Error(`Unexpected controlled route ${path}`);
	}) as typeof fetch;
	const options = {
		directory,
		encryption,
		getSettings: () => settings,
		getGitHubToken: async () => "github-user",
		getAccountRevision: () => 0,
		openExternal: async () => {
			throw new Error("No login in this controlled test");
		},
		fetch: transport,
		readLocalFix: async () => bundle,
		applyProposal: async (
			input: Parameters<
				NonNullable<ConstructorParameters<typeof TeamService>[0]["applyProposal"]>
			>[0]
		) => {
			applies++;
			return {
				status: "applied" as const,
				requestId: input.requestId,
				proposalId: input.proposalId,
				bundleDigest: input.bundleDigest,
				baseSha: input.bundle.baseSha,
				candidateSha: input.bundle.candidateSha,
				appliedHeadSha: "d".repeat(40),
				jobId: "actual-port-job",
			};
		},
	};
	const service = new TeamService(options);
	try {
		assert.equal((await service.status()).connection, "connected");
		const scope = await service.selectScope({ orgId: org, repositoryId: "42" });
		assert.equal(scope.repository, "test/repo");
		const preview = await service.previewProposal({
			candidateId: "local-candidate",
			repository: "test/repo",
		});
		await assert.rejects(
			service.shareProposal({
				candidateId: "local-candidate",
				repository: "test/repo",
				bundleDigest: preview.bundleDigest,
				requestId: randomUUID(),
				confirmed: false,
			})
		);
		const shared = await service.shareProposal({
			candidateId: "local-candidate",
			repository: "test/repo",
			bundleDigest: preview.bundleDigest,
			requestId: randomUUID(),
			confirmed: true,
		});
		assert.equal(shared.status, "recorded");
		assert.equal(shares, 1);
		const id = record().id;
		await service.decideProposal({
			proposalId: id,
			repository: "test/repo",
			bundleDigest: preview.bundleDigest,
			requestId: randomUUID(),
			decision: "accept",
			confirmed: true,
		});
		assert.equal(applies, 0);
		const apply = {
			proposalId: id,
			repository: "test/repo",
			bundleDigest: preview.bundleDigest,
			requestId: randomUUID(),
			confirmed: true,
		};
		const result = await service.applyProposal(apply);
		assert.equal(result.status, "applied");
		assert.equal(result.jobId, "actual-port-job");
		await service.applyProposal(apply);
		assert.equal(applies, 1);
		service.dispose();
		const reopened = new TeamService(options);
		assert.equal((await reopened.scopeForRepository("test/repo"))?.orgId, org);
		assert.equal((await reopened.applyProposal(apply)).status, "applied");
		assert.equal(applies, 1);
		reopened.dispose();
		// A fresh local read that differs from the reviewed digest is rejected before sharing.
		bundle = { ...bundle, feedback: { ...bundle.feedback, revision: "2026-11-01T00:00:02Z" } };
		const changed = new TeamService(options);
		await assert.rejects(
			changed.shareProposal({
				candidateId: "local-candidate",
				repository: "test/repo",
				bundleDigest: preview.bundleDigest,
				requestId: randomUUID(),
				confirmed: true,
			})
		);
		assert.equal(shares, 1);
		changed.dispose();
	} finally {
		service.dispose();
		await rm(directory, { recursive: true, force: true });
	}
});

test("unconfigured TeamService reports absence and cannot invent organizations", async () => {
	const directory = await mkdtemp(join(tmpdir(), "muse-team-unconfigured-"));
	const service = new TeamService({
		directory,
		encryption,
		getSettings: () => ({}),
		getGitHubToken: async () => undefined,
		getAccountRevision: () => 0,
		openExternal: async () => {},
	});
	try {
		assert.equal((await service.status()).connection, "unconfigured");
		await assert.rejects(service.organizations());
	} finally {
		service.dispose();
		await rm(directory, { recursive: true, force: true });
	}
});
