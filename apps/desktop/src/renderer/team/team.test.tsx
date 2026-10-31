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
	assert.match(html, /Accept proposal/);
	assert.ok(!html.includes("Apply accepted fix locally"));
	controller.dispose();
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
