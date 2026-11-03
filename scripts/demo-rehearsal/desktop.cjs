// Explicit root-owned live-model/live-TTS rehearsal. Only ASR and source services are controlled.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const cp = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks");
const { syncBuiltinESMExports } = require("node:module");
const { pathToFileURL } = require("node:url");
const { parseEnv } = require("node:util");
const { createServer } = require("node:http");
const { app, BrowserWindow, session, ipcMain, shell } = require("electron");
const { createSources } = require("./providers.cjs");
const { instrumentModels } = require("./live-transport.cjs");
const { installSyntheticInput } = require("./media.cjs");
const root = path.resolve(__dirname, "../..");
const desktop = path.join(root, "apps/desktop");
const textDiagnostics = process.argv.includes("--text-diagnostics");
const mockTTS = process.argv.includes("--mock-tts");
assert(
	!(mockTTS && textDiagnostics),
	"Mock TTS exercises the media path; do not combine with text diagnostics"
);
assert(
	!textDiagnostics ||
		process.argv.includes("--interactive") ||
		[
			"review",
			"collaboration",
			"delegation",
			"slack",
			"variants",
			"actions",
			"work",
			"planning",
			"fix",
		].some((suite) => process.argv.includes(`--suite=${suite}`)),
	"Text diagnostics are limited to named subsets; full acceptance requires live voice"
);
assert(
	process.argv.includes("--live"),
	"Use --live to explicitly enable actual model and ElevenLabs calls."
);
const owned = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "musefocus-rehearsal-")));
const runId = randomUUID();
fs.writeFileSync(path.join(owned, ".owner"), runId, { mode: 0o600 });
const profile = path.join(owned, "profile");
fs.mkdirSync(profile, { mode: 0o700 });
app.setPath("userData", profile);
const report = {
	runId,
	startedAt: new Date().toISOString(),
	suite: process.argv.find((a) => a.startsWith("--suite="))?.slice(8) ?? "common",
	interactive: process.argv.includes("--interactive"),
	sourceCommit: cp
		.execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })
		.trim(),
	sourceDirty: Boolean(
		cp
			.execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
				cwd: root,
				encoding: "utf8",
			})
			.trim()
	),
	liveModels: true,
	liveElevenLabs: !textDiagnostics && !mockTTS,
	mockTTS,
	mockTTSDescription: mockTTS
		? "Synthetic tone PCM; no intelligible speech or ElevenLabs latency claimed"
		: null,
	scriptedASR: !textDiagnostics,
	textDiagnostics,
	physicalMicrophone: false,
	physicalSpeakerMuted: !process.argv.includes("--audible"),
	controlledSourceProviders: true,
	liveSourceWrites: false,
	status: "starting",
	profile,
	modelEvents: [],
	sourceRequests: [],
	simulatedWrites: [],
	speechSegments: [],
	actions: [],
	agentErrors: [],
	voiceErrors: [],
	controlErrors: [],
	startedTurns: [],
	manualActions: [],
	turns: [],
	assertions: [],
	blocked: [],
};
const state = {
	slackEnabled: false,
	allowSlackQuestion: false,
	allowApproval: false,
	checkStatus: "pending",
};
const save = () =>
	fs.writeFileSync(path.join(owned, "report.json"), JSON.stringify(report, null, 2), {
		mode: 0o600,
	});
const rows = (p) => {
	try {
		return fs
			.readFileSync(p, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
	} catch {
		return [];
	}
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const trace = new AsyncLocalStorage();
let fixture;
let win;
let server;
let previewServer;
let previewUrl;
let currentLabel = null;
let stopping = false;
const children = [];
const cleanup = () => {
	for (const child of children)
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
};
for (const [signal, code] of [
	["SIGINT", 130],
	["SIGTERM", 143],
])
	process.once(signal, () => {
		report.status = "interrupted";
		save();
		cleanup();
		app.exit(code);
	});
const originalFetch = globalThis.fetch;
const originalFork = cp.fork;
const originalSpawn = cp.spawn;
const originalHandle = ipcMain.handle;
const js = (code) => win.webContents.executeJavaScript(code, true);
async function wait(label, read, timeout = 60000) {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		const value = await read();
		if (value) return value;
		await sleep(100);
	}
	throw Error(`Timed out: ${label}`);
}
async function rpc(type, name, input = {}) {
	const r = await js(
		`window.electron.trpc.request(${JSON.stringify({ type, path: name, input: { json: input } })})`
	);
	assert(!r.error, `${name}: ${JSON.stringify(r.error)}`);
	return r.result?.data?.json;
}
const ui = () =>
	js(
		`({voice:document.querySelector('footer.voice-bar')?.dataset.handsFree,phase:document.querySelector('main.conversation-main')?.dataset.conversationState,error:document.querySelector('.voice-bar-error')?.textContent||'',messages:[...document.querySelectorAll('article.exchange')].map(e=>({id:e.dataset.turnId,phase:e.dataset.phase,question:e.querySelector('.user-message p')?.textContent||'',answer:e.querySelector('.assistant-message p')?.textContent||''})),workspaceText:document.querySelector('[aria-label="Workspace canvases"]')?.innerText?.slice(0,20000)||''})`
	);
function diagnostics() {
	return [
		...rows(path.join(profile, "diagnostics/conversation.jsonl.1")),
		...rows(path.join(profile, "diagnostics/conversation.jsonl")),
	];
}
async function startListening() {
	await wait("Voice ready", () =>
		js("document.querySelector('footer.voice-bar')?.textContent.includes('Voice ready')")
	);
	await js("document.querySelector('button[aria-label=\"Start conversation\"]').click()");
	await wait("hands-free active", async () => {
		const s = await ui();
		if (s.error) throw Error(s.error);
		return s.voice === "true";
	});
	await wait("synthetic mic", () => js("window.__rehearsal.read().tracks.some(s=>s==='live')"));
}
async function restartListening() {
	if (textDiagnostics) {
		const prior = await js("document.querySelector('main.conversation-main')?.dataset.sessionId");
		win.webContents.reload();
		await wait("fresh typed session after actual renderer reload", async () => {
			if (win.webContents.isLoadingMainFrame()) return false;
			const next = await js("document.querySelector('main.conversation-main')?.dataset.sessionId");
			return next && next !== prior;
		});
		return;
	}
	await js(
		"[...document.querySelectorAll('dialog[open] button')].find(e=>e.getAttribute('aria-label')?.startsWith('Close '))?.click()"
	);
	await js("document.querySelector('button[aria-label=\"End conversation\"]').click()");
	await wait("hands-free ended", async () => (await ui()).voice === "false");
	await startListening();
}
async function say(text, options = {}) {
	if (textDiagnostics) return sayTyped(text, options);
	const id = options.id ?? `turn-${report.turns.length + 1}`;
	currentLabel = id;
	const submittedAt = Date.now();
	fs.writeFileSync(path.join(owned, "input.json"), JSON.stringify({ id, text }), { mode: 0o600 });
	console.log(`REHEARSAL_INPUT ${id}: ${text}`);
	await js("window.__rehearsal.pulse(400)");
	const accepted = await wait(
		"scripted text accepted",
		() =>
			rows(path.join(owned, "speech.jsonl")).find(
				(r) => r.kind === "scripted-text-accepted" && r.id === id && r.at >= submittedAt
			),
		20000
	);
	const identity = {
		sessionId: accepted.sessionId,
		turnId: accepted.turnId,
		generation: accepted.generation,
	};
	const turnHash = hash(identity);
	const textEvent = () =>
		diagnostics().find((r) => r.stage === "transcript-final" && r.turnHash === turnHash);
	const audioEvent = () =>
		diagnostics().find((r) => r.stage === "first-audio" && r.turnHash === turnHash);
	let result;
	if (options.firstAudioOnly) {
		await wait("actual first PCM", audioEvent, 60000);
		result = await ui();
	} else
		result = await wait(
			"spoken turn settles",
			async () => {
				const s = await ui();
				if (s.error) throw Error(s.error);
				const e = s.messages.find((e) => e.id === identity.turnId);
				if (e?.phase === "error") throw Error(`Turn failed: ${e.answer || s.error || text}`);
				if (options.stop)
					return ["idle", "cancelled", "complete"].includes(s.phase) && s.voice === "true"
						? s
						: false;
				return e?.phase === "complete" ? s : false;
			},
			90000
		);
	const e = result.messages.find((e) => e.id === identity.turnId);
	const a = audioEvent();
	const t = textEvent();
	const models = report.modelEvents.filter(
		(r) => r.kind === "model-request" && r.context?.turnId === identity.turnId
	);
	const record = {
		id,
		text,
		identity,
		submittedAt,
		acceptedAt: accepted.at,
		finishedAt: Date.now(),
		answer: e?.answer ?? "",
		phase: e?.phase ?? result.phase,
		firstAudioAt: a?.at ?? null,
		mockTTS,
		textAcceptedToAudioMs: a ? Math.round(Date.parse(a.at) - accepted.at) : null,
		transcriptToAudioMs: a && t ? Math.round(a.elapsedMs - t.elapsedMs) : null,
		submittedToAudioMs: a ? Math.round(Date.parse(a.at) - submittedAt) : null,
		modelRounds: models.length,
		modelRequestIds: models.map((m) => m.id),
		stop: !!options.stop,
	};
	report.turns.push(record);
	save();
	console.log(
		`REHEARSAL_REPLY ${id}: ${record.answer}\nMETRICS ${id}: ${JSON.stringify({ firstAudioMs: record.textAcceptedToAudioMs, rounds: record.modelRounds, phase: record.phase })}`
	);
	if (options.stop) {
		assert.equal(models.length, 0, "Stop must use zero model requests");
		assert(
			!report.speechSegments.some((s) => s.turnId === identity.turnId),
			"Stop must not enqueue new speech"
		);
	} else if (!options.firstAudioOnly) {
		assert(a, "A text-only answer is not spoken proof");
		assert(record.answer.trim(), "Expected an actual model reply");
	}
	currentLabel = null;
	return record;
}
async function sayTyped(text, options = {}) {
	assert(!options.stop && !options.firstAudioOnly, "Spoken control cases require live voice mode");
	const id = options.id ?? `turn-${report.turns.length + 1}`;
	currentLabel = id;
	const submittedAt = Date.now();
	console.log(`TEXT_DIAGNOSTIC_INPUT ${id}: ${text}`);
	const closed = await js(
		"(()=>{const b=[...document.querySelectorAll('dialog[open] button')].find(e=>e.getAttribute('aria-label')?.startsWith('Close '));if(!b)return false;b.click();return true;})()"
	);
	if (closed) {
		report.manualActions.push({ at: Date.now(), kind: "close-displayed-dialog-before-typing" });
		await wait("dialog closed before typed followup", () =>
			js("!document.querySelector('dialog[open]')")
		);
	}
	if (!(await js("!!document.querySelector('textarea[aria-label=\"Message\"]')")))
		await js("document.querySelector('button[aria-label=\"Conversation and typing\"]').click()");
	await wait("typing field", () =>
		js("!!document.querySelector('textarea[aria-label=\"Message\"]')")
	);
	await js(
		`(()=>{const n=document.querySelector('textarea[aria-label="Message"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(n,${JSON.stringify(text)});n.dispatchEvent(new Event('input',{bubbles:true}));})()`
	);
	await wait("send enabled", () =>
		js("!document.querySelector('button[aria-label=\"Send message\"]').disabled")
	);
	await js("document.querySelector('button[aria-label=\"Send message\"]').click()");
	const started = await wait(
		"actual typed ingress",
		() => report.startedTurns.find((t) => t.label === id && t.at >= submittedAt),
		20000
	);
	let firstPublishedAt = null;
	const result = await wait(
		"typed turn settles",
		async () => {
			const s = await ui();
			if (s.error) throw Error(s.error);
			const exchange = s.messages.find((m) => m.id === started.identity.turnId);
			if (exchange?.answer && firstPublishedAt === null) firstPublishedAt = Date.now();
			if (exchange?.phase === "error") throw Error("Actual typed turn failed");
			return exchange?.phase === "complete" ? exchange : false;
		},
		120000
	);
	const models = report.modelEvents.filter(
		(m) => m.kind === "model-request" && m.context?.turnId === started.identity.turnId
	);
	const record = {
		id,
		text,
		identity: started.identity,
		submittedAt,
		finishedAt: Date.now(),
		answer: result.answer,
		phase: result.phase,
		firstAudioAt: null,
		textAcceptedToAudioMs: null,
		textToPublishedMs: firstPublishedAt === null ? null : firstPublishedAt - submittedAt,
		modelRounds: models.length,
		modelRequestIds: models.map((m) => m.id),
		textDiagnostics: true,
	};
	report.turns.push(record);
	currentLabel = null;
	save();
	console.log(
		`TEXT_DIAGNOSTIC_REPLY ${id}: ${record.answer}\nTEXT_METRICS ${id}: ${JSON.stringify({ publishedMs: record.textToPublishedMs, rounds: record.modelRounds })}`
	);
	return record;
}
const button = async (label) => {
	const code = `[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(label)}&&!e.disabled)`;
	await wait(label, () => js(`!!(${code})`));
	await js(`(${code}).click()`);
};
const shellQuote = (s) => `'${s.replace(/'/g, "'\\''")}'`;
async function main() {
	const envFile =
		process.argv.find((a) => a.startsWith("--env-file="))?.slice(11) ??
		"/Users/Werk/Documents/Repositories/MetaHackathon/.env";
	const values = parseEnv(fs.readFileSync(envFile, "utf8"));
	const key = values.MODEL_API_KEY ?? values.META_API_KEY;
	assert(
		key && (mockTTS || (values.ELEVENLABS_API_KEY && values.ELEVENLABS_VOICE_ID)),
		"Configure model, ElevenLabs and voice ID in the supplied private .env"
	);
	const cfg = path.join(owned, "rehearsal.env");
	fs.writeFileSync(
		cfg,
		`MODEL_API_KEY=${JSON.stringify(key)}\nELEVENLABS_API_KEY=${JSON.stringify(mockTTS ? "mock-tts-no-provider-key" : values.ELEVENLABS_API_KEY)}\nELEVENLABS_VOICE_ID=${JSON.stringify(mockTTS ? "mock-tts-voice" : values.ELEVENLABS_VOICE_ID)}\nGITHUB_TOKEN=rehearsal-controlled-github\nLINEAR_API_KEY=rehearsal-controlled-linear\nSLACK_USER_TOKEN=xoxp-rehearsal-controlled\nSLACK_APP_ID=ADEMO01\nSLACK_INTERNAL_APP=1\nCODING_PROVIDER=meta-api\n`,
		{ mode: 0o600 }
	);
	if (mockTTS)
		fs.writeFileSync(path.join(owned, "mock-tts.enabled"), "synthetic PCM only\n", { mode: 0o600 });
	fs.copyFileSync(path.join(__dirname, "scripted-input.py"), path.join(owned, "scripted-input.py"));
	const python = path.join(root, "services/voice/.venv/bin/python");
	assert(fs.existsSync(python), "Prepare the repository voice Python environment first");
	const wrapper = path.join(owned, "scripted-voice");
	fs.writeFileSync(
		wrapper,
		`#!/bin/sh\nexec ${shellQuote(python)} ${shellQuote(path.join(owned, "scripted-input.py"))} "$@"\n`,
		{ mode: 0o700 }
	);
	process.env.METAHACKATHON_ENV_FILE = cfg;
	process.env.METAHACKATHON_VOICE_PYTHON = wrapper;
	fixture = await require(path.join(desktop, "out/demo-rehearsal/prepare.cjs")).prepare(
		owned,
		path.join(__dirname, "data"),
		process.argv.find((a) => a.startsWith("--reuse-reviews="))?.slice(16)
	);
	report.reusedReviewsFromRunId = fixture.reusedFromRunId;
	const companionModule = (file) => import(pathToFileURL(path.join(fixture.localPath, file)).href);
	const [{ createApp }, { createWorkStore }, { demoItems }] = await Promise.all([
		companionModule("src/http/app.mjs"),
		companionModule("src/work/store.mjs"),
		companionModule("src/work/demo-items.mjs"),
	]);
	previewServer = createApp(createWorkStore(demoItems()));
	await new Promise((resolve, reject) => {
		previewServer.once("error", reject);
		previewServer.listen(0, "127.0.0.1", resolve);
	});
	previewUrl = `http://127.0.0.1:${previewServer.address().port}`;
	const sources = createSources(fixture, state, report);
	const live = instrumentModels(
		originalFetch,
		(row) => {
			report.modelEvents.push(row);
			save();
		},
		() => trace.getStore()
	);
	globalThis.fetch = async (input, init = {}) => {
		const url = new URL(String(input.url ?? input));
		if (url.href === "https://api.meta.ai/v1/responses") return live(input, init);
		if (
			["https://api.github.com", "https://api.linear.app", "https://slack.com"].includes(url.origin)
		)
			return sources(input, init);
		if (url.protocol === "http:" && url.hostname === "127.0.0.1") {
			if (url.pathname === "/speak") {
				const body = JSON.parse(init.body);
				report.speechSegments.push({
					at: Date.now(),
					sessionId: body.sessionId,
					turnId: body.turnId,
					generation: body.generation,
					speechId: body.speechId,
					text: body.text,
				});
				save();
			}
			const response = await originalFetch(input, { ...init, redirect: "error" });
			if (url.pathname === "/poll" && response.ok) {
				const page = await response.clone().json();
				for (const event of page.events ?? [])
					if (event.kind === "error" && event.diagnostic) {
						report.voiceErrors.push({ at: Date.now(), diagnostic: event.diagnostic });
						save();
					}
			}
			return response;
		}
		report.blocked.push(`${url.origin}${url.pathname}`);
		throw Error("Unapproved rehearsal network");
	};
	const hook = path.join(owned, "child-live-hook.mjs");
	fs.writeFileSync(
		hook,
		`import {createRequire} from 'node:module';const require=createRequire(import.meta.url);require(${JSON.stringify(path.join(__dirname, "live-transport.cjs"))}).childHook(${JSON.stringify(path.join(owned, "child-models.jsonl"))});\n`,
		{ mode: 0o600 }
	);
	cp.fork = (module, args, options) => {
		assert.equal(path.basename(module), "coding-worker.js");
		const child = originalFork(module, args, {
			...options,
			execArgv: ["--import", pathToFileURL(hook).href, ...(options.execArgv ?? [])],
		});
		children.push(child);
		return child;
	};
	cp.spawn = (command, args, options) => {
		if (path.basename(String(command)) === "git")
			assert(
				!args.some((a) => ["push", "fetch", "pull", "merge", "ls-remote"].includes(a)),
				"Git network/publication is forbidden"
			);
		const child = originalSpawn(command, args, options);
		children.push(child);
		return child;
	};
	syncBuiltinESMExports();
	ipcMain.handle = function (channel, handler) {
		if (channel !== "trpc:request") return originalHandle.call(this, channel, handler);
		return originalHandle.call(this, channel, async (event, request) => {
			const input = request.input?.json;
			const context =
				request.path === "conversation.start"
					? {
							label: currentLabel,
							sessionId: input.sessionId,
							turnId: input.turnId,
							generation: input.generation,
						}
					: trace.getStore();
			if (request.path === "conversation.start")
				report.startedTurns.push({
					at: Date.now(),
					label: currentLabel,
					inputMode: input.inputMode,
					identity: {
						sessionId: input.sessionId,
						turnId: input.turnId,
						generation: input.generation,
					},
				});
			return trace.run(context, async () => {
				const result = await handler(event, request);
				if (request.path === "conversation.poll") {
					for (const item of result.result?.data?.json?.events ?? [])
						if (item.kind === "error") {
							report.agentErrors.push({ at: Date.now(), message: item.message });
							save();
						}
				}
				if (
					[
						"workspace.applied",
						"hub.operate",
						"prFixes.start",
						"prApprovals.confirm",
						"day.operate",
					].includes(request.path)
				)
					report.actions.push({
						at: Date.now(),
						path: request.path,
						kind: input?.operation?.kind,
						status: result.result?.data?.json?.status,
						error: !!result.error,
					});
				return result;
			});
		});
	};
	shell.openExternal = async () => {
		throw Error("External browsers disabled in isolated rehearsal");
	};
	app.on("browser-window-created", (_, w) => {
		w.setFocusable(false);
		w.setIgnoreMouseEvents(true);
		w.webContents.setAudioMuted(report.physicalSpeakerMuted);
	});
	const restrict = (s) => {
		s.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, done) => {
			let allow = false;
			try {
				const u = new URL(details.url);
				allow =
					["file:", "data:", "blob:", "about:", "devtools:"].includes(u.protocol) ||
					(u.protocol === "http:" && u.hostname === "127.0.0.1");
			} catch {}
			if (!allow) report.blocked.push("Chromium remote request");
			done({ cancel: !allow });
		});
	};
	app.on("session-created", restrict);
	await import(pathToFileURL(path.join(desktop, "out/main/index.js")).href);
	await app.whenReady();
	restrict(session.defaultSession);
	win = await wait("default window", () => BrowserWindow.getAllWindows()[0]);
	await wait("renderer", () => !win.webContents.isLoadingMainFrame());
	win.setTitle(
		textDiagnostics
			? "MuseFocus — live model text diagnostics, voice NOT exercised"
			: mockTTS
				? "MuseFocus — real models, MOCK speech, simulated source writes"
				: "MuseFocus — live model/voice rehearsal, source writes simulated"
	);
	await js(`(${installSyntheticInput.toString()})()`);
	await wait(
		"hub",
		async () => {
			try {
				return (await rpc("query", "hub.snapshot")).reviews.length === 3;
			} catch {
				return false;
			}
		},
		60000
	);
	console.log(
		"Preparing reviews through the actual model; startup is outside response latency measurements."
	);
	await wait(
		"live prepared reviews",
		async () => {
			const inbox = await rpc("query", "reviews.inbox");
			if (inbox.items.some((i) => i.status === "error"))
				throw Error(
					JSON.stringify(inbox.items.filter((i) => i.status === "error").map((i) => i.error))
				);
			return inbox.items.length === 3 && inbox.items.every((i) => i.status === "ready");
		},
		180000
	);
	if (!textDiagnostics) await startListening();
	report.status = "ready";
	save();
	const token = randomUUID();
	server = createServer(async (req, res) => {
		res.setHeader("content-type", "application/json");
		if (
			req.method !== "POST" ||
			req.url !== "/control" ||
			req.headers["x-rehearsal-control"] !== token ||
			req.headers.origin
		) {
			res.writeHead(403);
			return res.end("{}");
		}
		try {
			let raw = "";
			for await (const p of req) {
				raw += p;
				if (raw.length > 40000) throw Error("Input too large");
			}
			const command = JSON.parse(raw);
			let result;
			if (command.command === "say")
				result = await say(command.text, {
					id: command.id,
					stop: command.text.trim().toLowerCase().replace(/[.!]/g, "") === "stop",
				});
			else if (command.command === "status")
				result = {
					status: report.status,
					owned,
					report: path.join(owned, "report.json"),
					turns: report.turns.length,
				};
			else if (command.command === "inspect") result = await ui();
			else if (command.command === "stop") {
				result = { stopping: true };
				setTimeout(() => app.quit(), 100);
			} else throw Error("Unknown rehearsal command");
			res.end(JSON.stringify(result));
		} catch (error) {
			report.controlErrors.push({ at: Date.now(), label: currentLabel, message: error.message });
			save();
			res.writeHead(400);
			res.end(JSON.stringify({ error: error.message }));
		}
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	fs.writeFileSync(
		path.join(desktop, "out/demo-rehearsal/active.json"),
		JSON.stringify(
			{ port: server.address().port, token, owned, report: path.join(owned, "report.json") },
			null,
			2
		),
		{ mode: 0o600 }
	);
	console.log(`${textDiagnostics ? "TEXT_DIAGNOSTIC_READY" : "LIVE_REHEARSAL_READY"} ${owned}`);
	if (!process.argv.includes("--interactive")) {
		const {
			common,
			full,
			collaboration,
			slack,
			review,
			variants,
			planning,
			fix,
		} = require("./scenarios.cjs");
		if (process.argv.includes("--suite=fix"))
			await fix({ say, rpc, ui, state, fixture, report, assert, js, wait, button, owned });
		else if (process.argv.includes("--suite=planning"))
			await planning({ say, rpc, ui, state, fixture, report, assert, js, wait, button, owned });
		else if (process.argv.includes("--suite=variants"))
			await variants({ say, rpc, ui, state, fixture, report, assert, js, wait, button, owned });
		else if (process.argv.includes("--suite=review"))
			await review({
				say,
				rpc,
				ui,
				state,
				fixture,
				report,
				assert,
				js,
				wait,
				button,
				owned,
				previewUrl,
				restartListening,
			});
		else if (process.argv.includes("--suite=slack"))
			await slack({ say, rpc, ui, state, fixture, report, assert, js, wait, button, owned });
		else if (
			process.argv.includes("--suite=collaboration") ||
			process.argv.includes("--suite=delegation")
		)
			await collaboration({
				say,
				rpc,
				ui,
				state,
				fixture,
				report,
				assert,
				js,
				wait,
				button,
				owned,
				skipFix: process.argv.includes("--suite=delegation"),
			});
		else if (!process.argv.includes("--suite=actions") && !process.argv.includes("--suite=work"))
			await common({ say, rpc, ui, state, fixture, report, assert, js, wait, button, owned });
		if (
			process.argv.includes("--suite=all") ||
			process.argv.includes("--suite=actions") ||
			process.argv.includes("--suite=work")
		)
			await full({
				workOnly: process.argv.includes("--suite=work"),
				say,
				rpc,
				ui,
				state,
				fixture,
				report,
				assert,
				js,
				wait,
				button,
				owned,
				previewUrl,
				restartListening,
			});
		report.status = "completed";
		save();
		console.log(
			`${textDiagnostics ? "TEXT_DIAGNOSTIC_COMPLETED" : "LIVE_REHEARSAL_COMPLETED"} ${path.join(owned, "report.json")}`
		);
		if (process.argv.includes("--exit")) app.quit();
	}
}
app.on("will-quit", () => {
	stopping = true;
	server?.close();
	previewServer?.close();
	save();
	cleanup();
});
const deadline = setTimeout(
	() => {
		report.error = "Rehearsal exceeded 25 minute budget";
		save();
		cleanup();
		app.exit(1);
	},
	25 * 60 * 1000
);
main().catch(async (error) => {
	report.status = "failed";
	report.error = error.message;
	if (win && !win.isDestroyed()) report.lastUI = await ui().catch(() => null);
	save();
	console.error(
		`${textDiagnostics ? "TEXT_DIAGNOSTIC_FAILED" : "LIVE_REHEARSAL_FAILED"} ${error.message}\n${path.join(owned, "report.json")}`
	);
	cleanup();
	app.exit(1);
});
app.on("quit", () => {
	clearTimeout(deadline);
	fs.rmSync(path.join(owned, "rehearsal.env"), { force: true });
	if (report.status === "failed") process.exitCode = 1;
});
