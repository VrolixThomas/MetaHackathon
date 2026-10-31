// Controlled provider/fixture support. Import and --self-check never launch Git or a worker.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const cp = require("node:child_process");
const { randomUUID, createHash } = require("node:crypto");
const { join } = require("node:path");
const REPOSITORY = "pr-fix-smoke/controlled-repository";
const VIEWER = "pr-fix-reviewer";
const PR_ID = `${REPOSITORY}#8`;
const FEEDBACK_ID = `${PR_ID}:inline:8801`;
const TITLE = "Handle empty values consistently";
const FEEDBACK =
	"Please use value three in both exports, preserving CommonJS and the declared check.";
const NOW = "2026-10-31T12:00:00.000Z";
const MODEL = "https://api.meta.ai/v1/responses";
const FILES = ["src/first.cjs", "src/second.cjs"];
const text = (value) => `module.exports = { value: ${value} };\n`;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
function git(cwd, ...args) {
	assert.ok(!args.some((arg) => ["push", "merge"].includes(arg)), "Publication/merge forbidden");
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
			timeout: 15000,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				PATH: process.env.PATH,
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_TERMINAL_PROMPT: "0",
				GIT_NO_LAZY_FETCH: "1",
				GIT_AUTHOR_NAME: "Controlled fix smoke",
				GIT_AUTHOR_EMAIL: "smoke@example.invalid",
				GIT_COMMITTER_NAME: "Controlled fix smoke",
				GIT_COMMITTER_EMAIL: "smoke@example.invalid",
				GIT_AUTHOR_DATE: NOW,
				GIT_COMMITTER_DATE: NOW,
			},
		}
	);
}
function createRepository(root) {
	const localPath = join(root, "original");
	fs.mkdirSync(localPath);
	git(localPath, "init", "--initial-branch=main");
	git(localPath, "config", "user.name", "Controlled fix smoke");
	git(localPath, "config", "user.email", "smoke@example.invalid");
	fs.mkdirSync(join(localPath, "src"));
	fs.writeFileSync(
		join(localPath, "README.md"),
		"# Controlled PR fix\nPreserve CommonJS; run npm run test.\n"
	);
	fs.writeFileSync(
		join(localPath, "AGENTS.md"),
		"Use CommonJS and the existing npm run test. Keep package scripts unchanged.\n"
	);
	fs.writeFileSync(
		join(localPath, "package.json"),
		JSON.stringify({
			name: "controlled-pr-fix",
			version: "1.0.0",
			private: true,
			packageManager: "npm@10.9.2",
			scripts: { test: "node check.cjs" },
		})
	);
	fs.writeFileSync(
		join(localPath, "check.cjs"),
		`const assert = require('node:assert/strict');\nfor (const file of ${JSON.stringify(FILES)}) assert.equal(require('./'+file).value,3);\nfor(const key of ['MODEL_API_KEY','META_API_KEY','GITHUB_TOKEN','LINEAR_API_KEY','NODE_OPTIONS','ELECTRON_RUN_AS_NODE']) assert.equal(process.env[key],undefined,key);\nconsole.log('PR_FIX_ACTUAL_CHECK_PASS');\n`
	);
	for (const file of FILES) fs.writeFileSync(join(localPath, file), text(1));
	git(localPath, "add", "--all");
	git(localPath, "commit", "-m", "Controlled original baseline");
	const baseSha = git(localPath, "rev-parse", "HEAD").trim();
	git(localPath, "switch", "-c", "controlled-pr");
	for (const file of FILES) fs.writeFileSync(join(localPath, file), text(2));
	git(localPath, "add", "--all");
	git(localPath, "commit", "-m", "Controlled PR head");
	const headSha = git(localPath, "rev-parse", "HEAD").trim();
	const patches = Object.fromEntries(
		FILES.map((file) => [
			file,
			git(localPath, "diff", "--no-ext-diff", "--no-textconv", baseSha, headSha, "--", file),
		])
	);
	git(localPath, "switch", "main");
	git(localPath, "remote", "add", "origin", `https://github.com/${REPOSITORY}.git`);
	fs.appendFileSync(join(localPath, "README.md"), "Staged author work\n");
	git(localPath, "add", "README.md");
	fs.writeFileSync(
		join(localPath, FILES[0]),
		"module.exports = { value: 99 }; // unsaved author work\n"
	);
	fs.writeFileSync(join(localPath, "personal.txt"), "Untracked author work\n");
	return { localPath, baseSha, headSha, patches, original: originalState(localPath) };
}
function originalState(path) {
	return {
		head: git(path, "rev-parse", "HEAD"),
		status: git(path, "status", "--porcelain=v1", "-z"),
		index: git(path, "diff", "--cached", "--binary"),
		refs: git(path, "show-ref"),
		source: fs.readFileSync(join(path, FILES[0]), "utf8"),
		note: fs.readFileSync(join(path, "personal.txt"), "utf8"),
	};
}
function github(url, method, fixture) {
	assert.equal(method, "GET", "No GitHub writes permitted");
	const u = new URL(url);
	assert.equal(u.origin, "https://api.github.com");
	const root = `/repos/${REPOSITORY}`;
	const metadata = { full_name: REPOSITORY, default_branch: "main", private: true };
	if (u.pathname === "/user") return { id: 4242, login: VIEWER, name: "Controlled reviewer" };
	if (u.pathname === "/user/repos") return [metadata];
	if (u.pathname === root) return metadata;
	if (u.pathname === "/search/issues") {
		const q = u.searchParams.get("q");
		assert.ok(
			[
				`repo:${REPOSITORY} is:pr is:open review-requested:${VIEWER}`,
				`repo:${REPOSITORY} is:pr is:open author:${VIEWER}`,
			].includes(q)
		);
		const own = q.includes("author:");
		return {
			total_count: own ? 1 : 0,
			incomplete_results: false,
			items: own
				? [
						{
							number: 8,
							repository_url: `https://api.github.com${root}`,
							pull_request: { url: `https://api.github.com${root}/pulls/8` },
						},
					]
				: [],
		};
	}
	const pr = {
		number: 8,
		state: "open",
		draft: false,
		html_url: `https://github.com/${REPOSITORY}/pull/8`,
		title: TITLE,
		body: "Controlled local PR-fix acceptance",
		changed_files: 2,
		updated_at: NOW,
		user: { login: VIEWER },
		base: { sha: fixture.baseSha, ref: "main", repo: { full_name: REPOSITORY } },
		head: { sha: fixture.headSha, ref: "controlled-pr", repo: { full_name: REPOSITORY } },
	};
	if (u.pathname === `${root}/pulls`) return [pr];
	if (u.pathname === `${root}/pulls/8`) return pr;
	if (u.pathname === `${root}/pulls/8/reviews` || u.pathname === `${root}/issues/8/comments`)
		return [];
	if (u.pathname === `${root}/pulls/8/comments`)
		return [
			{
				id: 8801,
				body: FEEDBACK,
				user: { login: "controlled-comment-author" },
				html_url: `${pr.html_url}#discussion_r8801`,
				created_at: NOW,
				updated_at: NOW,
				path: FILES[0],
				line: 1,
				original_line: 1,
				side: "RIGHT",
				commit_id: fixture.headSha,
				original_commit_id: fixture.headSha,
			},
		];
	if (u.pathname === `${root}/pulls/8/files`)
		return FILES.map((file) => ({
			filename: file,
			status: "modified",
			additions: 1,
			deletions: 1,
			patch: fixture.patches[file].slice(fixture.patches[file].indexOf("@@")).trimEnd(),
		}));
	if (u.pathname.startsWith(`${root}/contents/`)) {
		const file = decodeURIComponent(u.pathname.slice(`${root}/contents/`.length));
		assert.ok(FILES.includes(file));
		const ref = u.searchParams.get("ref");
		assert.ok([fixture.baseSha, fixture.headSha].includes(ref));
		const content = text(ref === fixture.baseSha ? 1 : 2);
		return {
			path: file,
			type: "file",
			size: Buffer.byteLength(content),
			encoding: "base64",
			content: Buffer.from(content).toString("base64"),
		};
	}
	throw new Error(`Unexpected controlled GitHub path ${u.pathname}`);
}
function sse(body, name, args) {
	assert.equal(body.stream, true);
	assert.equal(body.store, false);
	assert.equal(body.tool_choice, "auto");
	assert.ok(
		body.tools.some((tool) => tool.name === name),
		`Unavailable controlled tool ${name}`
	);
	return new Response(
		`data: ${JSON.stringify({ type: "response.completed", response: { id: `pr-fix-${randomUUID()}`, model: body.model, status: "completed", usage: null, output: [{ type: "function_call", status: "completed", call_id: `pr-fix-${randomUUID()}`, name, arguments: JSON.stringify(args) }] } })}\n\n`,
		{ headers: { "content-type": "text/event-stream" } }
	);
}
function parentModel(body) {
	return sse(body, "submit_prepared_review", {
		summary: "Both actual PR exports change from one to two.",
		orderRationale: "Inspect both actual exported values.",
		files: FILES.map((path) => ({
			path,
			reason: "Changed exported value.",
			summary: "The PR changes this export from one to two.",
			suggestedComments: [],
		})),
	});
}
function childTool(body) {
	const task = JSON.parse(
		body.input.find((item) => item.role === "user" && typeof item.content === "string").content
	);
	assert.equal(task.repository, REPOSITORY);
	assert.equal(task.ticket, null);
	assert.ok(task.brief.includes(FEEDBACK));
	assert.ok(task.brief.includes("untrusted source evidence"));
	const calls = body.input.filter((item) => item.type === "function_call");
	const receipts = new Map(
		body.input
			.filter((item) => item.type === "function_call_output")
			.map((item) => [item.call_id, JSON.parse(item.output)])
	);
	const call = (name, path) =>
		calls.find(
			(item) =>
				item.name === name && (path === undefined || JSON.parse(item.arguments).path === path)
		);
	for (const path of ["AGENTS.md", "README.md", "package.json", ...FILES]) {
		const read = call("read_file", path);
		if (!read) return ["read_file", { path }];
		assert.ok(receipts.get(read.call_id)?.sha256, "Actual read receipt required");
	}
	for (const path of FILES) {
		const source = receipts.get(call("read_file", path).call_id);
		assert.equal(
			source.text,
			text(2),
			"Worker must read pinned PR head, never original dirty checkout"
		);
		const edit = call("edit_file", path);
		if (!edit)
			return [
				"edit_file",
				{ path, oldText: "value: 2", newText: "value: 3", expectedSha256: source.sha256 },
			];
		assert.equal(receipts.get(edit.call_id)?.path, path, "Actual edit receipt required");
	}
	const check = call("run_command");
	if (!check) return ["run_command", { command: "npm", args: ["run", "test"], timeoutMs: 30000 }];
	const actual = receipts.get(check.call_id);
	assert.equal(actual.exitCode, 0);
	assert.equal(actual.interrupted, false);
	assert.ok(actual.stdout.includes("PR_FIX_ACTUAL_CHECK_PASS"));
	return [
		"finish_work",
		{
			summary:
				"Updated both actual exports from two to three to address the original feedback. CommonJS is preserved; the declared npm run test returned exit zero. This is a local candidate for review.",
		},
	];
}
function createChildModelFetch({ gate }) {
	return async (input, options = {}) => {
		assert.equal(
			String(input.url ?? input),
			MODEL,
			"Child may access only controlled model transport"
		);
		assert.equal(options.method, "POST");
		const deadline = Date.now() + 45000;
		while (!fs.existsSync(gate)) {
			assert.ok(Date.now() < deadline, "Preparing UI was not acknowledged before gate deadline");
			await new Promise((done) => setTimeout(done, 25));
		}
		return sse(JSON.parse(options.body), ...childTool(JSON.parse(options.body)));
	};
}
const primary = (workspace) =>
	workspace.canvases.find((canvas) => canvas.id === workspace.primaryId);
function diffRows(patch) {
	let inHunk = false;
	return patch.split("\n").map((line) => {
		if (line.startsWith("@@")) inHunk = true;
		return `${inHunk && /^[ +\-]/.test(line) ? line.slice(1) : line}\n`;
	});
}
function assertReceipt(receipt, expected) {
	assert.equal(receipt.input.status, "applied");
	assert.equal(receipt.result?.status, "accepted");
	const workspace = receipt.input.workspace;
	const canvas = primary(workspace);
	assert.equal(canvas.section, "fixes");
	assert.deepEqual(canvas.fixSource, expected);
	const matching = receipt.ui.frames.filter(
		(frame) =>
			frame.sequence === workspace.sequence &&
			frame.scheduledSequence === workspace.sequence &&
			frame.id === expected.id &&
			frame.path === (expected.path ?? "") &&
			frame.head === (expected.headSha ?? "pending") &&
			frame.base === expected.baseSha &&
			frame.visible &&
			frame.at <= receipt.receivedAt
	);
	assert.ok(
		new Set(matching.map((frame) => frame.timestamp)).size >= 2,
		"Receipt requires two distinct existing app RAF callbacks with the exact displayed source"
	);
	return matching;
}
module.exports = {
	REPOSITORY,
	VIEWER,
	PR_ID,
	FEEDBACK_ID,
	TITLE,
	FEEDBACK,
	NOW,
	MODEL,
	FILES,
	text,
	sha256,
	git,
	createRepository,
	originalState,
	github,
	sse,
	parentModel,
	childTool,
	createChildModelFetch,
	primary,
	diffRows,
	assertReceipt,
};
