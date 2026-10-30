// ROOT ONLY after build:
// env -u ELECTRON_RUN_AS_NODE electron src/main/executive-smoke.cjs [built-main]
// --providers-only checks provider/sidebar/ticket wiring without starting a coding job.
// --initial-job-only stops after the original ready-job/decision/checkpoint assertions.
// AUTHOR CHECKS ONLY: node --check this-file; node this-file --self-check.
// All controlled provider content and the child hook live in this test harness.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const childProcess = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { syncBuiltinESMExports } = require("node:module");
const { tmpdir } = require("node:os");
const { basename, dirname, join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const REPOSITORY = "executive-smoke/controlled-repository";
const VIEWER = "executive-reviewer";
const META_ENDPOINT = "https://api.meta.ai/v1/responses";
const LINEAR_ENDPOINT = "https://api.linear.app/graphql";
const TICKET_ID = "executive-smoke-owned-ticket";
const TICKET_IDENTIFIER = "SMOKE-46";
const TICKET_TITLE = "Apply the confirmed value in the isolated checkout";
const QUESTION = "Should this ticket use the value three?";
const ANSWER = "Use three, preserve the existing CommonJS convention, and run the declared test.";
const SOURCE_PATH = "src/value.cjs";
const SOURCE_BASE = "module.exports = { value: 1 };\n";
const SOURCE_REVIEW = "module.exports = { value: 2 };\n";
const SOURCE_WORK = "module.exports = { value: 3 };\n";
const REVISION =
	"Keep the value three and add // Reviewed executive revision to src/value.cjs. Preserve CommonJS and rerun the declared test.";
const SOURCE_REVISED = "module.exports = { value: 3 }; // Reviewed executive revision\n";
const NOW = "2026-10-29T00:00:00.000Z";
const page = (nodes) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
const workflowState = (type) => ({ id: `smoke-state-${type}`, name: type, type });
const ticket = (type = "unstarted") => ({
	id: TICKET_ID,
	identifier: TICKET_IDENTIFIER,
	title: TICKET_TITLE,
	description:
		"A controlled acceptance ticket. Confirm the value before editing the actual temporary code.",
	url: "https://linear.app/controlled/issue/SMOKE-46",
	updatedAt: NOW,
	state: workflowState(type),
	priority: 2,
	team: { id: "smoke-team", name: "Controlled team" },
	project: { id: "smoke-project", name: "Controlled project" },
	assignee: { id: "smoke-viewer", name: "Controlled executive" },
});

function git(cwd, ...args) {
	return childProcess.execFileSync(
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
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				PATH: process.env.PATH,
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_TERMINAL_PROMPT: "0",
				GIT_NO_LAZY_FETCH: "1",
				GIT_AUTHOR_NAME: "Controlled smoke",
				GIT_AUTHOR_EMAIL: "smoke@example.invalid",
				GIT_COMMITTER_NAME: "Controlled smoke",
				GIT_COMMITTER_EMAIL: "smoke@example.invalid",
				GIT_AUTHOR_DATE: NOW,
				GIT_COMMITTER_DATE: NOW,
			},
		}
	);
}

// Invoked only by the native root run, never by --self-check or module import.
function createRepository(root) {
	const localPath = join(root, "original");
	const remote = join(root, "controlled-remote.git");
	fs.mkdirSync(localPath);
	git(root, "init", "--bare", "--initial-branch=main", remote);
	git(localPath, "init", "--initial-branch=main");
	git(localPath, "config", "user.name", "Controlled smoke");
	git(localPath, "config", "user.email", "smoke@example.invalid");
	fs.mkdirSync(join(localPath, "src"));
	fs.writeFileSync(join(localPath, SOURCE_PATH), SOURCE_BASE);
	fs.writeFileSync(
		join(localPath, "README.md"),
		"# Controlled acceptance repository\nUse CommonJS and npm run test.\n"
	);
	fs.writeFileSync(
		join(localPath, "AGENTS.md"),
		"Keep CommonJS source in src/. Ask before choosing the product value. Run npm run test. Do not change package scripts.\n"
	);
	fs.writeFileSync(
		join(localPath, "package.json"),
		`${JSON.stringify({ name: "executive-controlled-check", version: "1.0.0", private: true, packageManager: "npm@10.9.2", scripts: { test: "node check.cjs" } }, null, 2)}\n`
	);
	fs.writeFileSync(
		join(localPath, "check.cjs"),
		`const assert = require('node:assert/strict');\nassert.equal(require('./src/value.cjs').value, 3);\nfor (const key of ['MODEL_API_KEY','META_API_KEY','GITHUB_TOKEN','LINEAR_API_KEY','NODE_OPTIONS']) assert.equal(process.env[key], undefined, key + ' must not reach validation');\nconsole.log('EXECUTIVE_DECLARED_CHECK_PASS');\n`
	);
	git(localPath, "add", "--", "AGENTS.md", "README.md", "package.json", "check.cjs", SOURCE_PATH);
	git(localPath, "commit", "-m", "Controlled acceptance baseline");
	const baseSha = git(localPath, "rev-parse", "HEAD").trim();
	git(localPath, "switch", "-c", "controlled-review");
	fs.writeFileSync(join(localPath, SOURCE_PATH), SOURCE_REVIEW);
	git(localPath, "add", "--", SOURCE_PATH);
	git(localPath, "commit", "-m", "Controlled review proposal");
	const reviewSha = git(localPath, "rev-parse", "HEAD").trim();
	git(localPath, "switch", "main");
	git(localPath, "remote", "add", "origin", remote);
	git(localPath, "-c", "protocol.file.allow=always", "push", "origin", "main", "controlled-review");
	git(localPath, "remote", "set-url", "origin", `https://github.com/${REPOSITORY}.git`);
	fs.appendFileSync(join(localPath, "README.md"), "Staged original work must remain unchanged.\n");
	git(localPath, "add", "--", "README.md");
	const dirty = "module.exports = { value: 99 }; // personal unsaved work\n";
	fs.writeFileSync(join(localPath, SOURCE_PATH), dirty);
	fs.writeFileSync(
		join(localPath, "personal-note.txt"),
		"Untracked original work must remain unchanged.\n"
	);
	const patch = git(
		localPath,
		"diff",
		"--no-ext-diff",
		"--no-textconv",
		"--no-color",
		"--find-renames",
		"--unified=3",
		baseSha,
		reviewSha,
		"--",
		SOURCE_PATH
	);
	return {
		localPath,
		remote,
		baseSha,
		reviewSha,
		dirty,
		patch,
		status: git(localPath, "status", "--porcelain=v1", "-z"),
		index: git(localPath, "diff", "--cached", "--binary"),
		originalRefs: git(remote, "show-ref"),
	};
}

function pull(number, fixture) {
	assert.ok([7, 8].includes(number));
	return {
		number,
		state: "open",
		draft: false,
		html_url: `https://github.com/${REPOSITORY}/pull/${number}`,
		title: number === 7 ? "Controlled incoming request" : "Controlled own PR feedback",
		body: "Controlled test-only source proposal.",
		changed_files: 1,
		updated_at: NOW,
		user: { login: number === 7 ? "controlled-author" : VIEWER },
		base: { sha: fixture.baseSha, ref: "main", repo: { full_name: REPOSITORY } },
		head: { sha: fixture.reviewSha, ref: "controlled-review", repo: { full_name: REPOSITORY } },
	};
}

function githubResponse(url, method, fixture) {
	assert.equal(method, "GET", "No GitHub writes permitted in executive smoke");
	const parsed = new URL(url);
	assert.equal(parsed.origin, "https://api.github.com");
	const root = `/repos/${REPOSITORY}`;
	const metadata = { full_name: REPOSITORY, default_branch: "main", private: true };
	if (parsed.pathname === "/user") return { login: VIEWER, name: "Controlled executive" };
	if (parsed.pathname === "/user/repos") return [metadata];
	if (parsed.pathname === root) return metadata;
	if (parsed.pathname === "/search/issues") {
		const query = parsed.searchParams.get("q");
		assert.ok(
			query === `repo:${REPOSITORY} is:pr is:open review-requested:${VIEWER}` ||
				query === `repo:${REPOSITORY} is:pr is:open author:${VIEWER}`,
			"Unexpected repository/viewer search"
		);
		const number = query.includes("review-requested:") ? 7 : 8;
		return {
			total_count: 1,
			incomplete_results: false,
			items: [
				{
					number,
					repository_url: `https://api.github.com${root}`,
					pull_request: { url: `https://api.github.com${root}/pulls/${number}` },
				},
			],
		};
	}
	if (parsed.pathname === `${root}/pulls`) return [pull(7, fixture), pull(8, fixture)];
	const pr = new RegExp(`^${root}/pulls/(7|8)$`).exec(parsed.pathname);
	if (pr) return pull(Number(pr[1]), fixture);
	if (new RegExp(`^${root}/pulls/(7|8)/files$`).test(parsed.pathname))
		return [
			{
				filename: SOURCE_PATH,
				status: "modified",
				additions: 1,
				deletions: 1,
				patch: fixture.patch.slice(fixture.patch.indexOf("@@")).trimEnd(),
			},
		];
	if (new RegExp(`^${root}/pulls/(7|8)/(reviews|comments)$`).test(parsed.pathname)) return [];
	if (parsed.pathname === `${root}/issues/7/comments`) return [];
	if (parsed.pathname === `${root}/issues/8/comments`)
		return [
			{
				id: 8801,
				body: "Please preserve the CommonJS export.",
				user: { login: "controlled-feedback-author" },
				html_url: `https://github.com/${REPOSITORY}/pull/8#issuecomment-8801`,
				created_at: NOW,
				updated_at: NOW,
			},
		];
	if (
		parsed.pathname.startsWith(`${root}/contents/`) &&
		decodeURIComponent(parsed.pathname.slice(`${root}/contents/`.length)) === SOURCE_PATH
	) {
		const sha = parsed.searchParams.get("ref");
		assert.ok(
			[fixture.baseSha, fixture.reviewSha].includes(sha),
			"Only pinned source can be returned"
		);
		const content = sha === fixture.baseSha ? SOURCE_BASE : SOURCE_REVIEW;
		return {
			path: SOURCE_PATH,
			type: "file",
			size: Buffer.byteLength(content),
			encoding: "base64",
			content: Buffer.from(content).toString("base64"),
		};
	}
	throw new Error(`Unexpected controlled GitHub path: ${parsed.pathname}`);
}

function linearResponse(body, state) {
	const { query, variables = {} } = body;
	assert.equal(typeof query, "string");
	if (/\bHubViewer\b/.test(query))
		return { data: { viewer: { id: "smoke-viewer", name: "Controlled executive" } } };
	if (/\bHubTickets\b/.test(query)) {
		assert.equal(variables.filter.assignee.id.eq, "smoke-viewer");
		return { data: { issues: page([ticket(state.type)]) } };
	}
	if (/\bHubTicket\b/.test(query)) {
		assert.ok([TICKET_ID, TICKET_IDENTIFIER].includes(variables.id));
		return { data: { issue: ticket(state.type) } };
	}
	if (/\bHubTeams\b/.test(query))
		return { data: { teams: page([{ id: "smoke-team", name: "Controlled team", key: "SMOKE" }]) } };
	if (/\bHubProjects\b/.test(query))
		return { data: { projects: page([{ id: "smoke-project", name: "Controlled project" }]) } };
	if (/\bHubStates\b/.test(query)) {
		assert.equal(variables.teamId, "smoke-team");
		assert.ok(["started", "completed", "unstarted"].includes(variables.type));
		return {
			data: {
				workflowStates: page([
					{ ...workflowState(variables.type), position: 0, team: { id: "smoke-team" } },
				]),
			},
		};
	}
	if (/\bHubUpdateState\b/.test(query)) {
		assert.equal(variables.id, TICKET_ID);
		const type = ["started", "completed", "unstarted"].find(
			(value) => workflowState(value).id === variables.stateId
		);
		assert.ok(type, "Only the controlled ticket's real returned state ID may be used");
		state.type = type;
		state.updates.push(type);
		return { data: { issueUpdate: { success: true, issue: ticket(type) } } };
	}
	throw new Error("Unexpected controlled Linear operation");
}

function sse(body, name, args) {
	assert.equal(body.stream, true);
	assert.equal(body.store, false);
	assert.equal(body.tool_choice, "auto");
	assert.ok(
		body.tools.some((tool) => tool.name === name),
		`Tool unavailable: ${name}`
	);
	const output = [
		{
			type: "function_call",
			status: "completed",
			call_id: `executive-${randomUUID()}`,
			name,
			arguments: JSON.stringify(args),
		},
	];
	return new Response(
		`data: ${JSON.stringify({ type: "response.completed", response: { id: `executive-${randomUUID()}`, model: body.model, status: "completed", output, usage: null } })}\n\n`,
		{ headers: { "content-type": "text/event-stream" } }
	);
}

function childTool(body) {
	assert.equal(body.model, "muse-spark-1.3");
	const initial = body.input.find(
		(item) => item.role === "user" && typeof item.content === "string"
	);
	const task = JSON.parse(initial.content);
	assert.equal(task.repository, REPOSITORY, "Worker repository identity mismatch");
	assert.equal(task.ticket.id, TICKET_ID, "Worker ticket identity mismatch");
	const coordinator = body.input
		.filter((item) => item.role === "user" && typeof item.content === "string")
		.map((item) => {
			try {
				return JSON.parse(item.content);
			} catch {
				return {};
			}
		})
		.findLast((value) => value.coordinatorDecision);
	const receipts = new Map(
		body.input
			.filter((item) => item.type === "function_call_output")
			.map((item) => [item.call_id, JSON.parse(item.output)])
	);
	const done = (label) =>
		body.input.some(
			(item) =>
				item.type === "function_call" &&
				item.name === "read_file" &&
				JSON.parse(item.arguments).path === label &&
				receipts.has(item.call_id)
		);
	if (!coordinator) {
		for (const path of ["AGENTS.md", "README.md", "package.json", SOURCE_PATH])
			if (!done(path)) return ["read_file", { path }];
		return [
			"request_decision",
			{
				category: "product",
				question: QUESTION,
				reason: "The test ticket deliberately leaves the value for the executive to confirm.",
				summary:
					"Read the actual conventions and source without editing; waiting for the product value.",
			},
		];
	}
	assert.ok(
		coordinator.coordinatorDecision.includes(ANSWER),
		"Worker resumed without the actual decision answer"
	);
	const lastContext = body.input.findLastIndex(
		(item) =>
			item.role === "user" &&
			typeof item.content === "string" &&
			item.content.includes("coordinatorDecision")
	);
	const calls = body.input.slice(lastContext + 1).filter((item) => item.type === "function_call");
	const read = calls.findLast(
		(item) => item.name === "read_file" && JSON.parse(item.arguments).path === SOURCE_PATH
	);
	if (!read) return ["read_file", { path: SOURCE_PATH }];
	const source = receipts.get(read.call_id);
	const revising = coordinator.coordinatorDecision.includes(REVISION);
	assert.equal(
		source.text,
		revising ? SOURCE_WORK : SOURCE_BASE,
		"The worker must read its current isolated revision, not dirty original source or stale history"
	);
	const edit = calls.find((item) => item.name === "edit_file");
	if (!edit)
		return [
			"edit_file",
			{
				path: SOURCE_PATH,
				oldText: revising ? SOURCE_WORK : "value: 1",
				newText: revising ? SOURCE_REVISED : "value: 3",
				expectedSha256: source.sha256,
			},
		];
	assert.equal(receipts.get(edit.call_id)?.path, SOURCE_PATH);
	const check = calls.find((item) => item.name === "run_command");
	if (!check) return ["run_command", { command: "npm", args: ["run", "test"], timeoutMs: 30000 }];
	const actual = receipts.get(check.call_id);
	assert.equal(actual.exitCode, 0, "Actual child validation must succeed");
	assert.equal(actual.interrupted, false);
	assert.ok(actual.stdout.includes("EXECUTIVE_DECLARED_CHECK_PASS"));
	return [
		"finish_work",
		{
			summary: revising
				? "Added the requested review comment to the same isolated source, preserving value three and CommonJS. The fresh npm run test receipt returned exit 0 and its declared check marker."
				: "Changed the confirmed value from one to three in the actual isolated source. npm run test returned exit 0 and its declared check marker. Main still owns final validation and publication.",
		},
	];
}

// Loaded only by the native harness's private --import hook. No product mock switch.
exports.createChildModelFetch =
	() =>
	async (input, options = {}) => {
		assert.equal(
			String(input.url ?? input),
			META_ENDPOINT,
			"Child network is restricted to controlled Meta transport"
		);
		assert.equal(options.method, "POST");
		const body = JSON.parse(options.body);
		return sse(body, ...childTool(body));
	};

function parentModel(body) {
	assert.ok(
		body.tools.some((tool) => tool.name === "submit_prepared_review"),
		"Foreground model work is outside this controlled smoke"
	);
	return sse(body, "submit_prepared_review", {
		summary: "The actual controlled proposal changes the exported value from one to two.",
		orderRationale: "Inspect the exported source value.",
		files: [
			{
				path: SOURCE_PATH,
				reason: "Defines the changed export.",
				summary: "The export changes from one to two.",
				suggestedComments: [],
			},
		],
	});
}

async function wait(label, read, timeoutMs = 30000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await read();
		if (value) return value;
		await new Promise((done) => setTimeout(done, 50));
	}
	throw new Error(`Timed out waiting for ${label}`);
}
function checkpointUnder(directory, jobId) {
	let visited = 0;
	const visit = (path) => {
		assert.ok(++visited <= 1000, "Bounded private checkpoint search exceeded");
		for (const entry of fs.readdirSync(path, { withFileTypes: true })) {
			if (
				entry.isSymbolicLink() ||
				["repository.git", "worktree", "node_modules", "Cache", "Code Cache"].includes(entry.name)
			)
				continue;
			const child = join(path, entry.name);
			if (entry.isDirectory()) {
				const found = visit(child);
				if (found) return found;
			} else if (entry.name === "checkpoint.json") {
				const state = JSON.parse(fs.readFileSync(child, "utf8"));
				if (state.jobId === jobId) return { path: child, state };
			}
		}
		return null;
	};
	return visit(directory);
}
function assertOriginal(fixture) {
	assert.equal(git(fixture.localPath, "rev-parse", "HEAD").trim(), fixture.baseSha);
	assert.equal(git(fixture.localPath, "status", "--porcelain=v1", "-z"), fixture.status);
	assert.equal(git(fixture.localPath, "diff", "--cached", "--binary"), fixture.index);
	assert.equal(fs.readFileSync(join(fixture.localPath, SOURCE_PATH), "utf8"), fixture.dirty);
	assert.equal(
		fs.readFileSync(join(fixture.localPath, "personal-note.txt"), "utf8"),
		"Untracked original work must remain unchanged.\n"
	);
	assert.equal(
		git(fixture.remote, "show-ref"),
		fixture.originalRefs,
		"The controlled bare remote must not receive work publication"
	);
}

function assertReview(review, job, content) {
	assert.equal(review.job.id, job.id);
	assert.equal(review.job.repository, job.repository);
	assert.equal(review.job.baseSha, job.baseSha);
	assert.equal(review.job.headSha, job.headSha);
	assert.equal(review.files.length, 1);
	const file = review.files[0];
	assert.equal(file.path, SOURCE_PATH);
	assert.ok(!Object.hasOwn(file, "prId"), "Local work file must not invent PR identity");
	assert.equal(file.base.commitSha, job.baseSha);
	assert.equal(file.head.commitSha, job.headSha);
	assert.equal(file.base.content, SOURCE_BASE);
	assert.equal(file.head.content, content);
}

function assertRenderedDiff(visible, job, patch) {
	assert.equal(visible.base, job.baseSha);
	assert.equal(visible.head, job.headSha);
	let inHunk = false;
	const expectedRows = patch.split("\n").map((line) => {
		if (line.startsWith("@@")) inHunk = true;
		return `${inHunk && /^[ +\-]/.test(line) ? line.slice(1) : line}\n`;
	});
	assert.deepEqual(visible.rows, expectedRows, "Rendered diff preserves exact pinned source text");
}

async function native() {
	assert.ok(
		process.versions.electron,
		"Root must launch this harness with Electron; author checks use --self-check only"
	);
	assert.ok(!process.env.ELECTRON_RENDERER_URL, "Use the built default renderer");
	const { app, BrowserWindow } = require("electron");
	const providersOnly = process.argv.includes("--providers-only");
	const initialJobOnly = process.argv.includes("--initial-job-only");
	const main =
		process.argv.slice(2).find((arg) => !arg.startsWith("--")) ??
		join(__dirname, "../../out/main/index.js");
	const owned = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "met-executive-smoke-")));
	const owner = randomUUID();
	fs.writeFileSync(join(owned, ".owner"), owner, { mode: 0o600 });
	const userData = join(owned, "profile");
	fs.mkdirSync(userData, { mode: 0o700 });
	app.setPath("userData", userData);
	const envPath = join(owned, "isolated.env");
	fs.writeFileSync(
		envPath,
		"MODEL_API_KEY=executive-controlled-model-only\nGITHUB_TOKEN=executive-controlled-github-only\nLINEAR_API_KEY=executive-controlled-linear-only\n",
		{ mode: 0o600 }
	);
	process.env.METAHACKATHON_ENV_FILE = envPath;
	const reportPath = join(__dirname, "../../out/executive-smoke-report.json");
	fs.mkdirSync(dirname(reportPath), { recursive: true });
	const report = {
		status: "running",
		scope: providersOnly
			? "providers-sidebar-ticket-only"
			: initialJobOnly
				? "executive-initial-child-job"
				: "executive-revision-approval",
		simulatedGitHub: true,
		simulatedLinear: true,
		simulatedMeta: true,
		liveProvider: false,
		liveSpeech: false,
		appRestartTested: false,
		rendererReopenTested: false,
		childCheckpointResume: false,
		githubWrites: 0,
		children: [],
		http: [],
		blocked: [],
	};
	const save = () => fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
	const originalFetch = globalThis.fetch;
	const originalFork = childProcess.fork;
	const children = [];
	let failed = false;
	const fail = (error) => {
		if (failed) return;
		failed = true;
		report.status = "failed";
		report.error = error.message;
		save();
		app.quit();
	};
	const deadline = setTimeout(() => fail(new Error("Executive smoke hard deadline")), 150000);
	app.on("browser-window-created", (_event, win) => {
		win.setIgnoreMouseEvents(true);
		win.setFocusable(false);
	});
	app.on("will-quit", () => {
		clearTimeout(deadline);
		globalThis.fetch = originalFetch;
		childProcess.fork = originalFork;
		syncBuiltinESMExports();
		try {
			assert.equal(fs.readFileSync(join(owned, ".owner"), "utf8"), owner);
			fs.rmSync(owned, { recursive: true });
			report.cleanup = { ownedTempRemoved: !fs.existsSync(owned) };
		} catch (error) {
			report.status = "failed";
			report.error = error.message;
		}
		save();
		console.log(`EXECUTIVE_SMOKE_${report.status.toUpperCase()}: ${reportPath}`);
		if (report.status !== "passed") app.exit(1);
	});
	try {
		const fixture = createRepository(owned);
		const providerState = { type: "unstarted", updates: [] };
		globalThis.fetch = async (input, options = {}) => {
			const url = String(input.url ?? input);
			try {
				const parsed = new URL(url);
				if (parsed.origin === "https://api.github.com") {
					const method = options.method ?? "GET";
					if (method !== "GET") report.githubWrites++;
					report.http.push({ provider: "github", path: parsed.pathname, method });
					return Response.json(githubResponse(url, method, fixture));
				}
				if (url === LINEAR_ENDPOINT) {
					assert.equal(options.method, "POST");
					const body = JSON.parse(options.body);
					report.http.push({
						provider: "linear",
						operation: /(?:query|mutation)\s+(\w+)/.exec(body.query)?.[1],
					});
					return Response.json(linearResponse(body, providerState));
				}
				if (url === META_ENDPOINT) return parentModel(JSON.parse(options.body));
				throw new Error(`External network forbidden: ${parsed.origin}`);
			} catch (error) {
				report.blocked.push(error.message);
				save();
				throw error;
			}
		};
		const hook = join(owned, "controlled-child-model.mjs");
		fs.writeFileSync(
			hook,
			`import {createRequire} from 'node:module';\nconst require=createRequire(import.meta.url);\nglobalThis.fetch=require(${JSON.stringify(__filename)}).createChildModelFetch();\n`,
			{ mode: 0o600 }
		);
		childProcess.fork = (modulePath, args, options) => {
			assert.equal(
				basename(modulePath),
				"coding-worker.js",
				"Only the actual built coding-entry fork may be instrumented"
			);
			assert.ok(Array.isArray(args), "Use the app's explicit argv fork overload");
			assert.equal(options.env.ELECTRON_RUN_AS_NODE, "1");
			assert.ok(
				!Object.keys(options.env).some((key) => /TOKEN|API_KEY|NODE_OPTIONS/.test(key)),
				"Raw credentials/preload hooks must not be fork environment variables"
			);
			const child = originalFork(modulePath, args, {
				...options,
				execArgv: ["--import", pathToFileURL(hook).href, ...(options.execArgv ?? [])],
			});
			children.push(child);
			const record = { pid: child.pid, entry: basename(modulePath), result: null, exited: false };
			report.children.push(record);
			child.on("message", (event) => {
				if (event?.kind === "result") record.result = event.result.status;
			});
			child.on("exit", (code, signal) => {
				record.exited = true;
				record.exitCode = code;
				record.signal = signal;
			});
			return child;
		};
		syncBuiltinESMExports();
		await import(pathToFileURL(resolve(main)).href);
		await app.whenReady();
		const win = await wait("main window", () => BrowserWindow.getAllWindows()[0]);
		await wait("built renderer and preload", () => !win.webContents.isLoadingMainFrame());
		const js = (code) => win.webContents.executeJavaScript(code);
		const rpc = async (type, path, input = {}) => {
			const result = await js(
				`window.electron.trpc.request(${JSON.stringify({ type, path, input: { json: input } })})`
			);
			assert.ok(!result.error, `${path}: ${JSON.stringify(result.error)}`);
			return result.result.data.json;
		};
		const operate = (operation) =>
			rpc("mutation", "hub.operate", { requestId: randomUUID(), operation });
		const clickText = async (selector, text) => {
			await wait(`enabled ${text}`, () =>
				js(
					`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).some(e=>e.textContent.trim()===${JSON.stringify(text)}&&!e.disabled)`
				)
			);
			await js(
				`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(e=>e.textContent.trim()===${JSON.stringify(text)}&&!e.disabled).click()`
			);
		};
		const section = async (name) => {
			await js(
				`document.querySelector(${JSON.stringify(`.command-rail button[aria-label^="${name}"]`)}).click()`
			);
		};
		const snapshot = () => rpc("query", "hub.snapshot");
		const readStored = () => {
			const Database = require("better-sqlite3");
			const db = new Database(join(userData, "metahackathon.db"), { readonly: true });
			try {
				return JSON.parse(db.prepare("SELECT data_json FROM hub_state WHERE id=1").get().data_json);
			} finally {
				db.close();
			}
		};
		const displayedDiff = () =>
			js(
				`(() => {const w=document.querySelector('[aria-label="Local work review"]');return w&&{rows:Array.from(w.querySelectorAll('.hub-diff-row')).map(e=>e.lastElementChild.textContent),base:w.querySelector('.hub-revision-pair span:first-child')?.title,head:w.querySelector('.hub-revision-pair span:last-child')?.title};})()`
			);
		const initial = await snapshot();
		assert.deepEqual(initial.repositories, [], "No seeded repository may enter a clean profile");
		assert.deepEqual(initial.jobs, [], "No seeded jobs may enter a clean profile");
		assert.deepEqual(initial.connections, { github: true, linear: true, model: true });
		await operate({ kind: "add-repository", repository: REPOSITORY, localPath: fixture.localPath });
		const ready = await wait("provider-owned ticket and queues", async () => {
			const state = await snapshot();
			assert.deepEqual(state.errors, []);
			return state.tickets.some((item) => item.id === TICKET_ID) && state.reviews.length === 2
				? state
				: null;
		});
		assert.equal(ready.repositories[0].repository, REPOSITORY);
		assert.equal(ready.repositories[0].localPath, fixture.localPath);
		assert.equal(ready.repositories[0].defaultBranch, "main");
		assert.deepEqual(ready.reviews.map((row) => [row.pr.number, row.kind]).sort(), [
			[7, "incoming"],
			[8, "own"],
		]);
		await section("Incoming reviews");
		await wait("real returned repository in sidebar", () =>
			js(`!!document.querySelector('.command-repo [title=${JSON.stringify(REPOSITORY)}]')`)
		);
		await section("Own PR feedback");
		await wait("own feedback separated from incoming", () =>
			js(
				`document.querySelector('.command-sidebar-scroll').textContent.includes('Controlled own PR feedback')&&!document.querySelector('.command-sidebar-scroll').textContent.includes('Controlled incoming request')`
			)
		);
		await section("Incoming reviews");
		await wait("incoming separated from own feedback", () =>
			js(
				`document.querySelector('.command-sidebar-scroll').textContent.includes('Controlled incoming request')&&!document.querySelector('.command-sidebar-scroll').textContent.includes('Controlled own PR feedback')`
			)
		);
		await section("My tickets");
		await wait("owned ticket in actual sidebar", () =>
			js(
				`Array.from(document.querySelectorAll('.command-sidebar-scroll button')).some(e=>e.textContent.includes(${JSON.stringify(TICKET_IDENTIFIER)}))`
			)
		);
		await js(
			`Array.from(document.querySelectorAll('.command-sidebar-scroll button')).find(e=>e.textContent.includes(${JSON.stringify(TICKET_IDENTIFIER)})).click()`
		);
		await wait("actual ticket form", () =>
			js(`!!document.querySelector('form.hub-start-work select')`)
		);
		assert.equal((await rpc("query", "hub.ticket", { id: TICKET_ID })).assigneeId, "smoke-viewer");
		assert.equal((await rpc("query", "hub.repositories"))[0].repository, REPOSITORY);
		assert.equal((await rpc("query", "hub.linearScopes")).length, 2);
		report.providerSidebar = {
			repository: REPOSITORY,
			ticket: TICKET_IDENTIFIER,
			incoming: 1,
			own: 1,
			actualDefaultRenderer: true,
			actualPreloadIPC: true,
		};
		if (!providersOnly) {
			const brief =
				"Confirm whether to use three, then change src/value.cjs from one to three. Preserve CommonJS and run npm run test. Only edit the isolated worktree.";
			await js(
				`(() => { const form=document.querySelector('form.hub-start-work');const select=form.querySelector('select');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSON.stringify(ready.repositories[0].id)});select.dispatchEvent(new Event('change',{bubbles:true}));const text=form.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(text,${JSON.stringify(brief)});text.dispatchEvent(new Event('input',{bubbles:true}));})()`
			);
			await clickText("form.hub-start-work button[type=submit]", "Start work");
			const jobId = await wait(
				"actual UI-started work job",
				async () => (await snapshot()).jobs.find((job) => job.ticket?.id === TICKET_ID)?.id
			);
			const job = () => rpc("query", "hub.job", { id: jobId });
			const decisionJob = await wait(
				"real child decision",
				async () => {
					const value = await job();
					assert.notEqual(value.state, "failed", value.error);
					return value.state === "needs-input" ? value : null;
				},
				60000
			);
			assert.equal(decisionJob.decisions[0].question, QUESTION);
			const checkpoint = checkpointUnder(userData, jobId);
			assert.ok(checkpoint, "Actual worker must persist a private checkpoint");
			assert.equal(checkpoint.state.result.status, "needs-input");
			assert.equal(checkpoint.state.pendingTool, null);
			assert.ok(checkpoint.state.history.some((item) => item.name === "request_decision"));
			assert.equal(
				fs.readFileSync(join(decisionJob.worktreePath, SOURCE_PATH), "utf8"),
				SOURCE_BASE
			);
			await wait("visible queued decision form", () =>
				js(
					`document.querySelector('form.hub-decision h2')?.textContent===${JSON.stringify(QUESTION)}`
				)
			);
			await js(
				`(() => {const e=document.querySelector('form.hub-decision textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(ANSWER)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`
			);
			await clickText("form.hub-decision button[type=submit]", "Send decision");
			const result = await wait(
				"actual commit and final checks",
				async () => {
					const value = await job();
					assert.notEqual(value.state, "failed", value.error);
					return value.state === "ready" ? value : null;
				},
				60000
			);
			assert.equal(result.id, jobId);
			assert.equal(result.baseSha, fixture.baseSha);
			assert.match(result.headSha, /^[a-f0-9]{40}$/);
			assert.notEqual(result.headSha, result.baseSha);
			assert.deepEqual(result.changedFiles, [SOURCE_PATH]);
			assert.equal(result.pullRequest, null, "Local work must not fabricate a PR");
			assert.ok(result.checks.length > 0, "Main must execute actual final validation");
			for (const check of result.checks) {
				assert.equal(check.exitCode, 0);
				assert.equal(check.commitSha, result.headSha);
				assert.deepEqual([check.command, ...check.args], ["npm", "run", "test"]);
			}
			assert.equal(git(result.worktreePath, "rev-parse", "HEAD").trim(), result.headSha);
			assert.equal(git(result.worktreePath, "status", "--porcelain=v1"), "");
			assert.equal(
				git(result.worktreePath, "show", `${result.headSha}:${SOURCE_PATH}`),
				SOURCE_WORK
			);
			assert.equal(
				git(
					join(dirname(result.worktreePath), "repository.git"),
					"rev-parse",
					"--is-bare-repository"
				).trim(),
				"true"
			);
			const review = await rpc("query", "hub.reviewWork", { jobId });
			assertReview(review, result, SOURCE_WORK);
			const patch = git(
				result.worktreePath,
				"diff",
				"--no-ext-diff",
				"--no-textconv",
				"--no-color",
				"--find-renames",
				"--unified=3",
				result.baseSha,
				result.headSha,
				"--",
				SOURCE_PATH
			);
			assert.equal(
				review.files[0].patch,
				patch,
				"WorkReview must contain the exact pinned Git diff"
			);
			await wait("ready UI", () => js(`!!document.querySelector('.hub-detail .status-ready')`));
			await wait("approval gated on loaded diff", () =>
				js(
					`Array.from(document.querySelectorAll('[aria-label="Work review actions"] button')).some(e=>e.textContent.trim()==='Accept work and complete ticket'&&e.disabled)`
				)
			);
			await clickText(".hub-detail button", "Inspect local diff");
			assertRenderedDiff(await wait("actual local work diff", displayedDiff), result, patch);
			const resumed = checkpointUnder(userData, jobId);
			assert.equal(resumed.path, checkpoint.path);
			assert.equal(resumed.state.result.status, "completed");
			assert.ok(resumed.state.history.length > checkpoint.state.history.length);
			assert.ok(JSON.stringify(resumed.state.history).includes(ANSWER));
			assert.equal(result.decisions[0].answer, ANSWER);
			assert.ok(result.decisions[0].answeredAt);
			const log = await rpc("query", "hub.jobLog", { jobId, cursor: 0, limit: 200 });
			assert.ok(log.lines.join("\n").includes("EXECUTIVE_DECLARED_CHECK_PASS"));
			await wait(
				"both real child processes exited",
				() => report.children.length >= 2 && report.children.every((child) => child.exited)
			);
			assert.deepEqual(
				report.children.map((child) => child.result),
				["needs-input", "completed"]
			);
			const stored = readStored();
			assert.deepEqual(
				stored.jobs.find((item) => item.id === jobId),
				result
			);
			assert.equal(stored.repositories[0].localPath, fixture.localPath);
			report.childCheckpointResume = true;
			report.job = {
				id: jobId,
				state: result.state,
				baseSha: result.baseSha,
				headSha: result.headSha,
				actualChecks: result.checks,
				exactDiff: true,
				sqliteState: true,
				decisionAnswered: true,
				localBareAndWorktree: true,
			};
			await section("Completed work");
			await wait("ready outcome in completed center", () =>
				js(
					`document.querySelector('.command-sidebar-scroll')?.textContent.includes(${JSON.stringify(TICKET_TITLE)})`
				)
			);
			await section("Home");
			await wait("ready outcome in priority brief", () =>
				js(`document.querySelector('.hub-priorities')?.textContent.includes('Ready to inspect')`)
			);
			if (!initialJobOnly) {
				await section("Completed work");
				await wait("saved job list", () =>
					js(
						`Array.from(document.querySelectorAll('.command-sidebar .command-item')).some(e=>e.textContent.includes(${JSON.stringify(TICKET_TITLE)}))`
					)
				);
				await js(
					`Array.from(document.querySelectorAll('.command-sidebar .command-item')).find(e=>e.textContent.includes(${JSON.stringify(TICKET_TITLE)})).click()`
				);
				await wait("same-job review actions", () =>
					js(`!!document.querySelector('[aria-label="Work review actions"] textarea')`)
				);
				await js(
					`(() => {const e=document.querySelector('[aria-label="Work review actions"] textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(REVISION)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`
				);
				await clickText(
					'[aria-label="Work review actions"] button[type=submit]',
					"Request changes"
				);
				const revised = await wait(
					"same-job revised commit and checks",
					async () => {
						const value = await job();
						assert.notEqual(value.state, "failed", value.error);
						assert.notEqual(
							value.state,
							"needs-input",
							"An explicit review revision must retain the answered product decision"
						);
						return value.state === "ready" && value.headSha !== result.headSha ? value : null;
					},
					60000
				);
				assert.equal(revised.id, result.id);
				assert.equal(revised.worktreePath, result.worktreePath);
				assert.equal(revised.branch, result.branch);
				assert.equal(revised.baseSha, result.baseSha);
				assert.equal(revised.reviewedAt, null);
				assert.equal(revised.revisions.at(-1).instruction, REVISION);
				assert.deepEqual(revised.changedFiles, [SOURCE_PATH]);
				assert.ok(revised.checks.length > 0);
				for (const check of revised.checks) {
					assert.equal(check.exitCode, 0);
					assert.equal(check.commitSha, revised.headSha);
					assert.ok(
						!result.checks.some((old) => old.id === check.id),
						"Revision needs new execution receipts"
					);
				}
				assert.equal(git(revised.worktreePath, "rev-parse", "HEAD").trim(), revised.headSha);
				assert.equal(git(revised.worktreePath, "status", "--porcelain=v1"), "");
				assert.equal(
					git(revised.worktreePath, "show", `${revised.headSha}:${SOURCE_PATH}`),
					SOURCE_REVISED
				);
				assert.equal(
					(await snapshot()).jobs.length,
					1,
					"Review revision must not create another job"
				);
				const revisedReview = await rpc("query", "hub.reviewWork", { jobId });
				assertReview(revisedReview, revised, SOURCE_REVISED);
				const revisedPatch = git(
					revised.worktreePath,
					"diff",
					"--no-ext-diff",
					"--no-textconv",
					"--no-color",
					"--find-renames",
					"--unified=3",
					revised.baseSha,
					revised.headSha,
					"--",
					SOURCE_PATH
				);
				assert.equal(revisedReview.files[0].patch, revisedPatch);
				const stale = await js(
					`window.electron.trpc.request(${JSON.stringify({ type: "mutation", path: "hub.operate", input: { json: { requestId: randomUUID(), operation: { kind: "approve-work", jobId, headSha: result.headSha, confirmed: true } } } })})`
				);
				assert.ok(stale.error, "An old reviewed head cannot approve a newer revision");
				assert.ok(!providerState.updates.includes("completed"));
				await wait("new revision needs an actually loaded diff", () =>
					js(
						`Array.from(document.querySelectorAll('[aria-label="Work review actions"] button')).some(e=>e.textContent.trim()==='Accept work and complete ticket'&&e.disabled)`
					)
				);
				await clickText(".hub-detail button", "Inspect local diff");
				await wait("fresh revised diff", async () => {
					const visible = await displayedDiff();
					return visible?.head === revised.headSha ? visible : null;
				});
				assertRenderedDiff(await displayedDiff(), revised, revisedPatch);
				await clickText(
					'[aria-label="Work review actions"] button',
					"Accept work and complete ticket"
				);
				const accepted = await wait("approved exact head and completed Linear ticket", async () => {
					const value = await job();
					return value.reviewedAt && value.ticket.state.type === "completed" ? value : null;
				});
				assert.equal(accepted.headSha, revised.headSha);
				assert.equal(accepted.pullRequest, null);
				assert.deepEqual(providerState.updates, ["started", "completed"]);
				assert.equal(
					(await snapshot()).tickets.some((item) => item.id === TICKET_ID),
					false
				);
				await wait("actual accepted outcome timestamp", () =>
					js(
						`document.querySelector('[aria-label="Work review actions"] time')?.dateTime===${JSON.stringify(accepted.reviewedAt)}`
					)
				);
				const revisedCheckpoint = checkpointUnder(userData, jobId);
				assert.equal(revisedCheckpoint.path, resumed.path);
				assert.ok(revisedCheckpoint.state.history.length > resumed.state.history.length);
				assert.ok(JSON.stringify(revisedCheckpoint.state.history).includes(REVISION));
				await wait(
					"all three real children exited",
					() => report.children.length === 3 && report.children.every((child) => child.exited)
				);
				assert.deepEqual(
					report.children.map((child) => child.result),
					["needs-input", "completed", "completed"]
				);
				assert.deepEqual(
					readStored().jobs.find((item) => item.id === jobId),
					accepted
				);
				assert.equal(
					readStored().tickets.find((item) => item.id === TICKET_ID).state.type,
					"completed"
				);
				// Reopen the actual renderer and independent SQLite connection. This
				// exercises restored UI/IPC state without claiming a main-process restart.
				const loaded = new Promise((done) => win.webContents.once("did-finish-load", done));
				win.webContents.reload();
				await loaded;
				await wait("reopened executive workspace", () =>
					js(
						`!!document.querySelector('.command-navigation')&&document.querySelector('.hub-center')?.dataset.centerSection==='home'`
					)
				);
				assert.deepEqual(await job(), accepted);
				assert.deepEqual(
					readStored().jobs.find((item) => item.id === jobId),
					accepted
				);
				assert.equal((await snapshot()).jobs.length, 1);
				await section("Completed work");
				await wait("saved job after renderer reopen", () =>
					js(
						`Array.from(document.querySelectorAll('.command-sidebar .command-item')).some(e=>e.textContent.includes(${JSON.stringify(TICKET_TITLE)}))`
					)
				);
				await wait("accepted outcome in reopened sidebar", () =>
					js(
						`Array.from(document.querySelectorAll('.command-sidebar-scroll button')).some(e=>e.textContent.includes(${JSON.stringify(TICKET_TITLE)})&&e.textContent.includes('Accepted'))`
					)
				);
				await js(
					`Array.from(document.querySelectorAll('.command-sidebar .command-item')).find(e=>e.textContent.includes(${JSON.stringify(TICKET_TITLE)})).click()`
				);
				await wait("accepted detail after reopen", () =>
					js(
						`document.querySelector('[aria-label="Work review actions"] time')?.dateTime===${JSON.stringify(accepted.reviewedAt)}`
					)
				);
				await clickText(".hub-detail button", "Inspect local diff");
				const reopened = await wait("reopened exact source diff", displayedDiff);
				assertRenderedDiff(reopened, accepted, revisedPatch);
				await section("Home");
				await wait("accepted job removed from priority brief", () =>
					js(
						`!!document.querySelector('.hub-priorities')&&!Array.from(document.querySelectorAll('.hub-priority')).some(e=>e.textContent.includes(${JSON.stringify(TICKET_TITLE)}))`
					)
				);
				report.rendererReopenTested = true;
				report.job.headSha = accepted.headSha;
				report.job.actualChecks = accepted.checks;
				report.job.reviewedAt = accepted.reviewedAt;
				report.revision = {
					jobId,
					sameWorktree: true,
					initialHead: result.headSha,
					headSha: accepted.headSha,
					freshChecks: accepted.checks,
					staleApprovalRejected: true,
				};
				report.acceptance = {
					headSha: accepted.headSha,
					reviewedAt: accepted.reviewedAt,
					ticketState: accepted.ticket.state.type,
					actualUI: true,
					sqliteReopened: true,
				};
			}
		}
		assertOriginal(fixture);
		assert.equal(report.githubWrites, 0);
		assert.deepEqual(report.blocked, []);
		assert.ok(providerState.updates.includes("started") || providersOnly);
		report.originalPreserved = true;
		report.status = "passed";
		save();
		app.quit();
	} catch (error) {
		fail(error);
	}
}

async function selfCheck() {
	const fixture = {
		baseSha: "a".repeat(40),
		reviewSha: "b".repeat(40),
		patch: "@@ -1 +1 @@\n-module.exports = { value: 1 };\n+module.exports = { value: 2 };\n",
	};
	assert.equal(
		githubResponse(`https://api.github.com/repos/${REPOSITORY}`, "GET", fixture).default_branch,
		"main"
	);
	assert.throws(
		() => githubResponse(`https://api.github.com/repos/${REPOSITORY}/pulls`, "POST", fixture),
		/No GitHub writes/
	);
	assert.throws(() =>
		githubResponse("https://api.github.com/repos/unrelated/repository", "GET", fixture)
	);
	for (const [qualifier, number] of [
		[`review-requested:${VIEWER}`, 7],
		[`author:${VIEWER}`, 8],
	]) {
		const data = githubResponse(
			`https://api.github.com/search/issues?q=${encodeURIComponent(`repo:${REPOSITORY} is:pr is:open ${qualifier}`)}`,
			"GET",
			fixture
		);
		assert.equal(data.items[0].number, number);
	}
	const state = { type: "unstarted", updates: [] };
	assert.equal(
		linearResponse({ query: "query HubViewer { viewer { id name } }" }, state).data.viewer.id,
		"smoke-viewer"
	);
	assert.equal(
		linearResponse(
			{
				query: "query HubTickets {}",
				variables: { filter: { assignee: { id: { eq: "smoke-viewer" } } } },
			},
			state
		).data.issues.nodes[0].id,
		TICKET_ID
	);
	assert.throws(() =>
		linearResponse(
			{
				query: "query HubTickets {}",
				variables: { filter: { assignee: { id: { eq: "someone-else" } } } },
			},
			state
		)
	);
	const input = [
		{
			role: "user",
			content: JSON.stringify({ repository: REPOSITORY, ticket: { id: TICKET_ID } }),
		},
	];
	assert.deepEqual(childTool({ model: "muse-spark-1.3", input }), [
		"read_file",
		{ path: "AGENTS.md" },
	]);
	assert.throws(() => childTool({ model: "wrong-provider", input }));
	assert.throws(
		() =>
			childTool({
				model: "muse-spark-1.3",
				input: [
					{
						role: "user",
						content: JSON.stringify({ repository: "wrong/repo", ticket: { id: TICKET_ID } }),
					},
				],
			}),
		/identity mismatch/
	);
	// Pure protocol rehearsal only: these synthetic receipts never execute a tool.
	const body = { model: "muse-spark-1.3", input: structuredClone(input) };
	const addReceipt = (name, args, output) => {
		const id = `self-${body.input.length}`;
		body.input.push({ type: "function_call", call_id: id, name, arguments: JSON.stringify(args) });
		body.input.push({ type: "function_call_output", call_id: id, output: JSON.stringify(output) });
	};
	for (const path of ["AGENTS.md", "README.md", "package.json", SOURCE_PATH]) {
		assert.deepEqual(childTool(body), ["read_file", { path }]);
		addReceipt(
			"read_file",
			{ path },
			{
				path,
				text: path === SOURCE_PATH ? SOURCE_BASE : "controlled protocol text",
				sha256: "a".repeat(64),
			}
		);
	}
	assert.equal(childTool(body)[0], "request_decision");
	addReceipt("request_decision", {}, { outcome: "paused" });
	body.input.push({
		role: "user",
		content: JSON.stringify({ coordinatorDecision: `User decision: ${ANSWER}` }),
	});
	assert.deepEqual(childTool(body), ["read_file", { path: SOURCE_PATH }]);
	addReceipt(
		"read_file",
		{ path: SOURCE_PATH },
		{ path: SOURCE_PATH, text: SOURCE_BASE, sha256: "b".repeat(64) }
	);
	const edit = childTool(body);
	assert.equal(edit[0], "edit_file");
	assert.equal(edit[1].expectedSha256, "b".repeat(64));
	addReceipt(edit[0], edit[1], { path: SOURCE_PATH });
	const command = childTool(body);
	assert.deepEqual(command, [
		"run_command",
		{ command: "npm", args: ["run", "test"], timeoutMs: 30000 },
	]);
	addReceipt(command[0], command[1], {
		exitCode: 0,
		interrupted: false,
		stdout: "EXECUTIVE_DECLARED_CHECK_PASS",
	});
	assert.equal(childTool(body)[0], "finish_work");
	body.input.at(-1).output = JSON.stringify({ exitCode: 7, interrupted: false, stdout: "failed" });
	assert.throws(() => childTool(body), /Actual child validation must succeed/);
	body.input.at(-1).output = JSON.stringify({
		exitCode: 0,
		interrupted: false,
		stdout: "EXECUTIVE_DECLARED_CHECK_PASS",
	});
	body.input.push({
		role: "user",
		content: JSON.stringify({
			coordinatorDecision: `User decision: ${ANSWER}\nUser review instruction: ${REVISION}`,
		}),
	});
	assert.deepEqual(childTool(body), ["read_file", { path: SOURCE_PATH }]);
	addReceipt(
		"read_file",
		{ path: SOURCE_PATH },
		{ path: SOURCE_PATH, text: SOURCE_WORK, sha256: "c".repeat(64) }
	);
	const revisionEdit = childTool(body);
	assert.deepEqual(revisionEdit, [
		"edit_file",
		{
			path: SOURCE_PATH,
			oldText: SOURCE_WORK,
			newText: SOURCE_REVISED,
			expectedSha256: "c".repeat(64),
		},
	]);
	addReceipt(revisionEdit[0], revisionEdit[1], { path: SOURCE_PATH });
	assert.equal(
		childTool(body)[0],
		"run_command",
		"Old validation receipts do not satisfy a new revision"
	);
	addReceipt(
		"run_command",
		{ command: "npm", args: ["run", "test"] },
		{ exitCode: 0, interrupted: false, stdout: "EXECUTIVE_DECLARED_CHECK_PASS" }
	);
	assert.equal(childTool(body)[0], "finish_work");
	const localJob = {
		id: "controlled-job",
		repository: REPOSITORY,
		baseSha: fixture.baseSha,
		headSha: fixture.reviewSha,
	};
	const localReview = {
		job: { ...localJob },
		files: [
			{
				path: SOURCE_PATH,
				base: { commitSha: fixture.baseSha, content: SOURCE_BASE },
				head: { commitSha: fixture.reviewSha, content: SOURCE_REVISED },
			},
		],
	};
	assertReview(localReview, localJob, SOURCE_REVISED);
	assert.throws(() =>
		assertReview(localReview, { ...localJob, headSha: "c".repeat(40) }, SOURCE_REVISED)
	);
	assert.throws(() => assertReview(localReview, localJob, SOURCE_WORK));
	const exactRows = [
		"@@ -1 +1 @@\n",
		"module.exports = { value: 1 };\n",
		"module.exports = { value: 2 };\n",
		"\n",
	];
	assertRenderedDiff(
		{ base: localJob.baseSha, head: localJob.headSha, rows: exactRows },
		localJob,
		fixture.patch
	);
	assert.throws(() =>
		assertRenderedDiff(
			{ base: localJob.baseSha, head: localJob.headSha, rows: ["rewritten source"] },
			localJob,
			fixture.patch
		)
	);
	const response = sse(
		{
			model: "muse-spark-1.3",
			stream: true,
			store: false,
			tool_choice: "auto",
			tools: [{ name: "read_file" }],
		},
		"read_file",
		{ path: "AGENTS.md" }
	);
	assert.equal(response.headers.get("content-type"), "text/event-stream");
	assert.ok((await response.text()).includes('"response.completed"'));
	assert.throws(() =>
		sse(
			{ model: "muse-spark-1.3", stream: true, store: false, tool_choice: "none", tools: [] },
			"read_file",
			{}
		)
	);
	console.log(
		"EXECUTIVE_SELF_CHECK_PASS: controlled endpoints, ownership, decision/revision protocol, exact review/diff guards and SSE; no Electron, Git, child, server, SQLite, provider, network or microphone launched"
	);
}

// Importing this module in the child hook must never launch the native harness.
if (
	require.main === module ||
	(process.versions.electron && process.argv[1] && resolve(process.argv[1]) === resolve(__filename))
) {
	(process.argv.includes("--self-check") ? selfCheck() : native()).catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
