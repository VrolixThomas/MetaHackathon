// Controlled HTTP fixtures only. Importing creates no repository, socket, app or provider request.
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const source = require("../pr-work-smoke-support.cjs");
const AUTH_ORIGIN = "https://controlled-team-auth.example";
const TEAM_ORIGIN = "https://controlled-team-service.example";
const ORG = "10000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000001";
const OTHER_USER = "00000000-0000-4000-8000-000000000002";
const PROPOSAL = "40000000-0000-4000-8000-000000000001";
const DECISION = "50000000-0000-4000-8000-000000000001";
const VERSION = "controlled-native-team-v1";
const SECRET = {
	github: "controlled-team-github-token",
	access: "controlled-team-access-token",
	refresh: "controlled-team-refresh-token",
	publishable: "sb_publishable_controlled_team",
	model: "controlled-team-dummy-model-key",
};
const canonical = (value) =>
	value === null || typeof value !== "object"
		? JSON.stringify(value)
		: Array.isArray(value)
			? `[${value.map(canonical).join(",")}]`
			: `{${Object.keys(value)
					.sort()
					.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
					.join(",")}}`;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const digest = (value) => sha(canonical(value));
const blob = (text) => ({ text, sha256: sha(text) });
function prepared(fixture) {
	return {
		id: "controlled-shared-prepared-review",
		version: 1,
		pr: {
			id: source.prId,
			repository: source.repository,
			number: 7,
			title: "CONTROLLED TEST ONLY: prepared PR comment",
			author: "controlled-pr-author",
			url: source.prURL,
			baseSha: fixture.baseSha,
			headSha: fixture.headSha,
		},
		createdAt: "2026-11-01T00:00:00Z",
		summary: "CONTROLLED SHARED REVIEW REUSED WITHOUT A LOCAL MODEL CALL",
		orderRationale: "Controlled shared order",
		files: source.order.map((path) => ({
			path,
			reason: `Controlled shared explanation for ${path}`,
			summary: "Shared inferred analysis",
			suggestedComments: [],
		})),
		coverage: "complete",
		evidence: "inferred-from-github",
	};
}
function makeBundle(fixture, key) {
	const files = [
		{
			path: source.order[1],
			before: blob(source.head[source.order[1]]),
			after: blob(
				source.head[source.order[1]].replace("quote.discount;", "Math.max(0, quote.discount);")
			),
		},
	];
	return {
		key,
		feedback: {
			kind: "pull-review-comment",
			id: "9",
			revision: "2026-11-01T00:00:00Z",
			body: "CONTROLLED FEEDBACK: preserve the zero-discount case",
			bodyDigest: sha("CONTROLLED FEEDBACK: preserve the zero-discount case"),
		},
		baseSha: fixture.headSha,
		candidateSha: fixture.movedSha,
		files,
		patch: blob(
			`--- a/${source.order[1]}\n+++ b/${source.order[1]}\n@@ -2 +2 @@\n-${source.head[source.order[1]].split("\n")[1]}\n+${files[0].after.text.split("\n")[1]}\n`
		),
		checks: [],
		checksDigest: digest([]),
		sourcesDigest: digest(files),
		provenance: "reported-local-candidate",
	};
}
function createProvider(fixture, { localPreparation = false } = {}) {
	const report = { auth: [], github: [], team: [], decisions: [], publications: [], modelCalls: 0 };
	const review = prepared(fixture);
	let currentReview = localPreparation ? null : review;
	let modelContext;
	let modelAnalysis;
	let readCount = 0;
	const expectedContext = {
		pr: review.pr,
		description: "Test fixture; never live review data.",
		files: fixture.filesAt[fixture.headSha].map((file) => ({
			path: file.filename,
			status: file.status,
			additions: file.additions,
			deletions: file.deletions,
			...(file.patch === undefined ? {} : { patch: file.patch }),
		})),
		truncated: false,
	};
	let key;
	let proposal;
	let decision = null;
	let challenge;
	const author = "101";
	function headers(headers) {
		const h = new Headers(headers);
		assert.equal(h.get("authorization"), `Bearer ${SECRET.access}`);
		assert.equal(h.get("x-github-token"), SECRET.github);
	}
	function selectKey(raw) {
		assert.equal(raw.orgId, ORG);
		assert.equal(raw.repositoryId, "42");
		assert.equal(raw.prNumber, 7);
		assert.equal(raw.baseSha, fixture.baseSha);
		assert.equal(raw.headSha, fixture.headSha);
		assert.equal(raw.analysisVersion, VERSION);
		assert.match(raw.contextDigest, /^[a-f0-9]{64}$/);
		assert.equal(
			raw.contextDigest,
			digest(expectedContext),
			"Shared key must hash the actual controlled GitHub context"
		);
		if (key) assert.deepEqual(raw, key);
		else key = structuredClone(raw);
		const bundle = makeBundle(fixture, key);
		proposal ??= {
			id: PROPOSAL,
			key,
			owner_id: OTHER_USER,
			bundle_digest: digest(bundle),
			created_at: "2026-11-01T00:00:00Z",
			bundle,
		};
		return key;
	}
	const scopeKey = () => {
		assert.ok(key, "Shared prepared review must be used before proposal browsing");
		return key;
	};
	return {
		report,
		review,
		get currentReview() {
			return currentReview;
		},
		model(url, body, rawHeaders) {
			assert.equal(localPreparation, true);
			assert.equal(url.toString(), "https://api.meta.ai/v1/responses");
			assert.equal(new Headers(rawHeaders).get("authorization"), `Bearer ${SECRET.model}`);
			assert.equal(++report.modelCalls, 1);
			assert.equal(body.stream, true);
			assert.deepEqual(
				body.tools.map((tool) => tool.name),
				["submit_prepared_review"]
			);
			modelContext = JSON.parse(body.input[0].content[0].text);
			assert.deepEqual(modelContext, expectedContext);
			const { summary: _summary, orderRationale, files } = review;
			modelAnalysis = {
				summary: "CONTROLLED LOCAL analysis from the supplied pinned source context",
				orderRationale,
				files,
			};
			return `data: ${JSON.stringify({ type: "response.completed", response: { id: "controlled-local-preparation", model: body.model, status: "completed", output: [{ type: "function_call", call_id: "controlled-prepare", name: "submit_prepared_review", status: "completed", arguments: JSON.stringify(modelAnalysis) }] } })}\n\n`;
		},
		expectedContext,
		get proposal() {
			return proposal;
		},
		get decision() {
			return decision;
		},
		authorize(address) {
			const url = new URL(address);
			assert.equal(url.origin, AUTH_ORIGIN);
			assert.equal(url.pathname, "/auth/v1/authorize");
			assert.equal(url.searchParams.get("provider"), "github");
			assert.equal(url.searchParams.get("code_challenge_method"), "s256");
			challenge = url.searchParams.get("code_challenge");
			assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
			const callback = new URL(url.searchParams.get("redirect_to"));
			assert.equal(callback.origin, "http://127.0.0.1:43189");
			assert.match(callback.pathname, /^\/team-auth\/[a-f0-9]{64}$/);
			callback.searchParams.set("code", "controlled-team-auth-code");
			return callback;
		},
		auth(url, body, rawHeaders) {
			const h = new Headers(rawHeaders);
			assert.equal(h.get("apikey"), SECRET.publishable);
			assert.equal(url.pathname, "/auth/v1/token");
			assert.equal(url.searchParams.get("grant_type"), "pkce");
			assert.equal(body.auth_code, "controlled-team-auth-code");
			assert.equal(createHash("sha256").update(body.code_verifier).digest("base64url"), challenge);
			report.auth.push({ path: url.pathname, pkceVerified: true });
			return {
				access_token: SECRET.access,
				refresh_token: SECRET.refresh,
				expires_in: 3600,
				expires_at: Math.floor(Date.now() / 1000) + 3600,
				user: { id: USER, user_metadata: { org_id: "untrusted-not-a-grant" } },
			};
		},
		github(url, method) {
			assert.equal(method, "GET", "No GitHub writes allowed");
			report.github.push(url.pathname);
			if (url.pathname === "/repositories/42") return { id: 42, full_name: source.repository };
			if (url.pathname === "/user") return { id: Number(author), login: review.pr.author };
			if (url.pathname === "/search/issues") {
				assert.equal(url.searchParams.get("q")?.split(" ")[0], `repo:${source.repository}`);
				const items = url.searchParams.get("q").includes("author:")
					? [
							{
								number: 7,
								repository_url: source.apiRoot,
								pull_request: { url: `${source.apiRoot}/pulls/7` },
							},
						]
					: [];
				return { total_count: items.length, incomplete_results: false, items };
			}
			if (url.pathname.endsWith("/pulls/7/comments"))
				return [
					{
						id: 9,
						body: "CONTROLLED FEEDBACK: preserve the zero-discount case",
						html_url: `${source.prURL}#discussion_r9`,
						created_at: "2026-11-01T00:00:00Z",
						updated_at: "2026-11-01T00:00:00Z",
						user: { login: "reviewer" },
						path: source.order[1],
						line: 2,
						original_line: 2,
						side: "RIGHT",
						commit_id: fixture.headSha,
						original_commit_id: fixture.headSha,
					},
				];
			const value = source.githubGET(url.toString(), fixture, fixture.headSha);
			if (url.pathname.endsWith("/pulls/7")) {
				value.user = { id: Number(author), login: review.pr.author };
				value.base.repo = { ...value.base.repo, id: 42 };
			}
			return value;
		},
		team(url, body, rawHeaders) {
			headers(rawHeaders);
			report.team.push({ path: url.pathname, body: structuredClone(body) });
			if (url.pathname === "/v1/organizations")
				return { analysisVersion: VERSION, items: [{ id: ORG, name: "Controlled native team" }] };
			if (url.pathname === "/v1/repositories") {
				assert.equal(body.orgId, ORG);
				return {
					items: [{ orgId: ORG, repositoryId: "42", fullName: source.repository }],
					nextOffset: null,
				};
			}
			if (url.pathname === "/v1/repositories/resolve") {
				assert.equal(body.orgId, ORG);
				assert.equal(body.repositoryId, "42");
				return { orgId: ORG, repositoryId: "42", fullName: source.repository };
			}
			if (url.pathname === "/v1/reviews/read") {
				const selected = selectKey(body.key);
				if (localPreparation && ++readCount === 1) return null;
				assert.ok(currentReview);
				return {
					key: selected,
					review: currentReview,
					digest: digest({ key: selected, review: currentReview }),
				};
			}
			if (url.pathname === "/v1/reviews/publish") {
				assert.equal(localPreparation, true);
				assert.equal(report.modelCalls, 1);
				assert.equal(report.publications.length, 0);
				assert.deepEqual(Object.keys(body).sort(), ["digest", "key", "requestId", "review"]);
				assert.match(body.requestId, /^[a-f0-9-]{36}$/);
				selectKey(body.key);
				assert.equal(body.digest, digest({ key, review: body.review }));
				const expectedId = `review-${sha(JSON.stringify([sha(JSON.stringify(modelContext)), modelAnalysis]))}`;
				assert.equal(body.review.id, expectedId);
				assert.equal(new Date(body.review.createdAt).toISOString(), body.review.createdAt);
				assert.deepEqual(body.review, {
					id: expectedId,
					version: 1,
					pr: expectedContext.pr,
					createdAt: body.review.createdAt,
					...modelAnalysis,
					coverage: "complete",
					evidence: "inferred-from-github",
				});
				currentReview = structuredClone(body.review);
				report.publications.push(structuredClone(body));
				return {
					key,
					review: currentReview,
					digest: body.digest,
					provenance: "reported-local-analysis",
					preparedBy: USER,
				};
			}
			if (
				localPreparation &&
				["/v1/reviews/request", "/v1/reviews/status", "/v1/reviews/retry"].includes(url.pathname)
			)
				assert.fail("Local preparation must not enqueue or poll a hosted worker");
			if (url.pathname === "/v1/reviews/status") {
				selectKey(body.key);
				return { status: "ready", attempts: 1, errorCode: null };
			}
			if (url.pathname === "/v1/progress/read") return null;
			if (url.pathname === "/v1/progress/write")
				return { ...body.progress, revision: body.expectedRevision + 1 };
			if (url.pathname === "/v1/proposals/browse") {
				if (!key) return { items: [], nextOffset: null };
				scopeKey();
				assert.equal(body.orgId, ORG);
				assert.equal(body.repositoryId, "42");
				const { bundle: _bundle, ...summary } = proposal;
				return { items: [{ ...summary, decision }], nextOffset: null };
			}
			if (url.pathname === "/v1/proposals/get") {
				scopeKey();
				assert.equal(body.proposalId, PROPOSAL);
				return { ...proposal, decision };
			}
			if (url.pathname === "/v1/proposals/authorize-apply") {
				selectKey(body.key);
				assert.equal(body.proposalId, PROPOSAL);
				assert.equal(body.bundleDigest, proposal.bundle_digest);
				assert.equal(body.confirmed, true);
				assert.equal(decision?.decision, "accept");
				return { proposal: { ...proposal, decision }, decision, userId: USER };
			}
			if (url.pathname === "/v1/proposals/decide") {
				selectKey(body.key);
				assert.equal(body.proposalId, PROPOSAL);
				assert.equal(body.bundleDigest, proposal.bundle_digest);
				assert.equal(body.confirmed, true);
				assert.ok(["accept", "decline"].includes(body.decision));
				if (decision) {
					assert.equal(body.requestId, decision.request_id);
					assert.equal(body.decision, decision.decision);
					return decision;
				}
				decision = {
					id: DECISION,
					proposal_id: PROPOSAL,
					bundle_digest: proposal.bundle_digest,
					author_id: USER,
					github_author_id: author,
					decision: body.decision,
					request_id: body.requestId,
					created_at: new Date().toISOString(),
				};
				report.decisions.push(structuredClone(decision));
				return decision;
			}
			throw new Error(`Unexpected controlled team endpoint: ${url.pathname}`);
		},
	};
}
function selfCheck() {
	const fixture = {
		baseSha: "a".repeat(40),
		headSha: "b".repeat(40),
		movedSha: "c".repeat(40),
		filesAt: {
			["b".repeat(40)]: source.order.map((filename) => ({
				filename,
				status: "modified",
				additions: 1,
				deletions: 1,
				patch: "@@ -1 +1 @@\n-old\n+new",
			})),
		},
	};
	const provider = createProvider(fixture);
	const key = {
		orgId: ORG,
		repositoryId: "42",
		prNumber: 7,
		baseSha: fixture.baseSha,
		headSha: fixture.headSha,
		contextDigest: digest(provider.expectedContext),
		analysisVersion: VERSION,
	};
	const h = { authorization: `Bearer ${SECRET.access}`, "x-github-token": SECRET.github };
	const artifact = provider.team(new URL(`${TEAM_ORIGIN}/v1/reviews/read`), { key }, h);
	assert.equal(artifact.digest, digest({ key, review: artifact.review }));
	const bundle = provider.proposal.bundle;
	assert.equal(bundle.sourcesDigest, digest(bundle.files));
	assert.equal(bundle.patch.sha256, sha(bundle.patch.text));
	assert.equal(provider.proposal.bundle_digest, digest(bundle));
	assert.throws(() =>
		provider.team(new URL(`${TEAM_ORIGIN}/v1/organizations`), {}, { authorization: "Bearer wrong" })
	);
	assert.throws(() =>
		provider.team(
			new URL(`${TEAM_ORIGIN}/v1/proposals/decide`),
			{
				key,
				proposalId: PROPOSAL,
				bundleDigest: "0".repeat(64),
				confirmed: true,
				decision: "accept",
			},
			h
		)
	);
	const local = createProvider(fixture, { localPreparation: true });
	assert.equal(local.team(new URL(`${TEAM_ORIGIN}/v1/reviews/read`), { key }, h), null);
	const events = local.model(
		new URL("https://api.meta.ai/v1/responses"),
		{
			model: "muse-wonder-1.0",
			stream: true,
			tools: [{ name: "submit_prepared_review" }],
			input: [
				{
					role: "user",
					content: [{ type: "input_text", text: JSON.stringify(local.expectedContext) }],
				},
			],
		},
		{ authorization: `Bearer ${SECRET.model}` }
	);
	const terminal = JSON.parse(events.trim().slice("data: ".length));
	assert.equal(terminal.type, "response.completed");
	const analysis = JSON.parse(terminal.response.output[0].arguments);
	assert.deepEqual(
		analysis.files.map((file) => file.path),
		source.order
	);
	const localReview = {
		id: `review-${sha(JSON.stringify([sha(JSON.stringify(local.expectedContext)), analysis]))}`,
		version: 1,
		pr: local.expectedContext.pr,
		createdAt: "2026-11-01T00:00:00.000Z",
		...analysis,
		coverage: "complete",
		evidence: "inferred-from-github",
	};
	const submission = {
		requestId: "60000000-0000-4000-8000-000000000001",
		key,
		review: localReview,
		digest: digest({ key, review: localReview }),
	};
	const publishURL = new URL(`${TEAM_ORIGIN}/v1/reviews/publish`);
	assert.throws(() => local.team(publishURL, { ...submission, digest: "0".repeat(64) }, h));
	const wrongBody = { ...localReview, summary: "Changed controlled analysis" };
	assert.throws(() =>
		local.team(
			publishURL,
			{ ...submission, review: wrongBody, digest: digest({ key, review: wrongBody }) },
			h
		)
	);
	assert.throws(() =>
		local.team(publishURL, { ...submission, key: { ...key, headSha: fixture.baseSha } }, h)
	);
	for (const path of ["request", "status", "retry"])
		assert.throws(() => local.team(new URL(`${TEAM_ORIGIN}/v1/reviews/${path}`), { key }, h));
	const published = local.team(publishURL, submission, h);
	assert.equal(published.provenance, "reported-local-analysis");
	assert.equal(published.preparedBy, USER);
	assert.deepEqual(published.review, local.currentReview);
	assert.deepEqual(local.report.publications, [submission]);
	assert.equal(local.report.modelCalls, 1);
	assert.deepEqual(
		local.team(new URL(`${TEAM_ORIGIN}/v1/reviews/read`), { key }, h).review,
		localReview
	);
	assert.equal(provider.report.modelCalls, 0);
	assert.deepEqual(provider.report.publications, []);
	console.log(
		"TEAM_WORKSPACE_PROVIDER_SELF_CHECK_PASS: controlled DTO/digest/header guards only; NO Electron/Git/HTTP/provider/DB launched"
	);
}
module.exports = {
	source,
	AUTH_ORIGIN,
	TEAM_ORIGIN,
	ORG,
	USER,
	OTHER_USER,
	PROPOSAL,
	VERSION,
	SECRET,
	canonical,
	digest,
	createProvider,
	selfCheck,
};
