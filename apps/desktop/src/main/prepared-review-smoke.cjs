// ROOT ONLY: env -u ELECTRON_RUN_AS_NODE electron src/main/prepared-review-smoke.cjs [built-main]
// Worker: node --check this-file && node this-file --self-check. No Electron/provider/Git launch.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { randomUUID, createHash } = require("node:crypto");
const { tmpdir } = require("node:os");
const { join, resolve, dirname } = require("node:path");
const { pathToFileURL } = require("node:url");
const repository = "test-owner/review-case";
const prId = `${repository}#7`;
const endpoint = "https://api.meta.ai/v1/responses";
const apiRoot = `https://api.github.com/repos/${repository}`;
const order = ["contracts.ts", "logic.ts", "tests.ts"];
const steps = [
	["Walk me through this review.", "resume_review", {}, "contracts.ts", false],
	["Show me the next file.", "next_review_file", {}, "logic.ts", false],
	["Go to the previous file.", "previous_review_file", {}, "contracts.ts", false],
	[
		"Open tests.ts and highlight line 2.",
		"open_review_file",
		{ path: "tests.ts", line: 2, side: "head" },
		"tests.ts",
		false,
	],
	["Pause this review.", "pause_review", {}, "tests.ts", true],
	["Resume this review.", "resume_review", {}, "tests.ts", false],
];
const base = {
	"contracts.ts": "export type Quote = { subtotal: number };\n",
	"logic.ts":
		"import type { Quote } from './contracts';\nexport const total = (quote: Quote) => quote.subtotal;\n",
	"tests.ts":
		"import { total } from './logic';\nexport const expected = total({ subtotal: 100 }) === 100;\n",
};
const head = {
	"contracts.ts": "export type Quote = { subtotal: number; discount: number };\n",
	"logic.ts":
		"import type { Quote } from './contracts';\nexport const total = (quote: Quote) => quote.subtotal - quote.discount;\n",
	"tests.ts":
		"import { total } from './logic';\nexport const expected = total({ subtotal: 100, discount: 20 }) === 80;\n",
};
function git(cwd, ...args) {
	return execFileSync(
		"git",
		["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
		{
			cwd,
			encoding: "utf8",
			timeout: 10_000,
			env: {
				PATH: process.env.PATH,
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_TERMINAL_PROMPT: "0",
				GIT_OPTIONAL_LOCKS: "0",
				GIT_AUTHOR_NAME: "Smoke",
				GIT_AUTHOR_EMAIL: "smoke@example.invalid",
				GIT_COMMITTER_NAME: "Smoke",
				GIT_COMMITTER_EMAIL: "smoke@example.invalid",
				GIT_AUTHOR_DATE: "2026-10-27T12:00:00Z",
				GIT_COMMITTER_DATE: "2026-10-27T12:00:00Z",
			},
		}
	);
}
function createRepository(root) {
	const localPath = join(root, "repository");
	fs.mkdirSync(localPath);
	git(localPath, "init", "-b", "main");
	const commits = [];
	for (const [name, sources] of [
		["base", base],
		["head", head],
	]) {
		for (const path of order) fs.writeFileSync(join(localPath, path), sources[path]);
		git(localPath, "add", "--", ...order);
		git(localPath, "commit", "-m", name);
		commits.push(git(localPath, "rev-parse", "HEAD").trim());
	}
	git(localPath, "remote", "add", "origin", `https://github.com/${repository}.git`);
	const files = [...order].reverse().map((filename) => {
		const diff = git(
			localPath,
			"diff",
			"--no-ext-diff",
			"--no-textconv",
			commits[0],
			commits[1],
			"--",
			filename
		);
		const patch = diff.slice(diff.indexOf("@@")).trimEnd();
		return {
			filename,
			status: "modified",
			additions: patch.split("\n").filter((s) => s.startsWith("+")).length,
			deletions: patch.split("\n").filter((s) => s.startsWith("-")).length,
			patch,
		};
	});
	const dirty = `${head["logic.ts"]}// UNSAVED WORK MUST REMAIN UNCHANGED\n`;
	fs.writeFileSync(join(localPath, "logic.ts"), dirty);
	return {
		localPath,
		baseSha: commits[0],
		headSha: commits[1],
		files,
		dirty,
		status: git(localPath, "status", "--porcelain=v1"),
	};
}
function analysis() {
	return {
		summary: "A discount field connects the quote contract, total calculation and its check.",
		orderRationale: "Read the contract first, then its implementation, then the behavioral check.",
		files: order.map((path, i) => ({
			path,
			reason: [
				"Defines the input shape.",
				"Consumes the contract to calculate a total.",
				"Checks the changed total.",
			][i],
			summary: [
				"Adds a discount value.",
				"Subtracts the discount from subtotal.",
				"Checks the discounted result.",
			][i],
			suggestedComments:
				path === "logic.ts"
					? [
							{
								body: "Should negative discounts be rejected?",
								location: { side: "head", startLine: 2, endLine: 2 },
							},
						]
					: [],
		})),
	};
}
function context(body) {
	const packets = body.input
		.filter((item) => item.role === "user" && Array.isArray(item.content))
		.flatMap((item) =>
			item.content.filter((c) => c.type === "input_text").map((c) => JSON.parse(c.text))
		);
	return packets.findLast((packet) => packet.reviewScreen) ?? packets[0];
}
function choose(body) {
	if (body.tools.some((tool) => tool.name === "submit_prepared_review"))
		return { tool: "submit_prepared_review", args: analysis(), packet: context(body) };
	const question = body.input.findLast(
		(item) => item.role === "user" && typeof item.content === "string"
	)?.content;
	const step = steps.find((item) => item[0] === question);
	assert.ok(step, "Unexpected guided utterance");
	const packet = context(body);
	assert.equal(packet.reviewAvailability, "ready");
	assert.deepEqual(
		packet.preparedReview.files.map((file) => file.path),
		order
	);
	const result = body.input.findLast((item) => item.type === "function_call_output");
	if (!result) {
		assert.ok(body.tools.some((tool) => tool.name === step[1]));
		return { tool: step[1], args: step[2], packet, step };
	}
	const applied = JSON.parse(result.output);
	assert.equal(applied.status, "applied", "Do not narrate an unsettled/ignored UI effect");
	assert.equal(applied.navigation.path, step[3]);
	assert.equal(applied.navigation.paused, step[4]);
	assert.deepEqual(applied.screen, packet.reviewScreen);
	assert.equal(packet.reviewScreen.path, step[3]);
	return {
		text: `${step[3]} is the acknowledged file. ${step[4] ? "The tour is paused." : "The tour is active."}`,
		packet,
		step,
	};
}
function sse(body, selected, id) {
	const output = selected.tool
		? [
				{
					type: "function_call",
					call_id: `smoke-${id}`,
					name: selected.tool,
					arguments: JSON.stringify(selected.args),
					status: "completed",
				},
			]
		: [
				{
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: selected.text }],
				},
			];
	const events = [
		...(selected.text ? [{ type: "response.output_text.delta", delta: selected.text }] : []),
		{
			type: "response.completed",
			response: {
				id: `prepared-smoke-${id}`,
				model: body.model,
				status: "completed",
				output,
				usage: null,
			},
		},
	];
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}
function github(url, method, fixture) {
	assert.equal(method, "GET", "No GitHub writes are permitted");
	const metadata = {
		number: 7,
		state: "open",
		html_url: `https://github.com/${repository}/pull/7`,
		title: "Test-only discount contract review",
		body: "Controlled acceptance repository; not product demo content.",
		changed_files: 3,
		user: { login: "test-owner" },
		base: { sha: fixture.baseSha, repo: { full_name: repository } },
		head: { sha: fixture.headSha, repo: { full_name: repository } },
	};
	if (url === `${apiRoot}/pulls?state=open&per_page=100&page=1&sort=updated&direction=desc`)
		return [metadata];
	if (url === `${apiRoot}/pulls/7`) return metadata;
	if (url === `${apiRoot}/pulls/7/files?per_page=100&page=1`) return fixture.files;
	const parsed = new URL(url);
	const prefix = `/repos/${repository}/contents/`;
	if (
		parsed.origin === "https://api.github.com" &&
		parsed.pathname.startsWith(prefix) &&
		[...parsed.searchParams.keys()].join() === "ref"
	) {
		const path = decodeURIComponent(parsed.pathname.slice(prefix.length));
		const sha = parsed.searchParams.get("ref");
		assert.ok(
			order.includes(path) && [fixture.baseSha, fixture.headSha].includes(sha),
			"Only pinned test content is allowed"
		);
		const bytes = Buffer.from((sha === fixture.baseSha ? base : head)[path]);
		return {
			path,
			type: "file",
			size: bytes.length,
			encoding: "base64",
			content: bytes.toString("base64"),
		};
	}
	throw new Error("Unexpected GitHub endpoint");
}
function assertVisible(ui, step, fixture) {
	assert.equal(ui.path, step[3]);
	assert.equal(ui.paused, String(step[4]));
	assert.equal(ui.loading, "false");
	assert.equal(ui.baseSha, fixture.baseSha);
	assert.equal(ui.headSha, fixture.headSha);
	if (ui.view === "Changes") {
		const patch = fixture.files.find((file) => file.filename === step[3]).patch;
		assert.deepEqual(
			ui.patch,
			patch.split("\n").map((line) => (/^[ +\-]/.test(line) ? line.slice(1) : line))
		);
	} else {
		assert.ok(["Before", "After"].includes(ui.view));
		assert.deepEqual(
			ui.source,
			(ui.view === "Before" ? base : head)[step[3]].trimEnd().split("\n")
		);
	}
	if (step[1] === "open_review_file") assert.deepEqual(ui.selected, [head[step[3]].split("\n")[1]]);
}
async function wait(label, read) {
	for (let i = 0; i < 600; i++) {
		const value = await read();
		if (value) return value;
		await new Promise((done) => setTimeout(done, 50));
	}
	throw new Error(`Timed out waiting for ${label}`);
}
async function native() {
	const { app, BrowserWindow } = require("electron");
	assert.ok(process.versions.electron && !process.env.ELECTRON_RENDERER_URL);
	const owned = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "met-prepared-review-smoke-")));
	const owner = randomUUID();
	fs.writeFileSync(join(owned, ".owner"), owner);
	const fixture = createRepository(owned);
	const userData = join(owned, "profile");
	fs.mkdirSync(userData);
	app.setPath("userData", userData);
	const envPath = join(owned, ".env");
	fs.writeFileSync(
		envPath,
		"MODEL_API_KEY=prepared-smoke-model-only\nGITHUB_TOKEN=prepared-smoke-github-only\n",
		{ mode: 0o600 }
	);
	process.env.METAHACKATHON_ENV_FILE = envPath;
	const reportPath = join(__dirname, "../../out/prepared-review-smoke-report.json");
	fs.mkdirSync(dirname(reportPath), { recursive: true });
	const report = {
		status: "running",
		controlledRepository: true,
		simulatedModel: true,
		simulatedGitHub: true,
		liveSpeech: false,
		restartTested: false,
		fixture,
		preparationCalls: 0,
		contentHTTPReads: 0,
		sourceGroundedPackets: 0,
		turns: [],
		http: [],
		model: [],
		blocked: [],
	};
	const save = () => fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
	save();
	let readUI;
	const forward = globalThis.fetch;
	globalThis.fetch = async (input, options = {}) => {
		const url = String(input.url ?? input);
		const parsed = new URL(url);
		try {
			if (url === endpoint) {
				assert.equal(options.method, "POST");
				const body = JSON.parse(options.body);
				const selected = choose(body);
				assert.equal(body.stream, true);
				assert.equal(body.store, false);
				if (selected.tool === "submit_prepared_review") {
					report.preparationCalls++;
					assert.equal(report.preparationCalls, 1, "Preparation must be cached before the tour");
					assert.equal(selected.packet.pr.baseSha, fixture.baseSha);
					assert.equal(selected.packet.pr.headSha, fixture.headSha);
					assert.deepEqual(
						selected.packet.files.map((file) => file.path),
						fixture.files.map((file) => file.filename)
					);
				} else {
					const source = selected.packet.currentFileSource;
					if (source?.status === "available") {
						assert.equal(source.path, selected.packet.reviewScreen.path);
						for (const side of ["base", "head"]) {
							assert.equal(source[side].commitSha, fixture[`${side}Sha`]);
							assert.equal(source[side].excerpt.text, (side === "base" ? base : head)[source.path]);
							assert.equal(source[side].excerpt.truncated, false);
						}
						report.sourceGroundedPackets++;
					} else {
						assert.ok(!source || source.reason === "source-port-not-configured");
						report.sourceGroundingUnavailable = true;
					}
					if (!selected.tool) assertVisible(await readUI(), selected.step, fixture);
				}
				report.model.push({
					tool: selected.tool ?? null,
					path: selected.packet?.reviewScreen?.path,
					appliedBeforeReply: !selected.tool,
				});
				return sse(body, selected, report.model.length);
			}
			if (parsed.origin === "https://api.github.com") {
				report.http.push({ url, method: options.method ?? "GET" });
				const value = github(url, options.method ?? "GET", fixture);
				if (parsed.pathname.includes("/contents/")) report.contentHTTPReads++;
				return Response.json(value);
			}
			if (
				parsed.protocol === "http:" &&
				!parsed.username &&
				!parsed.password &&
				["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
			)
				return forward(input, { ...options, redirect: "error" });
			throw new Error("External network is forbidden");
		} catch (error) {
			report.blocked.push({ origin: parsed.origin, message: error.message });
			throw error;
		}
	};
	const fail = (error) => {
		report.status = "failed";
		report.error = String(error.message);
		save();
		app.quit();
	};
	const deadline = setTimeout(
		() => fail(new Error("Prepared-review smoke hard deadline")),
		120_000
	);
	try {
		await import(
			pathToFileURL(resolve(process.argv[2] ?? join(__dirname, "../../out/main/index.js"))).href
		);
		await app.whenReady();
		app.on("will-quit", () => {
			clearTimeout(deadline);
			try {
				assert.equal(fs.readFileSync(join(owned, ".owner"), "utf8"), owner);
				fs.rmSync(owned, { recursive: true });
				report.cleanup = { ownedTempRemoved: !fs.existsSync(owned) };
			} catch (error) {
				report.status = "failed";
				report.error = error.message;
			}
			save();
			console.log(`PREPARED_REVIEW_SMOKE_${report.status.toUpperCase()}: ${reportPath}`);
			if (report.status !== "passed") app.exit(1);
		});
		const win = await wait("main window", () => BrowserWindow.getAllWindows()[0]);
		await wait("built renderer", () => !win.webContents.isLoadingMainFrame());
		const js = (code) => win.webContents.executeJavaScript(code);
		const rpc = async (type, path, input) => {
			const result = await js(
				`window.electron.trpc.request(${JSON.stringify({ type, path, input: { json: input ?? null } })})`
			);
			assert.ok(!result.error, `${path}: ${JSON.stringify(result.error)}`);
			return result.result.data.json;
		};
		readUI = () =>
			js(
				`(() => { const w=document.querySelector('[aria-label="Prepared review"]'), m=document.querySelector('main.conversation-main'), e=[...document.querySelectorAll('article.exchange')].at(-1); return {path:w?.dataset.reviewPath,reviewId:w?.dataset.reviewId,paused:w?.dataset.reviewPaused,loading:w?.dataset.reviewLoading,progress:w?.dataset.reviewProgressPath,baseSha:w?.dataset.baseSha,headSha:w?.dataset.headSha,sessionId:m?.dataset.sessionId,turnId:m?.dataset.turnId,generation:Number(m?.dataset.generation),phase:e?.dataset.phase,answer:e?.querySelector('.assistant-message p')?.textContent,view:w?.querySelector('.source-tabs [aria-pressed="true"]')?.textContent,source:[...document.querySelectorAll('.source-row code')].map(e=>e.textContent),patch:[...document.querySelectorAll('.patch-row code')].map(e=>e.textContent),selected:[...document.querySelectorAll('.source-selected code')].map(e=>e.textContent)}; })()`
			);
		const Database = require("better-sqlite3");
		const stored = () => {
			const db = new Database(join(userData, "metahackathon.db"), { readonly: true });
			try {
				return {
					connection: db.prepare("SELECT * FROM review_connection").get(),
					plans: db.prepare("SELECT * FROM review_prepared").all(),
					progress: db.prepare("SELECT * FROM review_progress").all(),
					posts: db.prepare("SELECT count(*) n FROM runtime_submissions").get().n,
				};
			} finally {
				db.close();
			}
		};
		const config = await rpc("query", "app.config");
		assert.equal(config.envPath, envPath);
		assert.deepEqual(config.configured, { meta: true, github: true, elevenlabs: false });
		assert.equal(config.voiceId, null);
		await rpc("mutation", "reviews.connect", { repository, localPath: fixture.localPath });
		await js(
			`([...document.querySelectorAll('header nav button')].find(e=>e.textContent.trim()==='Repository')).click()`
		);
		const ready = await wait("cached ready review", async () => {
			const inbox = await rpc("query", "reviews.inbox");
			assert.ok(!inbox.error, inbox.error);
			const item = inbox.items.find((item) => item.pr.id === prId);
			assert.notEqual(item?.status, "error", item?.error);
			return item?.status === "ready" ? item : null;
		});
		assert.deepEqual(
			ready.prepared.files.map((file) => file.path),
			order
		);
		assert.equal(ready.prepared.evidence, "inferred-from-github");
		const cached = stored();
		assert.equal(cached.plans.length, 1);
		assert.equal(cached.connection.local_path, fixture.localPath);
		assert.deepEqual(JSON.parse(cached.plans[0].data_json), ready.prepared);
		assert.ok(!(await readUI()).reviewId);
		report.cachedBeforeOpen = {
			prepared: ready.prepared,
			sql: cached,
			preparationCalls: report.preparationCalls,
		};
		await wait("visible ready inbox entry", () =>
			js(
				`!!document.querySelector('[data-pr-id="${prId}"][data-review-status="ready"] button.review-inbox-select:not(:disabled)')`
			)
		);
		await js(
			`document.querySelector('[data-pr-id="${prId}"][data-review-status="ready"] button.review-inbox-select').click()`
		);
		await wait("first pinned file", async () => {
			const state = await readUI();
			return state.path === order[0] && state.loading === "false";
		});
		await js(
			`document.querySelector('[data-testid="conversation-toggle"][aria-expanded="false"]')?.click()`
		);
		for (const step of steps) {
			const prior = await readUI();
			await js(
				`(() => { const e=document.querySelector('textarea[name="question"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(step[0])}); e.dispatchEvent(new Event('input',{bubbles:true})); })()`
			);
			await wait("controlled composer", () =>
				js(`!!document.querySelector('[aria-label="Send message"]:not(:disabled)')`)
			);
			await js(`document.querySelector('textarea[name="question"]').form.requestSubmit()`);
			const ui = await wait("settled tour reply", async () => {
				const state = await readUI();
				assert.notEqual(state.phase, "error");
				return state.turnId !== prior.turnId && state.phase === "complete" ? state : null;
			});
			const turn = { sessionId: ui.sessionId, turnId: ui.turnId, generation: ui.generation };
			const result = await rpc("query", "conversation.poll", {
				...turn,
				afterSequence: 0,
				limit: 100,
			});
			assert.equal(result.status, "completed");
			assert.equal(ui.answer, result.text);
			const action = result.actions.find((action) => action.kind === "review-navigation");
			assert.ok(action);
			assert.equal(action.navigation.path, step[3]);
			assert.equal(action.navigation.paused, step[4]);
			assert.deepEqual(
				{ sessionId: action.sessionId, turnId: action.turnId, generation: action.generation },
				turn
			);
			assert.equal(action.navigation.reviewId, ready.prepared.id);
			assertVisible(ui, step, fixture);
			assert.equal(ui.progress, step[3]);
			const file = await rpc("query", "reviews.file", {
				prId,
				reviewId: ready.prepared.id,
				path: step[3],
			});
			assert.equal(file.base.content, base[step[3]]);
			assert.equal(file.head.content, head[step[3]]);
			assert.equal(
				file.base.content,
				git(fixture.localPath, "show", `${fixture.baseSha}:${step[3]}`)
			);
			assert.equal(
				file.head.content,
				git(fixture.localPath, "show", `${fixture.headSha}:${step[3]}`)
			);
			const patch = fixture.files.find((file) => file.filename === step[3]).patch;
			assert.equal(file.patch, patch);
			const detail = await rpc("query", "reviews.get", { prId });
			assert.equal(detail.progress.path, step[3]);
			assert.equal(detail.progress.paused, step[4]);
			const sql = stored();
			assert.equal(sql.progress.length, 1);
			assert.deepEqual(JSON.parse(sql.progress[0].data_json), detail.progress);
			report.turns.push({ question: step[0], turn, ui, progress: detail.progress });
			console.log(`PREPARED_REVIEW_STEP_PASS: ${step[1]} -> ${step[3]}`);
		}
		assert.equal(report.preparationCalls, 1);
		assert.equal(
			report.contentHTTPReads,
			0,
			"Present local commits must be read locally, not substituted by mock GitHub contents"
		);
		assert.deepEqual(report.blocked, []);
		if (process.env.PREPARED_REVIEW_REQUIRE_SOURCE === "1")
			assert.ok(report.sourceGroundedPackets > 0, "Source-grounding callback must be connected");
		assert.equal(fs.readFileSync(join(fixture.localPath, "logic.ts"), "utf8"), fixture.dirty);
		assert.equal(git(fixture.localPath, "status", "--porcelain=v1"), fixture.status);
		assert.equal(git(fixture.localPath, "rev-parse", "HEAD").trim(), fixture.headSha);
		const final = stored();
		assert.equal(final.posts, 0);
		assert.deepEqual(JSON.parse(final.plans[0].data_json), ready.prepared);
		report.persistence = final;
		report.dirtyUnchangedSha256 = createHash("sha256").update(fixture.dirty).digest("hex");
		report.actualRendererIPC = true;
		report.status = "passed";
		save();
		const holdMs = Math.min(
			60_000,
			Math.max(0, Number(process.env.PREPARED_REVIEW_SMOKE_HOLD_MS) || 0)
		);
		if (holdMs) {
			await js(
				`document.querySelector('[data-testid="conversation-toggle"][aria-expanded="true"]')?.click()`
			);
			console.log("PREPARED_REVIEW_VISUAL_READY: controlled source; optional transcript hidden");
			await new Promise((done) => setTimeout(done, holdMs));
		}
		app.quit();
	} catch (error) {
		fail(error);
	}
}
async function selfCheck() {
	assert.deepEqual(
		analysis().files.map((file) => file.path),
		order
	);
	assert.notDeepEqual(order, [...order].reverse());
	const fixture = { baseSha: "a".repeat(40), headSha: "b".repeat(40), files: [] };
	assert.equal(github(`${apiRoot}/pulls/7`, "GET", fixture).head.sha, fixture.headSha);
	assert.throws(() => github(`${apiRoot}/pulls/7/comments`, "POST", fixture));
	assert.throws(() => github("https://api.github.com/user", "GET", fixture));
	const packet = {
		reviewAvailability: "ready",
		preparedReview: { files: order.map((path) => ({ path })) },
		reviewScreen: { path: "contracts.ts", paused: false },
	};
	const body = {
		input: [
			{ role: "user", content: steps[0][0] },
			{ role: "user", content: [{ type: "input_text", text: JSON.stringify(packet) }] },
		],
		tools: [{ name: "resume_review" }],
	};
	assert.equal(choose(body).tool, "resume_review");
	body.input.push({ type: "function_call_output", output: JSON.stringify({ status: "ignored" }) });
	assert.throws(() => choose(body));
	body.input.at(-1).output = JSON.stringify({
		status: "applied",
		navigation: { path: "contracts.ts", paused: false },
		screen: packet.reviewScreen,
	});
	assert.ok(choose(body).text);
	assert.equal(
		sse({ model: "test-only" }, choose(body), 1).headers.get("content-type"),
		"text/event-stream"
	);
	const ui = {
		path: "contracts.ts",
		paused: "false",
		loading: "false",
		baseSha: fixture.baseSha,
		headSha: fixture.headSha,
		view: "After",
		source: head["contracts.ts"].trimEnd().split("\n"),
	};
	assertVisible(ui, steps[0], fixture);
	assert.throws(() =>
		assertVisible({ ...ui, source: ["working-tree counterfeit"] }, steps[0], fixture)
	);
	console.log(
		"PREPARED_REVIEW_SELF_CHECK_PASS: ordering, GET-only endpoint allowlist, receipt gate, SSE; no Electron/Git/SQLite/network launched"
	);
}
if (process.argv.includes("--self-check"))
	selfCheck().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
else if (process.versions.electron || require.main === module)
	native().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
