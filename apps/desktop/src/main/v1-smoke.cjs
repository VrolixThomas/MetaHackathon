// Root only: env -u ELECTRON_RUN_AS_NODE electron src/main/v1-smoke.cjs [built-main]
// Worker validation: node --check this-file; node this-file --self-check (no Electron import).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const { tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const endpoint = "https://api.meta.ai/v1/responses";
const questions = [
	"Hello, I am testing a simple conversation.",
	"What did I just say?",
	"Please take a moment before replying.",
];
const replies = [
	"Hello! What would you like to talk about?",
	`You said: ${questions[0]}`,
	"LATE_V1_REPLY_MUST_NOT_APPEAR",
];
const dummy = "v1-smoke-dummy-model-key-not-a-real-credential";
function expectedHistory(index) {
	return questions
		.slice(0, index)
		.flatMap((text, i) => [
			{ role: "user", content: text },
			{ role: "assistant", content: replies[i] },
		])
		.concat({ role: "user", content: questions[index] });
}
function validateRequest(body, index) {
	assert.ok(index < 3, "Unexpected additional model request");
	assert.deepEqual(body.tools ?? [], []);
	assert.ok(
		!/prId|screenContext|fixture|Noor|stackable|shop-web|selectedPullRequest/i.test(
			JSON.stringify(body.input)
		)
	);
	assert.deepEqual(
		body.input,
		expectedHistory(index),
		"Follow-up must include actual prior user AND assistant messages"
	);
	assert.equal(body.stream, true);
	assert.equal(body.store, false);
}
function response(body, index) {
	const text = replies[index];
	const output = [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }];
	const events = [
		{ type: "response.output_text.delta", delta: text },
		{
			type: "response.completed",
			response: {
				id: `v1-smoke-${index}`,
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
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function wait(label, read) {
	for (let n = 0; n < 400; n++) {
		const value = await read();
		if (value) return value;
		await sleep(50);
	}
	throw new Error(`Timed out: ${label}`);
}
async function native() {
	const { app, BrowserWindow } = require("electron");
	assert.ok(
		process.versions.electron && !process.env.ELECTRON_RENDERER_URL,
		"Root must run the built app with Electron"
	);
	const owned = fs.mkdtempSync(join(tmpdir(), "metahackathon-v1-smoke-"));
	const marker = randomUUID();
	const envPath = join(owned, ".env");
	fs.writeFileSync(join(owned, ".owner"), marker, { mode: 0o600 });
	fs.writeFileSync(envPath, `MODEL_API_KEY=${dummy}\n`, { mode: 0o600 });
	process.env.METAHACKATHON_ENV_FILE = envPath;
	app.setPath("userData", owned);
	const reportPath = join(__dirname, "../../out/v1-smoke-report.json");
	fs.mkdirSync(dirname(reportPath), { recursive: true });
	const report = {
		simulatedModel: true,
		liveSpeech: false,
		actualRendererIPC: false,
		status: "running",
		envPath,
		turns: [],
		blocked: [],
	};
	const save = () => fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
	save();
	let releaseLate;
	const requests = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, options = {}) => {
		const address = String(input.url ?? input);
		const url = new URL(address);
		if (address !== endpoint) {
			if (
				url.protocol === "http:" &&
				!url.username &&
				!url.password &&
				["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
			)
				return originalFetch(input, { ...options, redirect: "error" });
			report.blocked.push(url.origin);
			throw new Error("V1 smoke forbids external requests");
		}
		assert.equal(options.method, "POST");
		assert.ok(
			new Headers(options.headers).get("authorization") === `Bearer ${dummy}`,
			"Only the temporary dummy key may reach the simulated model"
		);
		const body = JSON.parse(options.body);
		const index = requests.length;
		validateRequest(body, index);
		requests.push(body.input);
		if (index === 2)
			return new Promise((done) => {
				releaseLate = () => done(response(body, index));
			});
		return response(body, index);
	};
	let exiting = false;
	const fail = (error) => {
		report.status = "failed";
		report.error = String(error.message ?? error)
			.split(dummy)
			.join("[DUMMY]");
		releaseLate?.();
		save();
		if (!exiting) {
			exiting = true;
			app.quit();
		}
	};
	const deadline = setTimeout(() => fail(new Error("V1 native smoke hard deadline")), 90_000);
	try {
		await import(
			pathToFileURL(resolve(process.argv[2] ?? join(__dirname, "../../out/main/index.js"))).href
		);
		await app.whenReady();
		// Registered after main's listeners: main awaits disposal and closes its database first.
		app.on("will-quit", () => {
			clearTimeout(deadline);
			try {
				assert.equal(fs.readFileSync(join(owned, ".owner"), "utf8"), marker);
				fs.rmSync(owned, { recursive: true });
				report.cleanup = { appQuit: true, ownedTempRemoved: !fs.existsSync(owned) };
			} catch (error) {
				report.status = "failed";
				report.error = String(error.message);
			}
			save();
			console.log(`V1_SMOKE_${report.status.toUpperCase()}: ${reportPath}`);
			if (report.status !== "passed") app.exit(1);
		});
		const win = await wait("main window", () => BrowserWindow.getAllWindows()[0]);
		await wait("renderer", () => !win.webContents.isLoadingMainFrame());
		const js = (code) => win.webContents.executeJavaScript(code);
		const openOption = async (testId) => {
			await js(`document.querySelector('[data-testid="workspace-more"]').click()`);
			await wait("visible workspace menu", () =>
				js(`document.querySelector('#workspace-more')?.open === true`)
			);
			await js(`document.querySelector('[data-testid="${testId}"]').click()`);
		};
		const rpc = async (type, path, input) => {
			const result = await js(
				`window.electron.trpc.request(${JSON.stringify({ type, path, input: { json: input ?? null } })})`
			);
			assert.ok(!result.error, `${path}: ${JSON.stringify(result.error)}`);
			return result.result.data.json;
		};
		const snapshot = () =>
			js(
				`(() => { const m=document.querySelector('main[data-session-id]'), e=[...document.querySelectorAll('article[data-turn-id]')].at(-1); return {text:document.body.innerText,sessionId:m?.dataset.sessionId,turnId:m?.dataset.turnId,generation:Number(m?.dataset.generation),phase:e?.dataset.phase,question:e?.querySelector('.user-message p')?.textContent,answer:e?.querySelector('.assistant-message p')?.textContent||'',count:document.querySelectorAll('article[data-turn-id]').length}; })()`
			);
		const initial = await wait("empty V1", async () => {
			const s = await snapshot();
			return s.sessionId ? s : null;
		});
		assert.equal(initial.count, 0);
		assert.equal(await js(`document.querySelector('#conversation-panel')?.hidden`), true);
		assert.ok(
			await js(
				`document.querySelector('[data-testid="voice-control"]')?.getBoundingClientRect().height > 0`
			)
		);
		report.optionalTranscript = true;
		const audioState = await js(`(async () => {
			const audio = new AudioContext();
			try {
				await Promise.race([audio.resume(), new Promise((_, reject) => setTimeout(() => reject(Error('Voice audio stayed suspended')), 2000))]);
				return audio.state;
			} finally { await audio.close(); }
		})()`);
		assert.equal(audioState, "running");
		report.audioWithoutRendererGesture = true;
		assert.ok(
			!/Load local demo|Noor|stackable|shop-web|finance-service|#1284|#412/i.test(initial.text)
		);
		const config = await rpc("query", "app.config");
		assert.deepEqual(Object.keys(config).sort(), [
			"configured",
			"envPath",
			"microphone",
			"voiceId",
		]);
		assert.equal(config.envPath, envPath);
		assert.deepEqual(config.configured, { meta: true, elevenlabs: false, github: false });
		assert.equal(config.voiceId, null);
		assert.ok(
			["not-determined", "granted", "denied", "restricted", "unknown"].includes(config.microphone)
		);
		assert.ok(!JSON.stringify(config).includes(dummy));
		assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
		const credentials = await rpc("query", "runtime.credentialStatus");
		assert.ok(
			credentials.every(
				(row) => row.storage === "env-file" && typeof row.configured === "boolean" && !row.secret
			)
		);
		report.config = config;
		report.envMode = "0600";
		await openOption("configuration-toggle");
		await wait("configuration path", () =>
			js(
				`document.querySelector('[data-testid="env-path"]')?.textContent === ${JSON.stringify(envPath)}`
			)
		);
		assert.ok(!(await snapshot()).text.includes(dummy));
		await js(`document.querySelector('#configuration .workspace-dialog-heading button').click()`);
		await openOption("conversation-toggle");
		const submit = async (index) => {
			const old = await snapshot();
			await js(
				`(() => { const e=document.querySelector('textarea[name="question"]'); if(!e) throw Error('Composer missing'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(questions[index])}); e.dispatchEvent(new Event('input',{bubbles:true})); })()`
			);
			await wait("controlled input accepted", () =>
				js(`!!document.querySelector('button[aria-label="Send message"]:not(:disabled)')`)
			);
			await js(`document.querySelector('textarea[name="question"]').form.requestSubmit()`);
			return wait("submitted turn", async () => {
				const s = await snapshot();
				return s.turnId && s.turnId !== old.turnId && s.question === questions[index]
					? { sessionId: s.sessionId, turnId: s.turnId, generation: s.generation }
					: null;
			});
		};
		const poll = (turn) =>
			rpc("query", "conversation.poll", { ...turn, afterSequence: 0, limit: 100 });
		for (let index = 0; index < 2; index++) {
			const turn = await submit(index);
			const ui = await wait("rendered reply", async () => {
				const s = await snapshot();
				assert.notEqual(s.phase, "error");
				return s.phase === "complete" ? s : null;
			});
			const result = await poll(turn);
			assert.equal(result.status, "completed");
			assert.equal(result.text, replies[index]);
			assert.equal(ui.answer, result.text);
			assert.deepEqual(result.actions, []);
			report.turns.push({ turn, question: ui.question, answer: ui.answer, status: result.status });
		}
		const third = await submit(2);
		await wait("delayed provider", () => releaseLate);
		await js(
			`(() => { const e=document.querySelector('button[data-testid="interrupt-reply"]'); if(!e || !e.getBoundingClientRect().width) throw Error('Visible Stop missing'); e.click(); })()`
		);
		await wait("real cancellation RPC", async () => (await poll(third)).status === "cancelled");
		releaseLate();
		await sleep(100);
		const cancelled = await poll(third);
		const finalUI = await snapshot();
		assert.equal(cancelled.status, "cancelled");
		assert.deepEqual(cancelled.actions, []);
		assert.equal(cancelled.text, "");
		assert.equal(finalUI.phase, "cancelled");
		assert.ok(!finalUI.text.includes(replies[2]));
		await rpc("mutation", "conversation.release", { sessionId: third.sessionId });
		assert.equal((await poll(third)).status, "stale");
		assert.equal(requests.length, 3);
		assert.deepEqual(report.blocked, []);
		assert.equal(win.contentView.children.length, 0);
		assert.equal(fs.readFileSync(envPath, "utf8"), `MODEL_API_KEY=${dummy}\n`);
		report.historyVerified = true;
		report.cancelledLateSuppressed = true;
		report.actualRendererIPC = true;
		report.status = "passed";
		save();
		exiting = true;
		app.quit();
	} catch (error) {
		fail(error);
	}
}

if (process.argv.includes("--self-check")) {
	for (let i = 0; i < 3; i++)
		validateRequest({ input: expectedHistory(i), tools: [], stream: true, store: false }, i);
	assert.throws(() =>
		validateRequest(
			{ input: [{ role: "user", content: questions[1] }], tools: [], stream: true, store: false },
			1
		)
	);
	assert.throws(() =>
		validateRequest(
			{ input: expectedHistory(0), tools: [{ name: "demo" }], stream: true, store: false },
			0
		)
	);
	assert.throws(() =>
		validateRequest({ input: [{ prId: "fixture" }], tools: [], stream: true, store: false }, 0)
	);
	assert.equal(
		response({ model: "test-only" }, 0).headers.get("content-type"),
		"text/event-stream"
	);
	console.log(
		"V1_SELF_CHECK_PASS: 3 histories, 3 rejection checks, SSE; no Electron/network/config reads"
	);
} else if (process.versions.electron || require.main === module)
	native().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
