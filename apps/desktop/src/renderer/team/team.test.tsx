import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TeamCard } from "./TeamCard";
import { type TeamCall, createTeamController } from "./controller";
const user = "00000000-0000-4000-8000-000000000001";
const org = "10000000-0000-4000-8000-000000000001";
const key = {
	orgId: org,
	repositoryId: "42",
	prNumber: 1,
	baseSha: "a".repeat(40),
	headSha: "b".repeat(40),
	contextDigest: "c".repeat(64),
	analysisVersion: "test-v1",
};
const blob = (text: string) => ({ text, sha256: "d".repeat(64) });
const bundle = {
	key,
	baseSha: key.headSha,
	candidateSha: "f".repeat(40),
	feedback: {
		kind: "pull-review-comment" as const,
		id: "9",
		revision: "2026-11-01T00:00:00Z",
		body: "Exact feedback",
		bodyDigest: "d".repeat(64),
	},
	files: [{ path: "a.ts", before: blob("<script>old</script>\n"), after: blob("new\n") }],
	sourcesDigest: "d".repeat(64),
	patch: blob("-old\n+new\n"),
	checks: [],
	checksDigest: "d".repeat(64),
	provenance: "reported-local-candidate" as const,
};
const detail = {
	id: "20000000-0000-4000-8000-000000000001",
	key,
	ownerId: user,
	bundleDigest: "d".repeat(64),
	createdAt: "2026-11-01T00:00:00Z",
	bundle,
	decision: null,
};
const status = {
	configured: true,
	connection: "connected" as const,
	userId: user,
	scopes: [{ orgId: org, repositoryId: "42", repository: "test/repo", analysisVersion: "test-v1" }],
	canApply: true,
	canShare: true,
	error: null,
};
test("TeamCard renders real controller data, exact escaped sources and separate disabled confirmation actions", () => {
	const controller = createTeamController(async () => {
		throw new Error("SSR never calls providers");
	});
	controller.store.setState({
		status,
		organizations: [{ id: org, name: "Controlled response organization" }],
		orgId: org,
		repositories: [{ orgId: org, repositoryId: "42", fullName: "test/repo" }],
		detail,
	});
	controller.store.getInitialState = controller.store.getState;
	const html = renderToStaticMarkup(
		createElement(TeamCard, { controller, repository: "test/repo" })
	);
	assert.match(html, /Controlled response organization/);
	assert.match(html, /&lt;script&gt;old&lt;\/script&gt;/);
	assert.ok(!html.includes("<script>old"));
	assert.match(html, /data-team-source-side="before"/);
	assert.match(html, /data-team-source-side="after"/);
	assert.match(html, /Exact patch/);
	assert.match(html, /Muse prepares reviews locally/);
	assert.match(html, /Local findings sharing selected/);
	assert.ok(!html.includes("GitHub App"));
	assert.ok(!html.includes("Use shared preparation"));
	assert.match(html, /Accept proposal/);
	assert.ok(!html.includes("Apply accepted fix locally"));
	controller.dispose();
});

test("repository registration omits installation ID and selected scope explicitly opts into local findings sharing", async () => {
	const calls: { path: string; input: unknown }[] = [];
	const scope = status.scopes[0];
	assert.ok(scope);
	const controller = createTeamController(async (_type, path, input) => {
		calls.push({ path, input });
		if (path === "team.registerRepository")
			return { orgId: org, repositoryId: "42", fullName: "test/repo" };
		if (path === "team.repositories") return { items: [], nextOffset: null };
		if (path === "team.selectScope") return scope;
		if (path === "team.proposals") return { items: [], nextOffset: null };
		throw new Error(`Unexpected controlled RPC ${path}`);
	});
	try {
		controller.store.setState({ status: { ...status, scopes: [] }, orgId: org });
		await controller.registerRepository("test/repo");
		const registration = calls.find((c) => c.path === "team.registerRepository")?.input as Record<
			string,
			unknown
		>;
		assert.equal(registration["repository"], "test/repo");
		assert.equal(Object.hasOwn(registration, "installationId"), false);
		assert.equal(controller.store.getState().status?.scopes.length, 0);
		await controller.selectScope(org, "42");
		assert.deepEqual(controller.store.getState().status?.scopes, [scope]);
	} finally {
		controller.dispose();
	}
});
test("controller requires exact confirmation and never applies on author acceptance", async () => {
	const calls: { path: string; input: unknown }[] = [];
	const decision = {
		id: "30000000-0000-4000-8000-000000000001",
		proposalId: detail.id,
		bundleDigest: detail.bundleDigest,
		decision: "accept" as const,
		authorId: user,
		githubAuthorId: "101",
		createdAt: "2026-11-01T00:00:01Z",
	};
	const call: TeamCall = async (_type, path, input) => {
		calls.push({ path, input });
		if (path === "team.decideProposal") return { status: "recorded", proposal: null, decision };
		if (path === "team.proposals") return { items: [], nextOffset: null };
		throw new Error("Unexpected controlled RPC");
	};
	const controller = createTeamController(call);
	controller.store.setState({ status, detail, activeRepository: "test/repo" });
	await controller.decideProposal("accept", false);
	assert.equal(calls.length, 0);
	await controller.decideProposal("accept", true);
	assert.equal(calls.filter((c) => c.path === "team.decideProposal").length, 1);
	assert.equal(calls.filter((c) => c.path === "team.applyProposal").length, 0);
	assert.equal(controller.store.getState().detail?.decision?.decision, "accept");
	controller.dispose();
});

test("pending proposal read cannot repopulate the card or clear an active logout after account retirement", async () => {
	let resolveRead: ((value: unknown) => void) | undefined;
	let resolveLogout: ((value: unknown) => void) | undefined;
	const controller = createTeamController(async (_type, path) => {
		if (path === "team.readProposal")
			return new Promise((resolve) => {
				resolveRead = resolve;
			});
		if (path === "team.logout")
			return new Promise((resolve) => {
				resolveLogout = resolve;
			});
		throw new Error("Unexpected controlled path");
	});
	controller.store.setState({ status, activeRepository: "test/repo" });
	const read = controller.readProposal(detail.id);
	assert.ok(resolveRead);
	const logout = controller.logout();
	assert.ok(resolveLogout);
	resolveRead(detail);
	await read;
	assert.equal(controller.store.getState().detail, null);
	assert.equal(controller.store.getState().busy, "logout");
	resolveLogout({ ...status, connection: "disconnected", userId: null, scopes: [] });
	await logout;
	assert.equal(controller.store.getState().status?.connection, "disconnected");
	controller.dispose();
});
test("controller startup resolves current context, real org/repo responses and private conflicts without fixture defaults", async () => {
	const controller = createTeamController(async (_type, path) => {
		if (path === "team.status") return status;
		if (path === "team.organizations")
			return {
				analysisVersion: "test-v1",
				items: [{ id: org, name: "Actual controlled response" }],
			};
		if (path === "team.repositories")
			return {
				items: [{ orgId: org, repositoryId: "42", fullName: "test/repo" }],
				nextOffset: null,
			};
		if (path === "team.proposals")
			return {
				items: [
					{
						id: detail.id,
						key: detail.key,
						ownerId: detail.ownerId,
						bundleDigest: detail.bundleDigest,
						createdAt: detail.createdAt,
						decision: null,
					},
				],
				nextOffset: null,
			};
		if (path === "team.progressConflicts") return [];
		throw new Error(`Unexpected ${path}`);
	});
	controller.setContext({ repository: "test/repo", prNumber: 1 });
	await controller.start();
	assert.equal(controller.store.getState().status?.connection, "connected");
	assert.equal(controller.store.getState().organizations[0]?.name, "Actual controlled response");
	assert.equal(controller.store.getState().repositories[0]?.fullName, "test/repo");
	assert.equal(controller.store.getState().proposals[0]?.id, detail.id);
	controller.dispose();
});
