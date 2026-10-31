// Public controlled test data. Real Git setup is invoked only by the root native run.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const cp = require("node:child_process");
const { join } = require("node:path");
const REPO = "executive-smoke/controlled-repository";
const TICKET_ID = "executive-smoke-owned-ticket";
const TICKET = "SMOKE-46";
const TITLE = "CONTROLLED coding-provider regression";
const SOURCE = "src/value.cjs";
const BASE = "module.exports = { value: 1 };\n";
const FINAL = "module.exports = { value: 3 };\n";
const QUESTION = "Should this ticket use the value three?";
const ANSWER = "Use three, preserve the existing CommonJS convention, and run the declared test.";
const BRIEF =
	"CONTROLLED TEST ONLY: confirm whether to use three, then change src/value.cjs from one to three. Preserve CommonJS and run npm run test. Only edit the isolated worktree.";
const NOW = "2026-10-31T14:00:00Z";
const META = "https://api.meta.ai/v1/responses";
const LINEAR = "https://api.linear.app/graphql";
function git(cwd, ...args) {
	return cp.execFileSync(
		"git",
		[
			"--no-replace-objects",
			"--no-optional-locks",
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"commit.gpgsign=false",
			"-c",
			"core.fsmonitor=false",
			...args,
		],
		{
			cwd,
			encoding: "utf8",
			timeout: 10000,
			env: {
				PATH: process.env.PATH,
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_TERMINAL_PROMPT: "0",
				GIT_NO_LAZY_FETCH: "1",
				GIT_AUTHOR_NAME: "Controlled coding smoke",
				GIT_AUTHOR_EMAIL: "smoke@example.invalid",
				GIT_COMMITTER_NAME: "Controlled coding smoke",
				GIT_COMMITTER_EMAIL: "smoke@example.invalid",
				GIT_AUTHOR_DATE: NOW,
				GIT_COMMITTER_DATE: NOW,
			},
		}
	);
}
function create(root) {
	const localPath = join(root, "original");
	fs.mkdirSync(localPath);
	fs.mkdirSync(join(localPath, "src"));
	git(localPath, "init", "--initial-branch=main");
	fs.writeFileSync(join(localPath, SOURCE), BASE);
	fs.writeFileSync(
		join(localPath, "README.md"),
		"# CONTROLLED test only\nUse CommonJS and npm run test.\n"
	);
	fs.writeFileSync(
		join(localPath, "AGENTS.md"),
		"Keep CommonJS in src/. Ask before choosing the product value. Run npm run test. Do not change package scripts.\n"
	);
	fs.writeFileSync(
		join(localPath, "package.json"),
		JSON.stringify({
			name: "controlled-coding-provider",
			version: "1.0.0",
			private: true,
			packageManager: "npm@10.9.2",
			scripts: { test: "node check.cjs" },
		})
	);
	fs.writeFileSync(
		join(localPath, "check.cjs"),
		`const assert=require('node:assert/strict');assert.equal(require('./src/value.cjs').value,3);for(const key of ['MODEL_API_KEY','META_API_KEY','GITHUB_TOKEN','LINEAR_API_KEY','NODE_OPTIONS'])assert.equal(process.env[key],undefined);console.log('EXECUTIVE_DECLARED_CHECK_PASS');\n`
	);
	git(localPath, "add", "--", "AGENTS.md", "README.md", "package.json", "check.cjs", SOURCE);
	git(localPath, "commit", "-m", "CONTROLLED baseline");
	const baseSha = git(localPath, "rev-parse", "HEAD").trim();
	git(localPath, "remote", "add", "origin", `https://github.com/${REPO}.git`);
	const dirty = "module.exports = { value: 99 }; // CONTROLLED unsaved original\n";
	fs.writeFileSync(join(localPath, SOURCE), dirty);
	return { localPath, baseSha, dirty, status: git(localPath, "status", "--porcelain=v1") };
}
function github(address, method) {
	assert.equal(method, "GET", "No GitHub writes are authorized");
	const url = new URL(address);
	assert.equal(url.origin, "https://api.github.com");
	const repo = { full_name: REPO, default_branch: "main", private: true };
	if (url.pathname === "/user")
		return {
			id: 9001,
			login: "executive-reviewer",
			name: "CONTROLLED reviewer",
			avatar_url:
				"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=",
		};
	if (url.pathname === "/user/repos") return [repo];
	if (url.pathname === `/repos/${REPO}`) return repo;
	if (url.pathname === `/repos/${REPO}/pulls`) return [];
	if (url.pathname === "/search/issues") {
		assert.ok(url.searchParams.get("q").startsWith(`repo:${REPO} is:pr is:open `));
		return { total_count: 0, incomplete_results: false, items: [] };
	}
	throw new Error("Unexpected controlled GitHub read");
}
const page = (nodes) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
const workflow = (type) => ({ id: `controlled-${type}`, name: type, type });
function ticket(type) {
	return {
		id: TICKET_ID,
		identifier: TICKET,
		title: TITLE,
		description: "CONTROLLED TEST ONLY: ask whether to use three.",
		url: "https://linear.app/controlled/issue/SMOKE-46",
		updatedAt: NOW,
		state: workflow(type),
		priority: 2,
		team: { id: "controlled-team", name: "Controlled team" },
		project: null,
		assignee: { id: "controlled-viewer", name: "Controlled viewer" },
	};
}
function linear(body, state) {
	const { query, variables = {} } = body;
	if (/\bHubViewer\b/.test(query))
		return { data: { viewer: { id: "controlled-viewer", name: "Controlled viewer" } } };
	if (/\bHubTickets\b/.test(query)) {
		assert.equal(variables.filter.assignee.id.eq, "controlled-viewer");
		return { data: { issues: page([ticket(state.type)]) } };
	}
	if (/\bHubTicket\b/.test(query)) {
		assert.ok([TICKET_ID, TICKET].includes(variables.id));
		return { data: { issue: ticket(state.type) } };
	}
	if (/\bHubTeams\b/.test(query))
		return {
			data: { teams: page([{ id: "controlled-team", name: "Controlled team", key: "SMOKE" }]) },
		};
	if (/\bHubProjects\b/.test(query)) return { data: { projects: page([]) } };
	if (/\bHubStates\b/.test(query))
		return {
			data: {
				workflowStates: page([
					{ ...workflow(variables.type), position: 0, team: { id: "controlled-team" } },
				]),
			},
		};
	if (/\bHubUpdateState\b/.test(query)) {
		assert.equal(variables.id, TICKET_ID);
		const type = ["started", "unstarted", "completed"].find(
			(value) => workflow(value).id === variables.stateId
		);
		assert.ok(type);
		assert.notEqual(type, "completed", "Readiness must not complete a Linear ticket");
		state.type = type;
		state.updates.push(type);
		return { data: { issueUpdate: { success: true, issue: ticket(type) } } };
	}
	throw new Error("Unexpected controlled Linear operation");
}
module.exports = {
	REPO,
	TICKET_ID,
	TICKET,
	TITLE,
	SOURCE,
	BASE,
	FINAL,
	QUESTION,
	ANSWER,
	BRIEF,
	META,
	LINEAR,
	git,
	create,
	github,
	linear,
};
