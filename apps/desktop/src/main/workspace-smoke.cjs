// ROOT ONLY after build: env -u ELECTRON_RUN_AS_NODE electron src/main/workspace-smoke.cjs [built-main]
// Lane: node --check this-file; node this-file --self-check. Neither launches app/Git/server/provider.
// WORKSPACE_SMOKE_HOLD_MS=0..60000 optionally leaves the completed three-file tour for root QA.
// Controlled model/GitHub only; actual default renderer, IPC, native browser, local Git and SQLite.
// Typed display checkpoints do not establish microphone, speech playback or live-provider acceptance.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const { execFileSync } = require("node:child_process");
const { randomUUID, createHash } = require("node:crypto");
const { tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const repository = "test-owner/workspace-case";
const prId = `${repository}#7`;
const endpoint = "https://api.meta.ai/v1/responses";
const apiRoot = `https://api.github.com/repos/${repository}`;
const order = ["contracts.ts", "logic.ts", "tests.ts"];
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
				id: `workspace-smoke-${id}`,
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

const markdown =
	"# Checkout explanation\n\nCONTROLLED_WORKSPACE_DOCUMENT explains the subtotal and discount.\n\n- Keep the total visible.\n- Confirm before payment.\n";
const visual = {
	width: 640,
	height: 400,
	background: "#f1f5f9",
	elements: [
		{ kind: "rect", x: 32, y: 32, width: 576, height: 336, fill: "#ffffff", radius: 16 },
		{
			kind: "text",
			x: 64,
			y: 90,
			text: "Controlled checkout",
			fill: "#0f172a",
			fontSize: 28,
			weight: "bold",
		},
		{
			kind: "text",
			x: 64,
			y: 160,
			text: "Subtotal 100 · Discount 20 · Total 80",
			fill: "#334155",
			fontSize: 20,
		},
		{ kind: "rect", x: 64, y: 240, width: 220, height: 56, fill: "#2563eb", radius: 8 },
		{ kind: "text", x: 88, y: 276, text: "Confirm checkout", fill: "#ffffff", fontSize: 20 },
	],
};
const questions = {
	document: "Write an explanation",
	visual: "Create checkout mockup",
	operate:
		"Inspect the website, type workspace acceptance in Message, then click Send to page two.",
	review: "Show code and open the ready review",
	tour: "Walk me through the PR",
};
const identity = ({ sessionId, turnId, generation }) => ({ sessionId, turnId, generation });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function wait(label, read, ms = 20_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const value = await read();
		if (value) return value;
		await sleep(30);
	}
	throw new Error(`Timed out waiting for ${label}`);
}
function packet(body) {
	const packets = body.input
		.filter((item) => item.role === "user" && Array.isArray(item.content))
		.flatMap((item) =>
			item.content.filter((part) => part.type === "input_text").map((part) => JSON.parse(part.text))
		);
	return packets.at(-1);
}
function currentRound(body) {
	const index = body.input.findLastIndex(
		(item) => item.role === "user" && typeof item.content === "string"
	);
	assert.ok(index >= 0, "A real typed user question is required");
	return { question: body.input[index].content, items: body.input.slice(index + 1) };
}
function choose(body, origin) {
	const context = packet(body);
	const tools = body.tools.map((tool) => tool.name);
	if (tools.includes("submit_prepared_review"))
		return { tool: "submit_prepared_review", args: analysis(), packet: context };
	assert.ok(context.actualWorkspace, "Product must supply actualWorkspace every model round");
	const observation = context.actualWorkspace;
	const { question, items } = currentRound(body);
	const calls = items.filter((item) => item.type === "function_call");
	const results = items.filter((item) => item.type === "function_call_output");
	assert.equal(calls.length, results.length, "Model resumed before the actual tool result");
	for (const result of results) {
		const name = calls.find((call) => call.call_id === result.call_id)?.name;
		assert.equal(
			JSON.parse(result.output).status,
			name === "start_walkthrough" ? "started" : "applied"
		);
	}
	const last = results.at(-1) && JSON.parse(results.at(-1).output);
	if (last?.workspaceSequence !== undefined)
		assert.equal(last.workspaceSequence, observation.workspace.sequence);
	if (last?.primaryId !== undefined) assert.equal(last.primaryId, observation.workspace.primaryId);
	if (last?.review !== undefined) assert.deepEqual(last.review, observation.workspace.review);
	if (last && Object.hasOwn(last, "browser")) {
		const browser = observation.browser;
		assert.deepEqual(
			last.browser,
			browser
				? {
						browserId: browser.browserId,
						sequence: browser.sequence,
						documentId: browser.documentId,
						url: browser.url,
						presented: browser.presented,
					}
				: null
		);
	}
	const call = (tool, args) => {
		assert.ok(tools.includes(tool), `Actual tool is unavailable: ${tool}`);
		return { tool, args, packet: context, question };
	};
	const answer = (text) => ({ text, packet: context, question });
	if (question === questions.document)
		return calls.length
			? answer("The checkout explanation is displayed.")
			: call("write_markdown_explanation", { title: "Checkout explanation", markdown });
	if (question === questions.visual) {
		if (!calls.length)
			return call("create_visual_mock", { title: "Checkout mockup", visual, target: "secondary" });
		if (calls.length === 1) {
			const draft = observation.workspace.canvases.find((canvas) => canvas.kind === "document");
			const mock = observation.workspace.canvases.find((canvas) => canvas.kind === "visual");
			assert.ok(draft && mock, "Layout IDs must come from the actual workspace");
			return call("set_canvas_layout", { primaryId: mock.id, secondaryId: draft.id });
		}
		return answer("The illustrative checkout mockup is displayed beside its explanation.");
	}
	if (question === `Open website ${origin}/one`)
		return calls.length
			? answer("The actual local website is displayed.")
			: call("open_browser", { url: `${origin}/one` });
	if (question === questions.operate) {
		if (!calls.length) return call("probe_browser", {});
		const browser = observation.browser;
		assert.ok(browser?.presented, "Only the actual presented browser may be operated");
		assert.equal(browser.provenance, "website-unverified-revision");
		if (calls.length >= 3) {
			assert.equal(new URL(browser.url).pathname, "/two");
			assert.ok(browser.text.includes("workspace acceptance"));
			return answer("The real form opened page two with workspace acceptance.");
		}
		const kind = calls.length === 1 ? "type" : "click";
		const element = browser.elements.find(
			(item) =>
				item.visible &&
				item.enabled &&
				item.name === (kind === "type" ? "Message" : "Send to page two")
		);
		assert.ok(element, `Real observed ${kind} target is missing`);
		return call("browser_action", {
			action: {
				kind,
				browserId: browser.browserId,
				observationSequence: browser.sequence,
				elementId: element.id,
				...(kind === "type" ? { text: "workspace acceptance" } : {}),
			},
		});
	}
	if (question === questions.review) {
		if (!calls.length) {
			assert.ok(observation.reviews.some((item) => item.status === "ready" && item.pr.id === prId));
			return call("open_ready_review", { prId });
		}
		assert.equal(context.currentFileSource.status, "available");
		return answer("The pinned quote contract is displayed; it adds a discount field.");
	}
	if (question === questions.tour) {
		if (tools.includes("start_walkthrough")) return call("start_walkthrough", {});
		assert.deepEqual(tools, [], "Per-file narration must have tools disabled");
		const path = context.reviewScreen.path;
		assert.ok(order.includes(path));
		return answer(
			{
				"contracts.ts":
					"Quote adds a discount alongside subtotal. This input contract comes first so the calculation has a defined value to consume.",
				"logic.ts":
					"The total function now subtracts quote.discount from quote.subtotal. This connects the input shape to the changed checkout amount.",
				"tests.ts":
					"The check now supplies a discount of 20 and expects 80 from a subtotal of 100. It records the intended result without claiming a test execution.",
			}[path]
		);
	}
	throw new Error("Unexpected controlled typed question");
}
function page(path, message) {
	const escaped = message.replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
	);
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Workspace page ${path === "/one" ? "one" : "two"}</title><style>body{font:20px system-ui;padding:32px;background:#edf1f5;color:#152532}input,button{font:inherit;padding:12px;margin:12px}label{display:block}</style></head><body><h1>Actual workspace website</h1><nav><a href="/one">Page one</a> <a href="/two">Page two</a></nav><p id="page">${path}</p><form action="/two" method="get"><label>Message<input name="message" value="${escaped}"></label><button type="submit">Send to page two</button></form><p id="echo">${escaped}</p></body></html>`;
}
const uiScript = `(() => {
	const w=document.querySelector('[aria-label="Workspace canvases"]'), r=document.querySelector('[aria-label="Prepared review"]'), m=document.querySelector('main.conversation-main'), e=[...document.querySelectorAll('article.exchange')].at(-1);
	return {sequence:Number(w?.dataset.workspaceSequence),primaryId:w?.dataset.primaryCanvas,secondaryId:w?.dataset.secondaryCanvas||null,
		panes:[...document.querySelectorAll('.canvas-pane')].map(p=>({id:p.dataset.canvasId,kind:p.dataset.canvasKind,revision:Number(p.dataset.canvasRevision),text:p.textContent,svg:!!p.querySelector('svg[role="img"]'),svgTexts:[...p.querySelectorAll('svg text')].map(t=>t.textContent)})),
		sessionId:m?.dataset.sessionId,turnId:m?.dataset.turnId,generation:Number(m?.dataset.generation),phase:e?.dataset.phase,answer:e?.querySelector('.assistant-message p')?.textContent??'',
		review:r?{path:r.dataset.reviewPath,reviewId:r.dataset.reviewId,loading:r.dataset.reviewLoading,baseSha:r.dataset.baseSha,headSha:r.dataset.headSha,view:r.dataset.codeView,sequence:Number(r.dataset.screenSequence),source:[...r.querySelectorAll('.source-row code')].map(c=>c.textContent),patch:[...r.querySelectorAll('.patch-row code')].map(c=>c.textContent)}:null,
		conversationVisible:!!document.querySelector('#conversation-panel')?.checkVisibility(),errors:[...document.querySelectorAll('.canvas-error,.review-error')].map(p=>p.textContent)};
})()`;
function assertWorkspace(observation, ui) {
	const snapshot = observation.workspace;
	assert.equal(ui.sequence, snapshot.sequence);
	assert.equal(ui.primaryId, snapshot.primaryId);
	assert.equal(ui.secondaryId, snapshot.secondaryId);
	assert.deepEqual(
		ui.panes.map((pane) => pane.id),
		[snapshot.primaryId, ...(snapshot.secondaryId ? [snapshot.secondaryId] : [])]
	);
	for (const pane of ui.panes) {
		const canvas = snapshot.canvases.find((item) => item.id === pane.id);
		assert.equal(pane.kind, canvas.kind);
		assert.equal(pane.revision, canvas.revision);
		if (canvas.kind === "document") {
			for (const text of [
				"Checkout explanation",
				"CONTROLLED_WORKSPACE_DOCUMENT",
				"Keep the total visible.",
				"Confirm before payment.",
			])
				assert.ok(pane.text.includes(text), `Rendered Markdown is missing ${text}`);
		}
		if (canvas.kind === "visual") {
			assert.equal(pane.svg, true);
			assert.deepEqual(
				pane.svgTexts,
				visual.elements.filter((e) => e.kind === "text").map((e) => e.text)
			);
		}
	}
	assert.deepEqual(ui.errors, []);
}
function assertSource(context, ui, fixture) {
	const source = context.currentFileSource;
	assert.equal(context.currentFilePresentation, "displayed");
	assert.equal(source.status, "available", "Current pinned source must reach the model");
	assert.equal(source.path, ui.review.path);
	assert.equal(ui.review.loading, "false");
	assert.equal(ui.review.baseSha, fixture.baseSha);
	assert.equal(ui.review.headSha, fixture.headSha);
	for (const side of ["base", "head"]) {
		assert.equal(source[side].commitSha, fixture[`${side}Sha`]);
		assert.equal(source[side].excerpt.text, (side === "base" ? base : head)[source.path]);
		assert.equal(source[side].excerpt.truncated, false);
	}
	const patch = fixture.files.find((file) => file.filename === source.path).patch;
	assert.equal(source.patch.excerpt.text, patch);
	if (ui.review.view === "diff")
		assert.deepEqual(
			ui.review.patch,
			patch.split("\n").map((line) => (/^[ +\-]/.test(line) ? line.slice(1) : line))
		);
	else
		assert.deepEqual(
			ui.review.source,
			(ui.review.view === "base" ? base : head)[source.path].trimEnd().split("\n")
		);
}

async function native() {
	assert.ok(
		process.versions.electron && !process.env.ELECTRON_RENDERER_URL,
		"Root must launch built Electron, without a dev renderer"
	);
	const { app, BrowserWindow, ipcMain, webContents, session } = require("electron");
	const holdMs = Number(process.env.WORKSPACE_SMOKE_HOLD_MS ?? 0);
	assert.ok(Number.isInteger(holdMs) && holdMs >= 0 && holdMs <= 60_000);
	const holdStage = process.env.WORKSPACE_SMOKE_HOLD_STAGE ?? "review";
	assert.ok(["review", "visual", "browser"].includes(holdStage));
	const hold = async (stage) => {
		if (holdMs && holdStage === stage) {
			console.log(`WORKSPACE_VISUAL_READY: ${stage}`);
			await sleep(holdMs);
		}
	};
	const owned = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "met-workspace-smoke-")));
	const owner = randomUUID();
	fs.writeFileSync(join(owned, ".owner"), owner, { mode: 0o600 });
	const userData = join(owned, "profile");
	fs.mkdirSync(userData);
	app.setPath("userData", userData);
	const envPath = join(owned, ".env");
	fs.writeFileSync(
		envPath,
		"MODEL_API_KEY=workspace-smoke-model-only\nGITHUB_TOKEN=workspace-smoke-github-only\n",
		{ mode: 0o600 }
	);
	process.env.METAHACKATHON_ENV_FILE = envPath;
	const reportPath = join(__dirname, "../../out/workspace-smoke-report.json");
	fs.mkdirSync(dirname(reportPath), { recursive: true });
	const report = {
		status: "running",
		simulatedModel: true,
		simulatedGitHub: true,
		controlledSite: true,
		actualRendererIPC: false,
		liveSpeech: false,
		microphoneCapture: false,
		steps: [],
		model: [],
		receipts: [],
		requests: [],
		github: [],
		blocked: [],
		preparationCalls: 0,
		contentHTTPReads: 0,
	};
	const save = () => fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
	let fixture;
	let origin;
	let readUI;
	let guest;
	let win;
	const forwardFetch = globalThis.fetch;
	const originalHandle = ipcMain.handle;
	// Observe the real IPC handler; all calls and results pass through unchanged.
	ipcMain.handle = function (channel, handler) {
		if (channel !== "trpc:request") return originalHandle.call(this, channel, handler);
		return originalHandle.call(this, channel, async (event, request) => {
			const audited = ["workspace.applied", "conversation.narrationApplied"].includes(
				request?.path
			);
			const ui = audited && readUI ? await readUI() : null;
			const result = await handler(event, request);
			const data = result?.result?.data?.json;
			if (audited)
				report.receipts.push({
					path: request.path,
					input: request.input?.json,
					result: data ?? result.error,
					ui,
					at: new Date().toISOString(),
				});
			return result;
		});
	};
	const server = http.createServer((request, response) => {
		const url = new URL(request.url, "http://127.0.0.1");
		report.requests.push({ method: request.method, path: request.url });
		if (request.method !== "GET" || !["/one", "/two", "/favicon.ico"].includes(url.pathname)) {
			response.writeHead(404);
			response.end();
			return;
		}
		if (url.pathname === "/favicon.ico") {
			response.writeHead(204);
			response.end();
			return;
		}
		response.writeHead(200, {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"content-security-policy":
				"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
		});
		response.end(page(url.pathname, url.searchParams.get("message") ?? ""));
	});
	let closing;
	let stopping = false;
	const closeServer = () => {
		closing ??= new Promise((done) => {
			server.close(done);
			server.closeAllConnections();
		});
		return closing;
	};
	const stop = async (error) => {
		if (stopping) return;
		stopping = true;
		if (error) {
			report.status = "failed";
			report.error = error.stack ?? String(error);
		}
		save();
		await closeServer();
		app.quit();
	};
	const deadline = setTimeout(
		() => void stop(new Error("Workspace native smoke hard deadline")),
		120_000 + holdMs
	);
	app.on("will-quit", () => {
		clearTimeout(deadline);
		globalThis.fetch = forwardFetch;
		ipcMain.handle = originalHandle;
		try {
			assert.equal(server.listening, false, "Owned loopback server survived cleanup");
			assert.ok(!guest || guest.isDestroyed(), "Native guest survived app disposal");
			assert.equal(fs.readFileSync(join(owned, ".owner"), "utf8"), owner);
			fs.rmSync(owned, { recursive: true });
			report.cleanup = {
				ownedServerClosed: true,
				guestDisposed: true,
				ownedProfileAndRepositoryRemoved: !fs.existsSync(owned),
			};
		} catch (error) {
			report.status = "failed";
			report.error = error.message;
		}
		save();
		console.log(`WORKSPACE_SMOKE_${report.status.toUpperCase()}: ${reportPath}`);
		if (report.status !== "passed") app.exit(1);
	});
	try {
		fixture = createRepository(owned);
		report.fixture = fixture;
		await new Promise((done, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", done);
		});
		origin = `http://127.0.0.1:${server.address().port}`;
		report.origin = origin;
		const restrict = (browserSession) => {
			browserSession.webRequest.onBeforeRequest(
				{ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
				(details, done) => {
					const allowed = new URL(details.url).origin === origin;
					if (!allowed) report.blocked.push({ transport: "chromium", url: details.url });
					done({ cancel: !allowed });
				}
			);
			browserSession.setPermissionRequestHandler((_contents, permission, done) => {
				report.blocked.push({ permission });
				done(false);
			});
		};
		app.on("session-created", restrict);
		void app.whenReady().then(() => restrict(session.defaultSession));
		globalThis.fetch = async (input, options = {}) => {
			const url = String(input.url ?? input);
			try {
				if (url === endpoint) {
					assert.equal(options.method, "POST");
					const body = JSON.parse(options.body);
					assert.equal(body.stream, true);
					assert.equal(body.store, false);
					const selected = choose(body, origin);
					if (selected.tool === "submit_prepared_review") {
						report.preparationCalls++;
						assert.equal(report.preparationCalls, 1);
						assert.equal(selected.packet.pr.baseSha, fixture.baseSha);
						assert.equal(selected.packet.pr.headSha, fixture.headSha);
					} else {
						const ui = await readUI();
						assertWorkspace(selected.packet.actualWorkspace, ui);
						if (selected.packet.reviewScreen?.mode === "review")
							assertSource(selected.packet, ui, fixture);
						const observedBrowser = selected.packet.actualWorkspace.browser;
						if (observedBrowser?.presented) {
							const guests = webContents
								.getAllWebContents()
								.filter(
									(contents) =>
										!contents.isDestroyed() && contents.getURL().startsWith(`${origin}/`)
								);
							assert.equal(guests.length, 1, "Agent and UI must share one native page");
							guest ??= guests[0];
							assert.equal(guests[0].id, guest.id);
							const view = win.contentView.children.find(
								(child) => child.webContents?.id === guest.id
							);
							assert.ok(view?.getVisible(), "Observed page must be the presented native surface");
							const dom = await guest.executeJavaScript(
								`({url:location.href,title:document.title,text:document.body.innerText,echo:document.querySelector('#echo')?.textContent})`
							);
							assert.equal(observedBrowser.url, dom.url);
							assert.equal(observedBrowser.title, dom.title);
							assert.ok(dom.text.includes("Actual workspace website"));
							if (new URL(dom.url).pathname === "/two")
								assert.equal(dom.echo, "workspace acceptance");
						}
					}
					report.model.push({
						question: selected.question,
						tool: selected.tool ?? null,
						args: selected.args,
						packet: selected.packet,
						toolResult: body.input.findLast((item) => item.type === "function_call_output"),
						at: new Date().toISOString(),
					});
					return sse(body, selected, report.model.length);
				}
				if (new URL(url).origin === "https://api.github.com") {
					report.github.push({ url, method: options.method ?? "GET" });
					if (new URL(url).pathname.includes("/contents/")) report.contentHTTPReads++;
					return Response.json(github(url, options.method ?? "GET", fixture));
				}
				if (new URL(url).origin === origin)
					return forwardFetch(input, { ...options, redirect: "error" });
				report.blocked.push({ transport: "main", url });
				throw new Error("Workspace smoke forbids external/provider network");
			} catch (error) {
				report.transportError = { url, message: error.stack ?? String(error) };
				save();
				throw error;
			}
		};
		await import(
			pathToFileURL(resolve(process.argv[2] ?? join(__dirname, "../../out/main/index.js"))).href
		);
		await app.whenReady();
		win = await wait("main window", () => BrowserWindow.getAllWindows()[0]);
		// Keep the native surface visible, but prevent unrelated user clicks/typing from
		// interrupting the controlled walkthrough while the real app is used alongside it.
		if (process.env.WORKSPACE_SMOKE_INTERACTIVE !== "1") {
			win.setTitle("Muse automated workspace check");
			win.setIgnoreMouseEvents(true);
			win.setFocusable(false);
			report.nonInteractiveTestWindow = true;
		}
		await wait("built renderer", () => !win.webContents.isLoadingMainFrame());
		const js = async (code) => {
			try {
				return await win.webContents.executeJavaScript(code);
			} catch (error) {
				report.failedScript = code;
				throw error;
			}
		};
		readUI = () => js(uiScript);
		const rpc = async (type, path, input) => {
			const result = await js(
				`window.electron.trpc.request(${JSON.stringify({ type, path, input: { json: input ?? null } })})`
			);
			assert.ok(!result.error, `${path}: ${JSON.stringify(result.error)}`);
			return result.result.data.json;
		};
		const initial = await wait("default workspace controller", async () => {
			const ui = await readUI();
			return ui.primaryId && ui.sessionId ? ui : null;
		});
		const observe = () => rpc("query", "workspace.observe", { sessionId: initial.sessionId });
		const start = await observe();
		assertWorkspace(start, initial);
		assert.equal(start.workspace.review.mode, "conversation");
		assert.equal(start.browser, null);
		assert.deepEqual(start.reviews, []);
		assert.ok(start.workspace.canvases.every((canvas) => canvas.kind === "review"));
		assert.equal(initial.conversationVisible, false, "Typing is opt-in at startup");
		const config = await rpc("query", "app.config");
		assert.equal(config.envPath, envPath);
		assert.equal(config.configured.elevenlabs, false);
		assert.equal(config.voiceId, null);
		await js(`document.querySelector('[data-testid="workspace-more"]').click()`);
		await wait("More menu", () => js(`document.querySelector('#workspace-more')?.open === true`));
		await js(`document.querySelector('[data-testid="conversation-toggle"]').click()`);
		await wait("optional typed composer", () =>
			js(`document.querySelector('textarea[name="question"]')?.checkVisibility()`)
		);
		const submit = async (question) => {
			const prior = await readUI();
			await js(
				`(() => {const e=document.querySelector('textarea[name="question"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(question)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`
			);
			await wait("enabled Send", () =>
				js(`!!document.querySelector('[aria-label="Send message"]:not(:disabled)')`)
			);
			await js(`document.querySelector('textarea[name="question"]').form.requestSubmit()`);
			const ui = await wait(
				"settled typed turn",
				async () => {
					const state = await readUI();
					if (state.phase === "error") {
						report.failedUI = state;
						const failed = await rpc("query", "conversation.poll", {
							...identity(state),
							afterSequence: 0,
							limit: 100,
						});
						report.failedTurn = failed;
						throw new Error(
							`Conversation failed: ${failed.events
								.filter((event) => event.kind === "error")
								.map((event) => event.message)
								.join("; ")}`
						);
					}
					return state.turnId !== prior.turnId && state.phase === "complete" ? state : null;
				},
				35_000
			);
			const result = await rpc("query", "conversation.poll", {
				...identity(ui),
				afterSequence: 0,
				limit: 100,
			});
			assert.equal(result.status, "completed");
			assert.equal(ui.answer, result.text);
			assert.ok(result.actions.length > 0, "Product tool must emit actual UI actions");
			for (const action of result.actions) assert.deepEqual(identity(action), identity(ui));
			const observation = await observe();
			assertWorkspace(observation, ui);
			report.steps.push({ question, turn: identity(ui), ui, actions: result.actions, observation });
			console.log(`WORKSPACE_STEP_PASS: ${question}`);
			return { result, ui, observation };
		};
		await submit(questions.document);
		const mock = await submit(questions.visual);
		assert.deepEqual(
			mock.ui.panes.map((pane) => pane.kind),
			["visual", "document"]
		);
		await hold("visual");
		await submit(`Open website ${origin}/one`);
		await submit(questions.operate);
		if (process.env.WORKSPACE_SMOKE_LAYOUT_CHECKS === "1") {
			const settled = async () => {
				const ui = await readUI();
				return (await observe()).workspace.sequence === ui.sequence;
			};
			const geometry = () =>
				js(`(()=>{
				const rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.floor(r.width),height:Math.floor(r.height)}};
				const pane=document.querySelector('.native-browser-pane');
				return {conversation:rect(document.querySelector('#conversation-panel')),page:rect(document.querySelector('[data-native-browser-content]')),pane:rect(pane),chrome:rect(pane?.querySelector('.browser-chrome')),mode:pane?.querySelector('select[aria-label="Browser viewport"]')?.value};
			})()`);
			const nativeView = () =>
				win.contentView.children.find((child) => child.webContents?.id === guest?.id);
			const fits = async (label, mode = "desktop") =>
				wait(label, async () => {
					const box = await geometry();
					const observed = await observe();
					const bounds = nativeView()?.getBounds();
					report.layoutChecking = { label, box, bounds, browser: observed.browser };
					if (!box.page || !bounds || !observed.browser?.presented || box.mode !== mode)
						return null;
					if (mode === "desktop") {
						if (!Object.keys(box.page).every((key) => Math.abs(box.page[key] - bounds[key]) <= 1))
							return null;
						if (
							observed.browser.viewport.width !== box.page.width ||
							observed.browser.viewport.height !== box.page.height
						)
							return null;
					} else {
						if (observed.browser.viewport.width !== 390 || observed.browser.viewport.height !== 844)
							return null;
						if (Math.abs(bounds.x + bounds.width / 2 - (box.page.x + box.page.width / 2)) > 1)
							return null;
						if (Math.abs(bounds.y + bounds.height / 2 - (box.page.y + box.page.height / 2)) > 1)
							return null;
					}
					return {
						label,
						box,
						bounds,
						viewport: observed.browser.viewport,
						browserId: observed.browser.browserId,
					};
				});
			await js(
				`[...document.querySelectorAll('.canvas-layout-button')].find(e=>e.textContent==='Single pane').click()`
			);
			await wait("single pane rendered", () => js(`!document.querySelector('.workspace-divider')`));
			await wait("single pane receipt", settled);
			const first = await fits("desktop fills browser pane beside left conversation");
			assert.ok(first.box.conversation.x + first.box.conversation.width <= first.box.page.x);
			assert.ok(first.box.conversation.width >= 300 && first.box.conversation.width <= 440);
			assert.ok(first.box.chrome.height <= 52);
			assert.ok(first.box.page.y - (first.box.pane.y + first.box.chrome.height) <= 1);
			const select = (mode) =>
				js(
					`(()=>{const e=document.querySelector('select[aria-label="Browser viewport"]');e.value=${JSON.stringify(mode)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`
				);
			await select("phone");
			const phoneLayout = await fits("phone stays fixed and centered", "phone");
			await wait("phone receipt", settled);
			await select("desktop");
			await fits("desktop fills pane after phone toggle");
			await wait("desktop receipt", settled);
			win.setSize(1280, 820);
			const resized = await fits("desktop follows window resize");
			assert.equal(resized.browserId, first.browserId);
			assert.ok(resized.viewport.width < first.viewport.width);
			await js(`document.querySelector('[aria-label="Hide conversation"]').click()`);
			const hidden = await fits("desktop expands when conversation closes");
			assert.ok(hidden.viewport.width > resized.viewport.width);
			await js(`document.querySelector('[data-testid="workspace-more"]').click()`);
			await wait("More for conversation reopen", () =>
				js(`document.querySelector('#workspace-more')?.open===true`)
			);
			await js(`document.querySelector('[data-testid="conversation-toggle"]').click()`);
			const restored = await fits("desktop refits beside reopened conversation");
			assert.equal(restored.browserId, first.browserId);
			assert.equal(
				await guest.executeJavaScript(`document.querySelector('#echo').textContent`),
				"workspace acceptance"
			);
			report.layouts = [first, phoneLayout, resized, hidden, restored];
			if (process.env.WORKSPACE_SMOKE_CAPTURE_DIR) {
				const directory = resolve(process.env.WORKSPACE_SMOKE_CAPTURE_DIR);
				fs.mkdirSync(directory, { recursive: true });
				const { desktopCapturer, systemPreferences } = require("electron");
				let capture;
				let method = "electron-window-capture";
				if (systemPreferences.getMediaAccessStatus("screen") === "granted") {
					const sources = await desktopCapturer.getSources({
						types: ["window"],
						thumbnailSize: { width: 1280, height: 820 },
						fetchWindowIcons: false,
					});
					const source = sources.find((item) => item.id === win.getMediaSourceId());
					if (source && !source.thumbnail.isEmpty()) {
						capture = source.thumbnail;
						method = "owned-native-window";
					}
				}
				const path = join(directory, "browser-workspace-after.png");
				fs.rmSync(path, { force: true });
				if (capture) {
					fs.writeFileSync(path, capture.toPNG());
					report.screenshot = { path, method, controlledSite: true };
				} else {
					// Capture only this owned native window; renderer capture omits its native page.
					try {
						execFileSync(
							"/usr/sbin/screencapture",
							["-x", "-l", win.getMediaSourceId().split(":")[1], path],
							{ timeout: 5000, stdio: "pipe" }
						);
						report.screenshot = {
							path,
							method: "owned-native-window-screencapture",
							controlledSite: true,
						};
					} catch {
						report.screenshot = { unavailable: true, reason: "native-window-capture-unavailable" };
					}
				}
			}
		}
		await hold("browser");
		// Connecting test setup is separate from agent effects: the agent discovers the real ready inbox.
		await rpc("mutation", "reviews.connect", { repository, localPath: fixture.localPath });
		const ready = await wait("durable prepared review", async () => {
			const inbox = await rpc("query", "reviews.inbox");
			const entry = inbox.items.find((item) => item.pr.id === prId);
			assert.notEqual(entry?.status, "error", entry?.error);
			return entry?.status === "ready" ? entry : null;
		});
		assert.deepEqual(
			ready.prepared.files.map((file) => file.path),
			order
		);
		await submit(questions.review);
		const tour = await submit(questions.tour);
		const navigations = tour.result.actions.filter(
			(action) => action.kind === "workspace-canvas" && action.effect.navigation
		);
		const checkpoints = tour.result.actions.filter(
			(action) => action.kind === "narration-checkpoint"
		);
		assert.deepEqual(
			navigations.map((action) => action.effect.navigation.path),
			order,
			"One request must tour all three real files"
		);
		assert.equal(checkpoints.length, 3);
		for (let index = 0; index < order.length; index++) {
			const action = navigations[index];
			const checkpoint = checkpoints[index];
			assert.ok(tour.result.actions.indexOf(action) < tour.result.actions.indexOf(checkpoint));
			if (index < 2)
				assert.ok(
					tour.result.actions.indexOf(checkpoint) <
						tour.result.actions.indexOf(navigations[index + 1])
				);
			const receipt = report.receipts.find(
				(entry) =>
					entry.input.requestId === checkpoint.requestId && entry.result?.status === "accepted"
			);
			assert.ok(receipt, "Default typed binding must acknowledge every checkpoint");
			assert.equal(receipt.input.status, "displayed");
			assert.equal(receipt.ui.review.path, order[index]);
			assert.equal(receipt.ui.review.loading, "false");
			assert.equal(receipt.ui.answer.length, checkpoint.throughTextLength);
			assert.equal(receipt.ui.review.sequence, checkpoint.screenSequence);
		}
		for (const step of report.steps)
			for (const action of step.actions.filter((action) => action.kind === "workspace-canvas")) {
				const receipt = report.receipts.find(
					(entry) =>
						entry.input.requestId === action.requestId && entry.result?.status === "accepted"
				);
				assert.ok(receipt, "Product workspace effect needs a settled display receipt");
				assert.equal(receipt.input.status, "applied");
				assertWorkspace({ workspace: receipt.input.workspace }, receipt.ui);
			}
		// A delayed duplicate cannot advance another turn; no forged current acknowledgement is sent.
		const lastReceipt = report.receipts.findLast(
			(entry) => entry.path === "conversation.narrationApplied"
		);
		assert.deepEqual(await rpc("mutation", "conversation.narrationApplied", lastReceipt.input), {
			status: "stale",
		});
		const Database = require("better-sqlite3");
		const db = new Database(join(userData, "metahackathon.db"), { readonly: true });
		try {
			const plans = db.prepare("SELECT * FROM review_prepared").all();
			const progress = db.prepare("SELECT * FROM review_progress").all();
			assert.equal(plans.length, 1);
			assert.deepEqual(JSON.parse(plans[0].data_json), ready.prepared);
			assert.equal(progress.length, 1);
			assert.equal(JSON.parse(progress[0].data_json).path, order.at(-1));
			assert.equal(db.prepare("SELECT count(*) n FROM runtime_submissions").get().n, 0);
			report.persistence = {
				plans: plans.length,
				progress: JSON.parse(progress[0].data_json),
				githubPosts: 0,
			};
		} finally {
			db.close();
		}
		const storedPath = join(userData, "workspace", "canvases.json");
		const savedDrafts = JSON.parse(fs.readFileSync(storedPath, "utf8"));
		assert.deepEqual(savedDrafts.canvases.map(({ canvas }) => canvas.kind).sort(), [
			"document",
			"visual",
		]);
		assert.equal(fs.statSync(storedPath).mode & 0o777, 0o600);
		await js(`document.querySelector('button[aria-label="Close Checkout explanation"]').click()`);
		await wait("closed document archived", async () => {
			const observed = await observe();
			return (
				observed.savedCanvases.some((canvas) => canvas.title === "Checkout explanation") &&
				!observed.workspace.canvases.some((canvas) => canvas.kind === "document")
			);
		});
		await wait("Recent control", () =>
			js(
				`!![...document.querySelectorAll('.canvas-layout-button')].find(e => e.textContent === 'Recent')`
			)
		);
		await js(
			`[...document.querySelectorAll('.canvas-layout-button')].find(e => e.textContent === 'Recent').click()`
		);
		await wait("Recent dialog", () => js(`!!document.querySelector('#canvas-history[open]')`));
		await js(
			`[...document.querySelectorAll('#canvas-history button')].find(e => e.textContent.includes('Checkout explanation')).click()`
		);
		await wait("saved document reopened", async () => {
			const observed = await observe();
			const ui = await readUI();
			return (
				observed.workspace.primaryId === ui.primaryId &&
				ui.panes.some(
					(pane) => pane.kind === "document" && pane.text.includes("CONTROLLED_WORKSPACE_DOCUMENT")
				)
			);
		});
		report.durableCanvases = {
			count: savedDrafts.canvases.length,
			privateFile: true,
			reopenedThroughUI: true,
		};
		assert.equal(
			report.contentHTTPReads,
			0,
			"Pinned local source must not be replaced by controlled GitHub contents"
		);
		assert.equal(fs.readFileSync(join(fixture.localPath, "logic.ts"), "utf8"), fixture.dirty);
		assert.equal(git(fixture.localPath, "status", "--porcelain=v1"), fixture.status);
		assert.equal(git(fixture.localPath, "rev-parse", "HEAD").trim(), fixture.headSha);
		report.dirtyUnchangedSha256 = createHash("sha256").update(fixture.dirty).digest("hex");
		assert.deepEqual(report.blocked, []);
		assert.equal(report.preparationCalls, 1);
		report.actualRendererIPC = true;
		report.staleNarrationReceiptRejected = true;
		report.status = "passed";
		save();
		await hold("review");
		await stop();
	} catch (error) {
		await stop(error);
	}
}

async function selfCheck() {
	assert.deepEqual(
		analysis().files.map((file) => file.path),
		order
	);
	assert.equal(page("/two", '<script>"&').includes("&lt;script&gt;&quot;&amp;"), true);
	const fixture = { baseSha: "a".repeat(40), headSha: "b".repeat(40), files: [] };
	assert.equal(github(`${apiRoot}/pulls/7`, "GET", fixture).head.sha, fixture.headSha);
	assert.throws(() => github(`${apiRoot}/pulls/7/comments`, "POST", fixture));
	assert.throws(() => github("https://api.github.com/user", "GET", fixture));
	const observation = {
		workspace: {
			sequence: 1,
			primaryId: "doc",
			secondaryId: null,
			canvases: [{ id: "doc", kind: "document", revision: 1 }],
		},
	};
	const ui = {
		sequence: 1,
		primaryId: "doc",
		secondaryId: null,
		panes: [{ id: "doc", kind: "document", revision: 1, text: markdown }],
		errors: [],
	};
	assertWorkspace(observation, ui);
	assert.throws(() => assertWorkspace(observation, { ...ui, primaryId: "stale" }));
	const body = {
		model: "test-only",
		tools: [{ name: "write_markdown_explanation" }],
		input: [
			{ role: "user", content: questions.document },
			{
				role: "user",
				content: [{ type: "input_text", text: JSON.stringify({ actualWorkspace: observation }) }],
			},
		],
	};
	const selected = choose(body, "http://127.0.0.1:1");
	assert.equal(selected.tool, "write_markdown_explanation");
	assert.equal(selected.args.markdown, markdown);
	assert.equal(sse(body, selected, 1).headers.get("content-type"), "text/event-stream");
	body.input.push(
		{ type: "function_call", name: selected.tool, call_id: "one" },
		{ type: "function_call_output", call_id: "one", output: JSON.stringify({ status: "ignored" }) }
	);
	assert.throws(() => choose(body, "http://127.0.0.1:1"));
	console.log(
		"WORKSPACE_SELF_CHECK_PASS: controlled tool schema, GET allowlist, HTML escaping, visible-canvas/receipt guards, SSE; no Electron/Git/SQLite/server/network launched"
	);
}
if (process.argv.includes("--self-check"))
	selfCheck().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
else if (process.versions.electron || require.main === module)
	native().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
