// ROOT ONLY, after building the default App in the integration checkout (from apps/desktop):
// env -u ELECTRON_RUN_AS_NODE electron src/main/day-smoke.cjs [out/main/index.js]
// AUTHOR ONLY: node --check this-file; node this-file --self-check (no Electron import).
// Requires root's day service/SQLite migration, My day renderer bindings, dayItem/ensureDayItem
// acknowledgement guards and confirm_local_answer. No seeded source/task or successful RPC mock.
// No worker child, live provider, microphone, second app process or process-restart claim.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const childProcess = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const { syncBuiltinESMExports } = require("node:module");
const { tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { Script } = require("node:vm");

const MODEL_ENDPOINT = "https://api.meta.ai/v1/responses";
const DUMMY_KEY = "day-smoke-controlled-model-key-not-a-live-credential";
const ACTOR = { workspaceId: "local", userId: "local" };
const TITLE = "Follow up on the note I wrote during this day queue check";
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const dataOf = (response) => response?.result?.data?.json;
const primary = (workspace) => workspace.canvases.find((item) => item.id === workspace.primaryId);
const contentOf = ({
	sequence: _sequence,
	contentSequence: _contentSequence,
	centerSection: _section,
	...content
}) => content;
let emergencyCleanup;

function removeOwned(owned, ownerPath, owner) {
	assert.equal(fs.realpathSync(owned), owned);
	assert.equal(fs.lstatSync(owned).isSymbolicLink(), false);
	assert.equal(fs.readFileSync(ownerPath, "utf8"), owner, "Refusing to remove an unowned profile");
	fs.rmSync(owned, { recursive: true, maxRetries: 3, retryDelay: 25 });
	return !fs.existsSync(owned);
}

function localURL(address) {
	try {
		return ["file:", "data:", "blob:", "about:", "devtools:"].includes(new URL(address).protocol);
	} catch {
		return false;
	}
}

// Transport-only fallback. This first UI-only increment deliberately requests no model turn.
// An unexpected call is recorded as a failure even though its bounded SSE can finish shutdown.
function modelResponse(body) {
	assert.equal(body.stream, true);
	assert.equal(body.store, false);
	assert.equal(typeof body.model, "string");
	const text = "Controlled day harness response; no source or worker result was generated.";
	const output = [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }];
	const events = [
		{ type: "response.output_text.delta", delta: text },
		{
			type: "response.completed",
			response: {
				id: "day-smoke-only",
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

function assertItemFrames(ui, receivedAt, sequence, itemId, title) {
	assert.equal(ui?.state.itemId, itemId);
	assert.equal(ui.state.title, title);
	assert.equal(ui.state.visible, true, "Applied day receipt preceded the actual item frame");
	assert.equal(ui.state.sequence, sequence);
	const frames = ui.frames.filter(
		(frame) =>
			frame.at <= receivedAt &&
			frame.sequence === sequence &&
			frame.scheduledSequence === sequence &&
			frame.itemId === itemId &&
			frame.title === title &&
			frame.visible
	);
	assert.ok(
		new Set(frames.map((frame) => frame.timestamp)).size >= 2,
		"Applied day receipt preceded two distinct observed app animation frames"
	);
	return frames;
}

function assertDisplayedReceipt(receipt, itemId, title) {
	assert.equal(receipt.input.status, "applied");
	assert.equal(receipt.result?.status, "accepted");
	const workspace = receipt.input.workspace;
	assert.equal(primary(workspace)?.section, "day");
	assert.equal(primary(workspace)?.selectedId, itemId);
	assert.equal(
		receipt.persistedItem,
		true,
		"Displayed item was absent from native SQLite at receipt"
	);
	return assertItemFrames(receipt.ui, receipt.receivedAt, workspace.sequence, itemId, title);
}

function assertSavedState(row, expected) {
	assert.ok(row, "Native day_state row is missing");
	const state = JSON.parse(row.data_json);
	assert.equal(state.version, 1);
	assert.equal(row.sequence, state.sequence);
	assert.equal(state.records.length, 1, "Capture/replay introduced an additional item");
	const record = state.records[0];
	const item = record.item;
	assert.equal(item.id, expected.itemId);
	assert.equal(item.title, TITLE);
	assert.equal(item.workspaceId, ACTOR.workspaceId);
	assert.equal(item.ownerUserId, ACTOR.userId);
	assert.equal(item.requestedById, ACTOR.userId);
	assert.equal(item.source, null);
	assert.equal(item.answerReceipt, null, "Personal confirmation must not fabricate Slack delivery");
	assert.equal(item.jobId, null);
	assert.equal(record.preparation, null);
	assert.deepEqual(record.outbox, []);
	assert.equal(item.phase, "closed");
	assert.deepEqual(item.questions, []);
	assert.equal(item.localAnswerReceipt?.requestId, expected.closed.requestId);
	assert.equal(item.localAnswerReceipt.confirmedById, ACTOR.userId);
	assert.ok(Number.isFinite(Date.parse(item.localAnswerReceipt.confirmedAt)));
	for (const input of [expected.captured, expected.covered, expected.closed]) {
		const matching = state.requests.filter((request) => request.id === input.requestId);
		assert.equal(matching.length, 1, "Durable request identity is missing or duplicated");
		assert.deepEqual(matching[0].actor, ACTOR);
		assert.equal(matching[0].itemId, item.id);
		assert.equal(matching[0].digest, sha256(JSON.stringify(input.operation)));
	}
	return state;
}

// Observe the app's existing rAF calls; do not add frames, alter callbacks or modify app state.
const frameObserver = `(() => {
	if (window.__daySmoke) throw Error('Day frame observer was installed twice');
	const visible = element => !!element && element.getBoundingClientRect().width > 0 &&
		element.getBoundingClientRect().height > 0 && getComputedStyle(element).visibility !== 'hidden';
	const read = () => {
		const root = document.querySelector('.canvas-workspace[data-workspace-sequence]');
		const selected = [...document.querySelectorAll('[data-center-section="day"][data-selected-id]')].find(visible);
		const item = selected?.querySelector('article.day-item[aria-label="Day work item"]');
		return { sequence: root ? Number(root.dataset.workspaceSequence) : null,
			itemId: selected?.dataset.selectedId ?? null, title: item?.querySelector('h1')?.textContent ?? null,
			visible: visible(item), text: item?.innerText ?? '' };
	};
	const original = window.requestAnimationFrame;
	const audit = { frames: [], read };
	window.__daySmoke = audit;
	window.requestAnimationFrame = function(callback) {
		const scheduledSequence = read().sequence;
		return original.call(window, timestamp => {
			audit.frames.push({ ...read(), at: Date.now(), timestamp, scheduledSequence });
			if (audit.frames.length > 160) audit.frames.shift();
			return callback(timestamp);
		});
	};
	return true;
})()`;

async function native() {
	assert.ok(process.versions.electron, "Root must run this file with Electron");
	assert.ok(!process.env.ELECTRON_RENDERER_URL, "Built default App required; no dev renderer");
	const { app, BrowserWindow, ipcMain, session, shell } = require("electron");
	const builtMain = resolve(process.argv[2] ?? join(__dirname, "../../out/main/index.js"));
	assert.ok(fs.existsSync(builtMain), "Root must build the integrated default App first");
	const owned = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "met-day-smoke-")));
	const owner = randomUUID();
	const ownerPath = join(owned, ".day-owner");
	const profile = join(owned, "profile");
	const envPath = join(owned, ".env");
	const dbPath = join(profile, "metahackathon.db");
	fs.writeFileSync(ownerPath, owner, { mode: 0o600 });
	emergencyCleanup = () => removeOwned(owned, ownerPath, owner);
	fs.mkdirSync(profile, { mode: 0o700 });
	fs.writeFileSync(envPath, `MODEL_API_KEY=${DUMMY_KEY}\n`, { mode: 0o600 });
	// Prevent inherited credentials, OAuth registrations, development fixtures and preconnect flags.
	for (const key of Object.keys(process.env))
		if (
			/^(?:GITHUB_|GH_TOKEN$|LINEAR_|SLACK_|MODEL_|META_|ELEVENLABS_|VITE_MUSE_|METAHACKATHON_)/.test(
				key
			)
		)
			delete process.env[key];
	process.env.METAHACKATHON_ENV_FILE = envPath;
	app.setPath("userData", profile);
	const reportPath = join(__dirname, "../../out/day-smoke-report.json");
	fs.mkdirSync(dirname(reportPath), { recursive: true });
	const report = {
		status: "running",
		actualBuiltApp: false,
		actualPreloadIPC: false,
		controlledModelStub: true,
		modelRequests: 0,
		liveProviders: false,
		liveSpeech: false,
		microphoneCapture: false,
		workerExecution: false,
		fullProcessRestart: false,
		sourceBackedClosureTested: false,
		advancedQnATested: false,
		builtMain,
		builtMainSha256: sha256(fs.readFileSync(builtMain)),
		userData: profile,
		checks: [],
		receipts: [],
		blocked: [],
	};
	const save = () =>
		fs.writeFileSync(
			reportPath,
			`${JSON.stringify(report, null, 2).split(DUMMY_KEY).join("[DUMMY]")}\n`
		);
	let failure;
	const markFailure = (error) => {
		failure ??= error instanceof Error ? error : new Error(String(error));
	};
	const trace = [];
	let readUI;
	let Database;
	let captured;
	let covered;
	let closed;
	let itemId;
	let checksComplete = false;
	let finalAuditInstalled = false;
	let stopping = false;
	const originalFetch = globalThis.fetch;
	const originalHandle = ipcMain.handle;
	const originalOpen = shell.openExternal;
	const childOriginals = new Map();
	const browserSessions = new Set();
	const windows = [];
	const readRow = () => {
		const db = new Database(dbPath, { readonly: true, fileMustExist: true });
		try {
			assert.equal(db.pragma("quick_check", { simple: true }), "ok");
			return db.prepare("SELECT sequence,data_json FROM day_state WHERE id=1").get();
		} finally {
			db.close();
		}
	};
	const cleanup = emergencyCleanup;
	const restore = () => {
		globalThis.fetch = originalFetch;
		ipcMain.handle = originalHandle;
		shell.openExternal = originalOpen;
		for (const [key, value] of childOriginals) childProcess[key] = value;
		syncBuiltinESMExports();
		for (const browserSession of browserSessions) browserSession.webRequest.onBeforeRequest(null);
	};
	const restrictSession = (browserSession) => {
		if (browserSessions.has(browserSession)) return;
		browserSessions.add(browserSession);
		browserSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
			const allowed = localURL(details.url);
			if (!allowed) {
				report.blocked.push({ surface: "chromium", url: details.url });
				markFailure(new Error("Unexpected Chromium network request"));
			}
			callback({ cancel: !allowed });
		});
	};
	const stop = (error) => {
		if (error) markFailure(error);
		if (stopping) return;
		stopping = true;
		save();
		app.quit();
	};
	const hardStop = setTimeout(() => {
		markFailure(new Error("119-second hard deadline; native shutdown did not finish"));
		report.status = "failed";
		report.error = failure.message;
		try {
			report.cleanup = { forced: true, ownedTempRemoved: cleanup() };
		} catch {
			report.cleanup = { forced: true, ownedTempRemoved: false };
		}
		save();
		app.exit(1);
	}, 119_000);
	const deadline = setTimeout(() => stop(new Error("105-second day smoke deadline")), 105_000);
	function installFinalAudit() {
		if (finalAuditInstalled) return;
		finalAuditInstalled = true;
		// Registered after main: its before-quit disposal and will-quit SQLite close run first.
		app.once("will-quit", (event) => {
			event.preventDefault();
			clearTimeout(deadline);
			try {
				if (failure) throw failure;
				assert.equal(checksComplete, true, "App quit before the UI checks completed");
				assert.ok(
					windows.every((win) => win.isDestroyed()),
					"Owned window survived actual quit"
				);
				const diagnostics = fs.readFileSync(
					join(profile, "diagnostics/conversation.jsonl"),
					"utf8"
				);
				assert.ok(
					diagnostics
						.split("\n")
						.filter(Boolean)
						.map(JSON.parse)
						.some((row) => row.stage === "shutdown-complete"),
					"Actual main shutdown did not complete"
				);
				const expected = { itemId, captured, covered, closed };
				const first = readRow();
				const state = assertSavedState(first, expected);
				const reopened = readRow();
				assertSavedState(reopened, expected);
				assert.deepEqual(reopened, first, "Read-only reopen altered the durable day bytes");
				report.persistence = {
					afterActualAppShutdown: true,
					nativeReadOnlyReopens: 2,
					sequence: state.sequence,
					stateSha256: sha256(first.data_json),
					requestLedgerVerified: true,
					localAnswerReceipt: state.records[0].item.localAnswerReceipt,
					providerDeliveryReceipt: null,
				};
				report.checks.push(
					"actual app shutdown; native SQLite reopen retains one item, request digests and explicit personal-answer receipt"
				);
				assert.deepEqual(report.blocked, []);
				assert.equal(report.modelRequests, 0, "This increment requested no model/worker turn");
				report.status = "passed";
			} catch (error) {
				markFailure(error);
				report.status = "failed";
				report.error = failure.message;
			} finally {
				try {
					report.cleanup = { appShutdownObserved: true, ownedTempRemoved: cleanup() };
				} catch (error) {
					report.status = "failed";
					report.error = String(error.message);
				}
				try {
					restore();
				} catch (error) {
					report.status = "failed";
					report.error = String(error.message);
				}
				clearTimeout(hardStop);
				save();
				console.log(`DAY_SMOKE_${report.status.toUpperCase()}: ${reportPath}`);
				app.exit(report.status === "passed" ? 0 : 1);
			}
		});
	}
	async function wait(label, read) {
		for (let attempt = 0; attempt < 300; attempt++) {
			if (failure) throw failure;
			const value = await read();
			if (value) return value;
			await sleep(40);
		}
		throw new Error(`Timed out: ${label}`);
	}
	try {
		app.on("browser-window-created", (_event, win) => {
			windows.push(win);
			win.setIgnoreMouseEvents(true);
			win.setFocusable(false);
		});
		app.on("session-created", restrictSession);
		for (const key of [
			"spawn",
			"spawnSync",
			"exec",
			"execSync",
			"execFile",
			"execFileSync",
			"fork",
		]) {
			childOriginals.set(key, childProcess[key]);
			childProcess[key] = () => {
				report.blocked.push({ surface: "child-process", method: key });
				const error = new Error("Day UI smoke forbids worker/helper child processes");
				markFailure(error);
				throw error;
			};
		}
		syncBuiltinESMExports();
		shell.openExternal = async () => {
			report.blocked.push({ surface: "external-browser" });
			const error = new Error("Day UI smoke forbids an external browser launch");
			markFailure(error);
			throw error;
		};
		globalThis.fetch = async (input, options = {}) => {
			const address = String(input.url ?? input);
			if (address === MODEL_ENDPOINT) {
				report.modelRequests++;
				assert.equal(options.method, "POST");
				assert.ok(
					new Headers(options.headers).get("authorization") === `Bearer ${DUMMY_KEY}`,
					"Only the fake model key may reach the controlled stub"
				);
				markFailure(new Error("Unexpected model turn in the UI-only day increment"));
				return modelResponse(JSON.parse(options.body));
			}
			report.blocked.push({ surface: "main-fetch", url: new URL(address).origin });
			const error = new Error("Day UI smoke forbids external provider/network requests");
			markFailure(error);
			throw error;
		};
		// Pass through the real registered handler unchanged. Only its actual inputs/results are audited.
		ipcMain.handle = function (channel, handler) {
			if (channel !== "trpc:request") return originalHandle.call(this, channel, handler);
			return originalHandle.call(this, channel, async (event, request) => {
				const watched = [
					"day.snapshot",
					"day.operate",
					"workspace.prepare",
					"workspace.applied",
				].includes(request?.path);
				const entry = watched
					? { path: request.path, input: request.input?.json, receivedAt: Date.now() }
					: null;
				if (entry) trace.push(entry);
				if (entry?.path === "workspace.applied" && readUI) {
					try {
						entry.ui = await readUI();
						const displayed = primary(entry.input.workspace);
						if (displayed?.section === "day" && displayed.selectedId && Database) {
							const row = readRow();
							entry.persistedItem =
								!!row &&
								JSON.parse(row.data_json).records.some(
									({ item }) => item.id === displayed.selectedId && item.title === TITLE
								);
						}
					} catch (error) {
						markFailure(error);
					}
				}
				const response = await handler(event, request);
				if (entry) {
					entry.finishedAt = Date.now();
					entry.result = dataOf(response);
					entry.error = response?.error;
				}
				return response;
			});
		};
		save();
		await import(pathToFileURL(builtMain).href);
		installFinalAudit();
		await app.whenReady();
		// Main normally creates the default session later; include an already-created session as well.
		restrictSession(session.defaultSession);
		Database = require("better-sqlite3");
		const win = await wait("default main window", () => BrowserWindow.getAllWindows()[0]);
		assert.equal(BrowserWindow.getAllWindows().length, 1, "A second app window was opened");
		assert.equal(win.isFocusable(), false);
		const js = (code) => win.webContents.executeJavaScript(code);
		await wait("default App and preload", () =>
			js(
				`!!document.querySelector('main[data-session-id]') && !!document.querySelector('.command-rail') && !!window.electron?.trpc?.request`
			)
		);
		const sessionId = await js(`document.querySelector('main[data-session-id]').dataset.sessionId`);
		assert.equal(new URL(win.webContents.getURL()).protocol, "file:");
		const rendererPath = new URL(win.webContents.getURL());
		report.builtRendererURL = rendererPath.href;
		report.builtRendererSha256 = sha256(fs.readFileSync(rendererPath));
		const rawRPC = (type, path, input = {}) =>
			js(`window.electron.trpc.request(${JSON.stringify({ type, path, input: { json: input } })})`);
		const rpc = async (type, path, input = {}) => {
			const response = await rawRPC(type, path, input);
			assert.ok(!response?.error, `${path}: ${JSON.stringify(response?.error)}`);
			assert.ok(response?.result?.data, `${path} did not return a real result`);
			return dataOf(response);
		};
		const observe = () => rpc("query", "workspace.observe", { sessionId });
		const daySnapshot = () => rpc("query", "day.snapshot");
		const clickText = (selector, label) =>
			js(`(() => {
			const found = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(e => e.textContent.trim() === ${JSON.stringify(label)} && e.getBoundingClientRect().width > 0);
			if (found.length !== 1 || found[0].disabled) throw Error('Expected one enabled visible control: ' + ${JSON.stringify(label)});
			found[0].click(); return true;
		})()`);
		const browse = (label) =>
			js(`(() => {
			const found = [...document.querySelectorAll('.command-rail button[aria-label]')].filter(e => { const value=e.getAttribute('aria-label'); return value === ${JSON.stringify(label)} || value.startsWith(${JSON.stringify(`${label} (`)}); });
			if (found.length !== 1) throw Error('Rail category unavailable'); found[0].click(); return true;
		})()`);
		await js(frameObserver);
		readUI = () =>
			js("({ state: window.__daySmoke.read(), frames: window.__daySmoke.frames.slice() })");
		const config = await rpc("query", "app.config");
		assert.equal(config.envPath, envPath);
		assert.equal(config.configured.meta, true);
		assert.equal(config.configured.github, false);
		assert.equal(config.configured.elevenlabs, false);
		assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
		const initial = await daySnapshot();
		assert.deepEqual(initial.actor, ACTOR);
		assert.deepEqual(initial.items, []);
		assert.equal(initial.currentItemId, null);
		assert.equal(await js(`document.querySelector('#conversation-panel')?.hidden`), true);
		assert.equal((await rpc("query", "hub.snapshot")).jobs.length, 0);
		report.checks.push(
			"fresh actual day.snapshot has the local actor and no seeded item/job; typing stays hidden"
		);
		const beforeBrowse = (await observe()).workspace;
		await browse("My day");
		await wait("My day sidebar and acknowledged category", async () => {
			const current = (await observe()).workspace;
			return (
				current.centerSection === "day" &&
				(await js(`!!document.querySelector('.command-sidebar .day-queue')`))
			);
		});
		assert.deepEqual(contentOf((await observe()).workspace), contentOf(beforeBrowse));
		await clickText(".day-capture summary", "Capture a commitment");
		await js(
			`(() => { const e=document.querySelector('.day-capture input'); if (!e) throw Error('Capture input missing'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(TITLE)}); e.dispatchEvent(new Event('input',{bubbles:true})); })()`
		);
		await wait("React accepts manual input", () =>
			js(`!!document.querySelector('.day-capture button[type="submit"]:not(:disabled)')`)
		);
		await clickText(".day-capture button[type=submit]", "Capture");
		const saved = await wait("actual captured local follow-up", async () => {
			const value = await daySnapshot();
			return value.items.find((item) => item.title === TITLE) ? value : null;
		});
		assert.equal(saved.items.length, 1);
		itemId = saved.items[0].id;
		assert.equal(saved.items[0].source, null);
		assert.equal(saved.items[0].jobId, null);
		assert.equal(saved.items[0].answerReceipt, null);
		assert.notEqual(saved.items[0].phase, "closed");
		captured = (
			await wait("actual capture IPC result", () =>
				trace.find(
					(entry) =>
						entry.path === "day.operate" &&
						entry.input.operation.kind === "capture_manual" &&
						entry.result
				)
			)
		).input;
		assert.deepEqual(captured.operation, {
			kind: "capture_manual",
			title: TITLE,
			summary: "",
			itemKind: "follow_up",
		});
		const replayed = await rpc("mutation", "day.operate", captured);
		assert.equal(replayed.itemId, itemId);
		assert.equal(replayed.snapshot.items.length, 1);
		const changedReplay = await rawRPC("mutation", "day.operate", {
			...captured,
			operation: { ...captured.operation, title: "Changed request must be rejected" },
		});
		assert.ok(
			changedReplay.error,
			"Reusing a capture request ID with changed content was accepted"
		);
		await wait("actual sidebar item", () =>
			js(
				`!![...document.querySelectorAll('.day-queue button.command-item')].find(e => e.querySelector('.command-item-title')?.textContent === ${JSON.stringify(TITLE)})`
			)
		);
		const selectionStart = trace.length;
		await js(
			`(() => { const e=[...document.querySelectorAll('.day-queue button.command-item')].find(e => e.querySelector('.command-item-title')?.textContent === ${JSON.stringify(TITLE)}); if (!e) throw Error('Captured sidebar item missing'); e.click(); })()`
		);
		const selectedReceipt = await wait("real selected-item applied receipt", () =>
			trace
				.slice(selectionStart)
				.find(
					(entry) =>
						entry.path === "workspace.applied" &&
						entry.result?.status === "accepted" &&
						primary(entry.input.workspace)?.selectedId === itemId
				)
		);
		const selectedFrames = assertDisplayedReceipt(selectedReceipt, itemId, TITLE);
		const screenshot = join(__dirname, "../../out/day-workspace-controlled.png");
		fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
		report.screenshot = {
			path: screenshot,
			content: "controlled personal item; no live Slack content",
		};
		const prepared = trace
			.slice(selectionStart)
			.find(
				(entry) =>
					entry.path === "workspace.prepare" &&
					entry.input.command.kind === "open-center" &&
					entry.input.command.section === "day" &&
					entry.input.command.selectedId === itemId &&
					entry.result
			);
		assert.ok(prepared, "Actual item selection bypassed workspace.prepare");
		assert.equal(prepared.result.requestId, selectedReceipt.input.requestId);
		assert.ok(
			trace.some(
				(entry) =>
					entry.path === "day.snapshot" &&
					entry.result?.items?.some((item) => item.id === itemId) &&
					entry.finishedAt >= prepared.finishedAt &&
					entry.finishedAt <= selectedReceipt.receivedAt
			),
			"Renderer did not await a real day snapshot between prepare and its applied receipt"
		);
		report.receipts.push({
			requestId: selectedReceipt.input.requestId,
			sequence: selectedReceipt.input.workspace.sequence,
			status: selectedReceipt.result.status,
			itemId,
			title: TITLE,
			persistedBeforeReceipt: true,
			visibleFramesBeforeReceipt: selectedFrames.map(({ timestamp, at, sequence }) => ({
				timestamp,
				at,
				sequence,
			})),
		});
		report.checks.push(
			"UI manual capture persists; exact request replay deduplicates; selecting the real item waits for snapshot, item frame and two app rAF frames before accepted receipt"
		);
		const beforeUnknown = (await observe()).workspace;
		const missingRequest = `day-missing-${randomUUID()}`;
		const missing = await rawRPC("mutation", "workspace.prepare", {
			sessionId,
			requestId: missingRequest,
			expectedSequence: beforeUnknown.sequence,
			command: { kind: "open-center", section: "day", selectedId: `absent-${randomUUID()}` },
		});
		assert.ok(missing.error, "Unknown item produced a positive workspace effect");
		assert.deepEqual((await observe()).workspace, beforeUnknown);
		assert.ok(
			!trace.some(
				(entry) => entry.path === "workspace.applied" && entry.input.requestId === missingRequest
			)
		);
		const missingDay = await rawRPC("mutation", "day.operate", {
			requestId: randomUUID(),
			operation: { kind: "cover", itemId: "unknown-day-item", expectedRevision: 1 },
		});
		assert.ok(missingDay.error, "Unknown item produced a positive day operation");
		report.checks.push(
			"unknown day item rejects in actual main before any positive display receipt or day mutation"
		);
		await clickText(".day-item button", "Cover this item with Muse");
		await wait(
			"explicit cover persisted",
			async () => (await daySnapshot()).currentItemId === itemId
		);
		covered = (
			await wait("cover IPC result", () =>
				trace.find(
					(entry) =>
						entry.path === "day.operate" && entry.input.operation.kind === "cover" && entry.result
				)
			)
		).input;
		assert.deepEqual((await daySnapshot()).items[0].questions, []);
		await wait("covered actual item", () =>
			js(`document.querySelector('.day-focus h2')?.textContent === 'Covering this item'`)
		);
		assert.equal(await js(`document.querySelector('#conversation-panel')?.hidden`), true);
		const beforeReviews = (await observe()).workspace;
		await browse("Incoming reviews");
		await wait(
			"reviews sidebar acknowledged while item remains",
			async () => (await observe()).workspace.centerSection === "reviews"
		);
		const afterReviews = (await observe()).workspace;
		assert.deepEqual(contentOf(afterReviews), contentOf(beforeReviews));
		const preserved = (await readUI()).state;
		assert.equal(preserved.itemId, itemId);
		assert.equal(preserved.title, TITLE);
		assert.equal(preserved.visible, true);
		assert.equal(await js(`!!document.querySelector('.command-sidebar .day-queue')`), false);
		report.checks.push(
			"explicit UI coverage has no fabricated Q&A; browsing Incoming reviews retains the acknowledged visible day item and content revision"
		);
		await clickText(".day-item button", "I have answered this");
		const closedSnapshot = await wait("actual personal confirmation closes item", async () => {
			const value = await daySnapshot();
			return value.items.find((item) => item.id === itemId)?.phase === "closed" ? value : null;
		});
		closed = (
			await wait("personal-answer IPC result", () =>
				trace.find(
					(entry) =>
						entry.path === "day.operate" &&
						entry.input.operation.kind === "confirm_local_answer" &&
						entry.result
				)
			)
		).input;
		assert.equal(closed.operation.confirmed, true);
		assert.equal(closed.operation.itemId, itemId);
		assert.equal(closedSnapshot.items[0].answerReceipt, null);
		assert.equal(closedSnapshot.items[0].localAnswerReceipt.requestId, closed.requestId);
		await wait("honest local closure in actual UI", () =>
			js(
				`document.querySelector('article.day-item')?.innerText.includes('Answer confirmed by you')`
			)
		);
		assert.equal((await readUI()).state.text.includes("Answer delivered"), false);
		const finalReplay = await rpc("mutation", "day.operate", captured);
		assert.equal(finalReplay.itemId, itemId);
		assert.equal(finalReplay.snapshot.items.length, 1);
		assert.equal(finalReplay.snapshot.items[0].phase, "closed");
		assert.equal((await rpc("query", "hub.snapshot")).jobs.length, 0);
		assert.equal(win.contentView.children.length, 0, "Unexpected native guest surface was created");
		report.checks.push(
			"actual 'I have answered this' records personal attestation and closes only the source-less item; original capture replay still returns that one closed item"
		);
		report.actualBuiltApp = true;
		report.actualPreloadIPC = true;
		report.itemId = itemId;
		report.captureRequestId = captured.requestId;
		report.coverRequestId = covered.requestId;
		report.confirmationRequestId = closed.requestId;
		checksComplete = true;
		stop();
	} catch (error) {
		installFinalAudit();
		stop(error);
	}
}

async function selfCheck() {
	for (const url of [
		"file:///controlled/index.html",
		"data:text/plain,local",
		"about:blank",
		"blob:null/id",
	])
		assert.equal(localURL(url), true);
	for (const url of [
		MODEL_ENDPOINT,
		"https://slack.com/api/chat.postMessage",
		"http://127.0.0.1:43187/",
		"wss://example.com/socket",
		"bad url",
	])
		assert.equal(localURL(url), false);
	const body = await modelResponse({ stream: true, store: false, model: "self-check-only" }).text();
	const events = body
		.trim()
		.split("\n\n")
		.map((line) => JSON.parse(line.slice(6)));
	assert.equal(events.at(-1).type, "response.completed");
	assert.equal(events.at(-1).response.output[0].type, "message");
	assert.throws(() => modelResponse({ stream: false, store: false, model: "invalid" }));
	const workspace = {
		sequence: 2,
		centerSection: "day",
		primaryId: "center",
		canvases: [{ id: "center", kind: "center", section: "day", selectedId: "id" }],
	};
	assert.deepEqual(
		contentOf(workspace),
		contentOf({ ...workspace, sequence: 3, centerSection: "reviews" })
	);
	assert.notDeepEqual(contentOf(workspace), contentOf({ ...workspace, primaryId: "other" }));
	const frame = {
		at: 1,
		timestamp: 1,
		sequence: 2,
		scheduledSequence: 2,
		itemId: "id",
		title: TITLE,
		visible: true,
	};
	const ui = { state: { ...frame }, frames: [frame, { ...frame, timestamp: 2, at: 2 }] };
	assert.equal(assertItemFrames(ui, 4, 2, "id", TITLE).length, 2);
	for (const invalid of [
		{ ...ui, state: { ...frame, visible: false } },
		{ ...ui, state: { ...frame, itemId: "other" } },
		{ ...ui, frames: [frame, { ...frame }] },
		{ ...ui, frames: [frame, { ...frame, timestamp: 2, at: 5 }] },
	])
		assert.throws(() => assertItemFrames(invalid, 4, 2, "id", TITLE));
	new Script(frameObserver, { filename: "day-frame-observer.js" });
	assert.ok(!frameObserver.includes("setInterval"));
	console.log(
		"DAY_SELF_CHECK_PASS: SSE/network/content/frame guards; no Electron import, app, source fixture, filesystem or provider access"
	);
}

if (process.argv.includes("--self-check"))
	selfCheck().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
else if (
	require.main === module ||
	(process.versions.electron && process.argv[1] && resolve(process.argv[1]) === resolve(__filename))
)
	native().catch((error) => {
		console.error(`DAY_SMOKE_FAILED: ${String(error.message).split(DUMMY_KEY).join("[DUMMY]")}`);
		process.exitCode = 1;
		try {
			emergencyCleanup?.();
		} catch {
			/* Preserve an unverified directory. */
		}
		if (process.versions.electron) require("electron").app.exit(1);
	});
