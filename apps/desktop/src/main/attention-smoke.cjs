// ROOT ONLY, after building the default App:
// env -u ELECTRON_RUN_AS_NODE electron src/main/attention-smoke.cjs [built-main]
// Author validation: node --check this-file; node this-file --self-check.
// No positive spoken receipt is manufactured: the default voice controller must
// decode real Chromium RTC tone PCM, observe speech-ended, drain, and acknowledge.
// The package script explicitly builds VITE_MUSE_VOICE_PRECONNECT=0 for this controlled
// media transport. Actual-provider warm admission/fallback/barge-in is separate evidence.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const { randomUUID } = require("node:crypto");
const { tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { installControlledMedia, measureControlledPcm } = require("./hands-free-smoke.cjs");

const MODEL = "https://api.meta.ai/v1/responses";
const REPOSITORY = "attention-smoke/controlled-events";
const TRANSCRIPT = "Can we discuss the ready work?";
const LATE = "LATE_CANCELLED_ATTENTION_OUTPUT";
const identity = ({ sessionId, turnId, generation }) => ({ sessionId, turnId, generation });
const key = (input) => JSON.stringify(identity(input));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function seedState(now = new Date().toISOString()) {
	const kinds = ["decision", "work-failed", "work-ready"];
	const jobs = kinds.map((kind, index) => ({
		id: `controlled-${kind}-job`,
		ticket: null,
		repositoryId: "controlled-repository",
		repository: REPOSITORY,
		state: kind === "decision" ? "needs-input" : kind === "work-failed" ? "failed" : "ready",
		branch: `controlled/${kind}`,
		worktreePath: null,
		baseSha: "0".repeat(40),
		headSha: String(index + 1).repeat(40),
		brief: "CONTROLLED persisted attention fixture; no worker execution is claimed.",
		summary: "Controlled event used only to exercise delivery.",
		createdAt: now,
		updatedAt: now,
		decisions:
			kind === "decision"
				? [
						{
							id: "controlled-decision",
							question: "Which controlled option should be used?",
							reason: "Controlled pending-decision marker",
							createdAt: now,
							answer: null,
							answeredAt: null,
						},
					]
				: [],
		checks: [],
		changedFiles: ["controlled.ts"],
		pullRequest: null,
		error: kind === "work-failed" ? "Controlled failure marker" : null,
	}));
	return {
		version: 1,
		repositories: [
			{
				id: "controlled-repository",
				repository: REPOSITORY,
				localPath: null,
				defaultBranch: "main",
				addedAt: now,
				linearTeamIds: [],
				linearProjectIds: [],
			},
		],
		preferences: {
			linearTeamIds: [],
			linearProjectIds: [],
			maxWorkers: 1,
			autoApplySuggestions: false,
		},
		tickets: [],
		jobs,
		// Ready is newest: selection must use semantic priority rather than recency.
		notices: jobs.map((job, index) => ({
			id: `controlled-notice-${index + 1}`,
			kind: kinds[index],
			title: `CONTROLLED ${kinds[index]}`,
			detail: "Not worker execution evidence.",
			jobId: job.id,
			prId: null,
			headSha: job.headSha,
			decisionId: index === 0 ? "controlled-decision" : null,
			createdAt: new Date(Date.parse(now) + index).toISOString(),
			announcedAt: null,
			seenAt: null,
		})),
		attentionRecords: [],
	};
}

function assertAttentionInput(input) {
	assert.deepEqual(Object.keys(input).sort(), [
		"claimId",
		"generation",
		"requestId",
		"sessionId",
		"turnId",
	]);
	for (const name of ["claimId", "requestId", "sessionId", "turnId"])
		assert.equal(typeof input[name], "string");
	assert.ok(Number.isInteger(input.generation) && input.generation >= 0);
}

function assertReadOnlyRequest(body, claim) {
	assert.deepEqual(body.tools, []);
	assert.equal(body.max_output_tokens, 512);
	assert.equal(
		body.input.filter((item) => item.role === "user" && typeof item.content === "string").length,
		0,
		"Initiative must not fabricate a user utterance"
	);
	const reference = body.input.at(-1);
	assert.equal(reference.role, "developer");
	assert.deepEqual(JSON.parse(reference.content).assistantInitiatedAttention, claim);
}

function assertDrainProof(output, endedAt, observedAt) {
	assert.ok(output && output.nonSilent > 3, "Decoded output PCM was not observed");
	assert.ok(Number.isFinite(endedAt), "No actual controlled speech-ended boundary");
	assert.ok(observedAt - endedAt >= 280, "Receipt preceded the product's 300ms playout drain");
	assert.ok(observedAt - output.lastNonSilentAt >= 150, "Receipt preceded the decoded PCM tail");
}

function stored(Database, path) {
	const db = new Database(path, { readonly: true });
	try {
		return JSON.parse(db.prepare("SELECT data_json FROM hub_state WHERE id=1").get().data_json);
	} finally {
		db.close();
	}
}

async function native() {
	const { app, BrowserWindow, ipcMain } = require("electron");
	const Database = require("better-sqlite3");
	assert.ok(
		process.versions.electron && !process.env.ELECTRON_RENDERER_URL,
		"Run the built default App in Electron"
	);
	app.commandLine.appendSwitch("use-fake-device-for-media-stream");
	const owned = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "met-attention-smoke-")));
	const owner = randomUUID();
	fs.writeFileSync(join(owned, ".attention-owner"), owner, { mode: 0o600 });
	const envPath = join(owned, ".env");
	const privateMarkers = ["attention-smoke-model-key", "attention-smoke-tts-key"];
	fs.writeFileSync(
		envPath,
		`MODEL_API_KEY=${privateMarkers[0]}\nELEVENLABS_API_KEY=${privateMarkers[1]}\nELEVENLABS_VOICE_ID=controlled-attention-voice\n`,
		{ mode: 0o600 }
	);
	process.env.METAHACKATHON_ENV_FILE = envPath;
	app.setPath("userData", owned);
	const dbPath = join(owned, "metahackathon.db");
	const seed = seedState();
	const sqlite = new Database(dbPath);
	try {
		sqlite.exec(
			"CREATE TABLE hub_state (id INTEGER PRIMARY KEY CHECK(id=1),data_json TEXT NOT NULL)"
		);
		sqlite.prepare("INSERT INTO hub_state(id,data_json) VALUES(1,?)").run(JSON.stringify(seed));
	} finally {
		sqlite.close();
	}
	fs.chmodSync(dbPath, 0o600);
	const reportPath = join(__dirname, "../../out/attention-smoke-report.json");
	fs.mkdirSync(dirname(reportPath), { recursive: true });
	const report = {
		status: "running",
		nativeExecution: true,
		actualBuiltApp: true,
		controlledModel: true,
		controlledSTT: true,
		controlledTTS: true,
		simulatedNativeFocus: true,
		simulatedReadiness: false,
		physicalSpeakerMuted: true,
		input: "one actual Chromium WebAudio synthetic microphone, never ambient",
		seedEvidence: "controlled persisted jobs/notices, not execution-worker evidence",
		liveSpeech: false,
		acousticVerification: false,
		fullAppRestartTested: false,
		userData: owned,
		policy: { quietMs: 2500, cooldownMs: 20000, retryMs: 60000, maxAttempts: 3, leaseMs: 180000 },
		presence: [],
		claims: [],
		attends: [],
		offers: [],
		releases: [],
		speaks: [],
		cancels: [],
		narration: [],
		settlements: [],
		models: [],
		deferrals: [],
		blocked: [],
	};
	const save = () => fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
	save();
	let win;
	let sidecarPort;
	let nativeFocused = false;
	let failure;
	let quitting = false;
	let observerInstalled = false;
	let startClicks = 0;
	let manualProbe = false;
	const sessions = new Map();
	const claims = new Map();
	const attempts = new Map();
	const timers = new Set();
	const originalFetch = globalThis.fetch;
	const originalHandle = ipcMain.handle;
	const js = (code) => win.webContents.executeJavaScript(code);
	const media = () => js("window.__handsSmoke.read()");
	const state = () => stored(Database, dbPath);
	const notice = (kind) => state().notices.find((row) => row.kind === kind);
	const markFailure = (error) => {
		failure ??= error;
		return error;
	};
	async function wait(label, predicate, timeout = 15000) {
		const until = Date.now() + timeout;
		while (Date.now() < until) {
			if (failure) throw failure;
			const result = await predicate();
			if (result) return result;
			await sleep(30);
		}
		throw new Error(`Timed out: ${label}`);
	}
	const ui = () =>
		js(
			`({armed:document.querySelector('footer.voice-bar')?.dataset.handsFree,error:document.querySelector('.voice-bar-error')?.textContent||'',dialogs:document.querySelectorAll('dialog').length,messages:[...document.querySelectorAll('article.exchange')].map(e=>({phase:e.dataset.phase,turnId:e.dataset.turnId,question:e.querySelector('.user-message')?.textContent||'',answer:e.querySelector('.assistant-answer')?.getAttribute('data-answer')||''}))})`
		);
	async function rpc(type, path, input) {
		const encoded =
			input === undefined ? { json: null, meta: { values: ["undefined"], v: 1 } } : { json: input };
		const result = await js(
			`window.electron.trpc.request(${JSON.stringify({ type, path, input: encoded })})`
		);
		assert.ok(!result.error, `${path}: ${result.error?.message ?? ""}`);
		return result.result.data.json;
	}
	const event = (session, kind, fields) =>
		session.events.push({
			...session.identity,
			sequence: session.events.length + 1,
			kind,
			...fields,
		});
	const outputFor = (snapshot, session) =>
		snapshot.outputs.find((row) => row.peer === session.local);
	async function endSpeech(session) {
		assert.ok(session.speechId);
		session.endedAt = await js(
			`window.__handsSmoke.speak(${session.number},false); performance.now()`
		);
		session.endedWall = Date.now();
		event(session, "speech-ended", { speechId: session.speechId });
	}

	// Observe the real main handler and its real responses. Do not replace RPC results
	// or call a controller/test driver instead of the default App/preload binding.
	ipcMain.handle = function (channel, handler) {
		if (channel !== "trpc:request") return originalHandle.call(this, channel, handler);
		observerInstalled = true;
		return originalHandle.call(this, channel, async (sender, request) => {
			try {
				const input = request.input?.json;
				const path = request.path;
				if (path === "conversation.attend") {
					assertAttentionInput(input);
					assert.ok(claims.has(input.claimId), "Attend must use an actually polled main claim");
					const entry = { ...input, at: Date.now(), checkpoint: null };
					report.attends.push(entry);
					attempts.set(key(input), entry);
				}
				if (path === "conversation.narrationApplied") {
					const attempt = attempts.get(key(input));
					if (attempt && input.status === "spoken") {
						assert.equal(
							manualProbe,
							false,
							"Only the actual voice binding can publish spoken receipts"
						);
						const session = sessions.get(key(input));
						assert.ok(session && !session.cancelled);
						const snapshot = await media();
						const at = await js("performance.now()");
						assertDrainProof(outputFor(snapshot, session), session.endedAt, at);
						const selected = claims.get(attempt.claimId).items[0];
						assert.equal(
							state().notices.find((row) => row.id === selected.noticeId).announcedAt,
							null
						);
						report.narration.push({
							...identity(input),
							status: input.status,
							at: Date.now(),
							drainedAfterMs: at - session.endedAt,
							decodedPcm: outputFor(snapshot, session).nonSilent,
						});
					} else if (attempt)
						report.narration.push({
							...identity(input),
							status: input.status,
							negativeProbe: manualProbe,
						});
				}
				const result = await handler(sender, request);
				const data = result.result?.data?.json;
				if (path === "attention.poll" && !result.error) {
					report.presence.push({ ...input, at: Date.now(), claimId: data.claim?.id ?? null });
					if (data.claim) {
						assert.equal(data.claim.items.length, 1);
						const leaseMs = Date.parse(data.claim.expiresAt) - Date.parse(data.claim.createdAt);
						assert.ok(
							leaseMs >= 180000 && leaseMs <= 180100,
							"Expected the real three-minute lease"
						);
						const item = data.claim.items[0];
						const source = seed.jobs.find((job) => job.id === item.jobId);
						assert.ok(source);
						assert.equal(item.headSha, source.headSha);
						assert.equal(item.decisionId, source.decisions[0]?.id ?? null);
						assert.equal(item.question, source.decisions[0]?.question ?? null);
						claims.set(data.claim.id, data.claim);
						report.claims.push({ ...data.claim, at: Date.now() });
					}
				}
				if (path === "conversation.poll" && data) {
					const attempt = attempts.get(key(input));
					if (attempt) {
						assert.ok(data.actions.every((action) => action.kind === "narration-checkpoint"));
						attempt.checkpoint ??=
							data.actions.find((action) => action.kind === "narration-checkpoint") ?? null;
						attempt.lastStatus = data.status;
						assert.ok(!data.text.includes(LATE));
					}
				}
				if (path === "attention.settle")
					report.settlements.push({
						...input,
						result: data?.status,
						negativeProbe: manualProbe,
						at: Date.now(),
					});
				return result;
			} catch (error) {
				throw markFailure(error);
			}
		});
	};
	app.on("browser-window-created", (_event, window) => {
		window.setIgnoreMouseEvents(true);
		window.setFocusable(false);
		// Explicitly simulated native focus; never focus or send physical input to the user's desktop.
		window.isFocused = () => nativeFocused;
	});
	globalThis.fetch = async (input, options = {}) => {
		try {
			const url = new URL(String(input.url ?? input));
			if (url.href === MODEL) {
				const body = JSON.parse(options.body);
				const reference = body.input.at(-1);
				let text;
				let kind;
				if (reference.role === "developer") {
					const claim = JSON.parse(reference.content).assistantInitiatedAttention;
					assert.ok(claim && claims.has(claim.id));
					assertReadOnlyRequest(body, claims.get(claim.id));
					kind = claim.items[0].kind;
					text =
						kind === "decision"
							? "The controlled job needs your decision."
							: kind === "work-failed"
								? "The controlled job failed."
								: "The controlled work is ready for review.";
				} else {
					assert.equal(
						body.input.findLast((item) => item.role === "user" && typeof item.content === "string")
							?.content,
						TRANSCRIPT
					);
					assert.ok(body.tools.some((tool) => tool.name === "inspect_workspace"));
					assert.ok(body.tools.some((tool) => tool.name === "expand_tools"));
					assert.equal(
						report.releases.length,
						1,
						"The real user followup must have actual captured/released PCM"
					);
					kind = "real-user-followup";
					text = "Yes, we can discuss the ready work.";
				}
				report.models.push({
					kind,
					at: Date.now(),
					tools: body.tools.map((tool) => tool.name),
					userUtterances: body.input.filter(
						(item) => item.role === "user" && typeof item.content === "string"
					).length,
				});
				assert.ok(report.models.length <= 4, "Unexpected automatic model request or retry");
				const encode = (value) => `data: ${JSON.stringify(value)}\n\n`;
				return new Response(
					encode({ type: "response.output_text.delta", delta: text }) +
						encode({
							type: "response.completed",
							response: {
								id: `controlled-attention-${report.models.length}`,
								model: body.model,
								status: "completed",
								output: [
									{ type: "message", role: "assistant", content: [{ type: "output_text", text }] },
								],
								usage: null,
							},
						}),
					{ headers: { "content-type": "text/event-stream" } }
				);
			}
			if (
				url.protocol === "http:" &&
				url.hostname === "127.0.0.1" &&
				!url.username &&
				!url.password &&
				!url.search &&
				["/offer", "/release", "/speak", "/poll", "/cancel"].includes(url.pathname)
			) {
				assert.equal(options.method, "POST");
				sidecarPort ??= Number(url.port);
				assert.equal(Number(url.port), sidecarPort);
				const body = JSON.parse(options.body);
				let session = sessions.get(key(body));
				if (url.pathname === "/offer") {
					assert.ok(!session);
					session = {
						identity: identity(body),
						number: sessions.size + 1,
						events: [],
						cancelled: false,
					};
					sessions.set(key(body), session);
					report.offers.push(session.identity);
					const answer = await js(
						`window.__handsSmoke.answer(${JSON.stringify(body)},${session.number})`
					);
					await js(`window.__handsSmoke.markAnswer(${session.number})`);
					session.local = (await media()).remotes.find(
						(remote) => remote.number === session.number
					).local;
					return Response.json(answer);
				}
				if (url.pathname === "/cancel") {
					report.cancels.push({ ...identity(body), at: Date.now() });
					if (session) {
						session.cancelled = true;
						await js(`window.__handsSmoke.cancel(${session.number})`);
					}
					return Response.json({});
				}
				assert.ok(session, "Voice transport preceded the actual offer");
				if (url.pathname === "/poll")
					return Response.json({
						events: session.events.filter((row) => row.sequence > body.afterSequence),
					});
				assert.equal(session.cancelled, false);
				if (url.pathname === "/release") {
					assert.equal(
						attempts.has(key(body)),
						false,
						"An assistant-only initiative must never release captured/STT input"
					);
					const captured = (await media()).remotes.find(
						(remote) => remote.number === session.number
					);
					assert.ok(captured.input.nonSilent > 3, "Actual user followup RTC input PCM missing");
					report.releases.push({ ...identity(body), captured });
					event(session, "transcript", { text: TRANSCRIPT, final: true });
					return Response.json({});
				}
				assert.equal(url.pathname, "/speak");
				session.speechId = body.speechId;
				report.speaks.push({ ...identity(body), speechId: body.speechId, at: Date.now() });
				event(session, "speech-started", { speechId: body.speechId });
				await js(`window.__handsSmoke.speak(${session.number},true)`);
				if (!attempts.has(key(body)))
					timers.add(
						setTimeout(() => {
							void endSpeech(session).catch(markFailure);
						}, 650)
					);
				return Response.json({});
			}
			report.blocked.push(url.origin);
			throw new Error("Attention smoke forbids external provider traffic");
		} catch (error) {
			throw markFailure(error);
		}
	};
	async function focus(value) {
		nativeFocused = value;
		// Exercise root's registered focus/blur activity callback as well as preload.
		// Emitting this test event does not focus or blur the user's physical desktop.
		win.emit(value ? "focus" : "blur");
		win.webContents.send("attention:activity", { focused: value });
		await sleep(40);
	}
	async function noInitiative(label, matches, duration = 3300) {
		const start = Date.now();
		const count = report.presence.length;
		const before = report.attends.length;
		while (Date.now() - start < duration) {
			if (failure) throw failure;
			assert.equal(report.attends.length, before, label);
			assert.equal(report.models.length, 0, label);
			await sleep(50);
		}
		const polls = report.presence.slice(count);
		assert.ok(
			polls.length && polls.every((row) => !row.claimId),
			`${label}: actual scheduler poll missing`
		);
		assert.ok(polls.some(matches), `${label}: actual presence did not carry the veto`);
		report.deferrals.push({ label, durationMs: Date.now() - start, polls: polls.length });
	}
	async function activeKind(kind) {
		const attempt = await wait(
			`${kind} default-App initiative`,
			() => report.attends.find((row) => claims.get(row.claimId).items[0].kind === kind),
			35000
		);
		await wait(`${kind} real speech and decoded PCM`, async () => {
			const session = sessions.get(key(attempt));
			return session?.speechId && outputFor(await media(), session)?.nonSilent > 4;
		});
		assert.equal(report.releases.length, 0);
		assert.equal(notice(kind).announcedAt, null, "Notice announced before speech drain");
		await wait(`${kind} actual checkpoint action`, () => attempt.checkpoint);
		return { attempt, session: sessions.get(key(attempt)) };
	}
	async function quit(error) {
		if (quitting) return;
		quitting = true;
		if (error) {
			report.status = "failed";
			report.error = error.message;
		}
		for (const timer of timers) clearTimeout(timer);
		try {
			if (win && !win.isDestroyed()) {
				report.finalMedia ??= await media();
				await js("window.__handsSmoke.dispose()");
				report.controlledMediaDisposed = true;
			}
		} catch (error) {
			if (report.status === "passed") {
				report.status = "failed";
				report.error = `Controlled media cleanup failed: ${error.message}`;
			}
		}
		save();
		app.quit();
	}
	app.once("will-quit", (event) => {
		event.preventDefault();
		clearTimeout(deadline);
		for (const timer of timers) clearTimeout(timer);
		ipcMain.handle = originalHandle;
		ipcMain.removeHandler("trpc:request");
		report.ipcObserverRemoved = true;
		const managerStopped = sidecarPort
			? new Promise((done, reject) => {
					const socket = net.createConnection({ host: "127.0.0.1", port: sidecarPort });
					socket.setTimeout(1000);
					socket.once("connect", () => {
						socket.destroy();
						reject(new Error("Owned voice manager sidecar survived shutdown"));
					});
					socket.once("timeout", () => {
						socket.destroy();
						reject(new Error("Voice manager cleanup check timed out"));
					});
					socket.once("error", (error) => (error.code === "ECONNREFUSED" ? done() : reject(error)));
				})
			: Promise.resolve();
		void managerStopped
			.then(() => {
				report.sidecarManagerStopped = !!sidecarPort;
			})
			.catch((error) => {
				report.status = "failed";
				report.error = error.message;
			})
			.finally(() => {
				try {
					const finalState = state();
					if (report.status === "passed") {
						assert.equal(
							finalState.notices.find((row) => row.kind === "work-ready").announcedAt,
							null
						);
						assert.equal(
							finalState.notices.find((row) => row.kind === "decision").announcedAt,
							null
						);
						assert.ok(finalState.notices.find((row) => row.kind === "work-failed").announcedAt);
						assert.equal(finalState.attentionRecords.filter((row) => row.deliveredAt).length, 1);
						assert.ok(finalState.attentionRecords.every((row) => row.attempts === 1));
						report.sqliteReconnectAfterShutdown = true;
						report.persistedLedger = finalState.attentionRecords;
						const diagnostics = fs.readFileSync(
							join(owned, "diagnostics/conversation.jsonl"),
							"utf8"
						);
						for (const marker of [...privateMarkers, TRANSCRIPT, "The controlled job failed."])
							assert.ok(!diagnostics.includes(marker));
						const rows = diagnostics
							.trim()
							.split("\n")
							.map((row) => JSON.parse(row));
						assert.ok(rows.some((row) => row.stage === "first-audio"));
						assert.ok(rows.some((row) => row.stage === "shutdown-complete"));
						report.privateNumericDiagnostics = true;
					}
				} catch (error) {
					report.status = "failed";
					report.error = error.message;
				}
				try {
					assert.equal(fs.readFileSync(join(owned, ".attention-owner"), "utf8"), owner);
					fs.rmSync(owned, { recursive: true, maxRetries: 5, retryDelay: 100 });
					report.ownedTempRemoved = true;
				} catch (error) {
					report.status = "failed";
					report.error = error.message;
				}
				globalThis.fetch = originalFetch;
				save();
				console.log(`ATTENTION_SMOKE_${report.status.toUpperCase()}: ${reportPath}`);
				app.exit(report.status === "passed" ? 0 : 1);
			});
	});
	const deadline = setTimeout(() => {
		void quit(new Error("180-second attention acceptance deadline"));
	}, 175000);
	try {
		await import(
			pathToFileURL(resolve(process.argv[2] ?? join(__dirname, "../../out/main/index.js"))).href
		);
		await app.whenReady();
		win = await wait("built main window", () => BrowserWindow.getAllWindows()[0]);
		win.setIgnoreMouseEvents(true);
		win.setFocusable(false);
		win.webContents.setAudioMuted(true);
		await wait("loaded default App", () => !win.webContents.isLoadingMainFrame());
		assert.ok(observerInstalled);
		await wait("default Home", () =>
			js(`document.querySelector('.hub-center')?.dataset.centerSection==='home'`)
		);
		const config = await rpc("query", "app.config");
		assert.equal(config.envPath, envPath);
		assert.equal(
			config.microphone,
			"granted",
			"Actual app microphone permission required; permission is not simulated"
		);
		await wait(
			"actual owned sidecar manager ready",
			async () => {
				const voice = await rpc("query", "voice.status");
				assert.notEqual(voice.phase, "error", voice.error);
				return voice.phase === "ready";
			},
			50000
		);
		report.realManagerReadiness = true;
		await js(`(${installControlledMedia.toString()})(${measureControlledPcm.toString()})`);
		await focus(true);
		await noInitiative(
			"disabled before explicit Start",
			(row) => !row.enabled && row.state === "disabled"
		);
		assert.equal((await rpc("query", "hub.snapshot")).jobs.length, 3);
		const sessionId = report.presence.at(-1).sessionId;
		const workspace = (await rpc("query", "workspace.observe", { sessionId })).workspace;
		report.initialWorkspace = workspace;
		await js(
			`document.querySelector('[data-testid="voice-control"][aria-label="Start conversation"]').click()`
		);
		startClicks++;
		await js(`document.querySelector('[data-testid="workspace-more"]').click()`);
		await wait("actual More dialog", () => js(`!!document.querySelector('#workspace-more[open]')`));
		await wait("one persistent hands-free microphone", async () => (await ui()).armed === "true");
		await wait("real input worklet frames", async () =>
			(await media()).worklets.some((row) => row.name === "voice-hands-free" && row.frames > 5)
		);
		await noInitiative("open real workspace modal", (row) => row.obscured);
		await focus(false);
		await js(
			`document.querySelector('#workspace-more [aria-label="Close workspace options"]').click()`
		);
		await wait("modal removed", () => js("!document.querySelector('dialog')"));
		await noInitiative("native authoritative unfocused window", (row) => !row.focused);
		await focus(true);
		const inputStart = Date.now();
		// Real DOM input events reach App's safety listener. No message is submitted.
		while (Date.now() - inputStart < 3600) {
			await js("document.dispatchEvent(new Event('input',{bubbles:true}))");
			await sleep(180);
			assert.equal(report.attends.length, 0);
		}
		assert.ok(
			report.presence.some((row) => row.enabled && row.focused && row.state === "interacting")
		);
		report.deferrals.push({ label: "recent DOM input", durationMs: Date.now() - inputStart });
		const afterInput = Date.now();
		await sleep(1800);
		assert.equal(report.attends.length, 0, "Recent input quiet window was bypassed");
		const first = await activeKind("decision");
		assert.ok(first.attempt.at - afterInput >= 2400);
		assert.equal(report.claims[0].items[0].kind, "decision");
		assert.equal(first.attempt.sessionId, sessionId);
		assert.deepEqual((await rpc("query", "workspace.observe", { sessionId })).workspace, workspace);
		// Deliberately negative: displayed text cannot establish spoken delivery in root services.
		manualProbe = true;
		try {
			assert.equal(
				(
					await rpc("mutation", "conversation.narrationApplied", {
						...identity(first.attempt),
						requestId: first.attempt.checkpoint.requestId,
						status: "displayed",
					})
				).status,
				"accepted"
			);
			assert.equal(
				(
					await rpc("mutation", "attention.settle", {
						...identity(first.attempt),
						claimId: first.attempt.claimId,
						status: "spoken",
					})
				).status,
				"stale"
			);
		} finally {
			manualProbe = false;
		}
		assert.equal(notice("decision").announcedAt, null);
		report.displayedCannotSettleSpoken = true;
		await focus(false); // Actual preload safety path cancels playback; no fabricated user turn.
		await wait(
			"displayed-only attempt retired",
			async () => (await media()).peers[first.session.local].state === "closed"
		);
		await focus(true);
		const second = await activeKind("work-failed");
		assert.equal(report.claims[1].items[0].kind, "work-failed");
		assert.deepEqual((await rpc("query", "workspace.observe", { sessionId })).workspace, workspace);
		assert.equal(notice("work-failed").announcedAt, null);
		assert.equal(report.narration.filter((row) => row.status === "spoken").length, 0);
		await endSpeech(second.session);
		await sleep(100);
		assert.equal(
			notice("work-failed").announcedAt,
			null,
			"Speech-ended alone is not drained delivery"
		);
		await wait(
			"actual PCM/drain receipt persisted announcement",
			() => notice("work-failed").announcedAt
		);
		const deliveredAt = notice("work-failed").announcedAt;
		assert.ok(
			report.narration.some((row) => key(row) === key(second.attempt) && row.status === "spoken")
		);
		assert.ok(
			state().attentionRecords.some(
				(row) => row.noticeIds.includes(notice("work-failed").id) && row.deliveredAt === deliveredAt
			)
		);
		report.actualPcmDrainDelivery = true;
		assert.deepEqual((await rpc("query", "workspace.observe", { sessionId })).workspace, workspace);
		await sleep(3000);
		assert.equal(report.attends.length, 2, "20-second global delivery cooldown was bypassed");
		const third = await activeKind("work-ready");
		assert.ok(third.attempt.at - Date.parse(deliveredAt) >= 20000);
		assert.deepEqual(
			report.claims.map((row) => row.items[0].kind),
			["decision", "work-failed", "work-ready"]
		);
		report.priorityAndCooldownVerified = true;
		assert.equal(report.releases.length, 0, "No initiative may use STT/capture release");
		assert.equal((await media()).microphones.length, 1);
		report.bargeWaveform = await js("window.__handsSmoke.drive([[700,650]])");
		await wait(
			"real microphone barge-in closes proactive peer",
			async () =>
				report.cancels.some((row) => key(row) === key(third.attempt)) &&
				(await media()).peers[third.session.local].state === "closed"
		);
		const retiredPcm = outputFor(await media(), third.session).nonSilent;
		// Keep remote tone alive briefly (shared fixture cancel) and supply late transport events.
		event(third.session, "speech-started", { speechId: "late-cancelled" });
		event(third.session, "transcript", { text: LATE, final: true });
		event(third.session, "speech-ended", { speechId: third.session.speechId });
		await sleep(800);
		assert.ok(
			outputFor(await media(), third.session).nonSilent <= retiredPcm + 1,
			"Cancelled output still decoded after local peer closure"
		);
		assert.equal(notice("work-ready").announcedAt, null);
		assert.ok(
			!report.narration.some((row) => key(row) === key(third.attempt) && row.status === "spoken")
		);
		await wait(
			"same microphone submits actual followup and finishes playback",
			async () =>
				report.releases.length === 1 &&
				(await ui()).messages.some(
					(row) => row.turnId === report.releases[0].turnId && row.phase === "complete"
				),
			20000
		);
		const final = await media();
		assert.equal(final.microphones.length, 1);
		assert.equal(final.microphones[0].state, "live");
		assert.equal((await ui()).armed, "true");
		assert.ok(!(await ui()).messages.some((row) => row.answer.includes(LATE)));
		assert.deepEqual((await rpc("query", "workspace.observe", { sessionId })).workspace, workspace);
		assert.equal(report.models.filter((row) => row.kind === "real-user-followup").length, 1);
		report.realBargeInAndListeningContinuity = true;
		const readyRecord = state().attentionRecords.find((row) =>
			row.noticeIds.includes(notice("work-ready").id)
		);
		assert.equal(readyRecord.attempts, 1);
		assert.equal(readyRecord.deliveredAt, null);
		assert.ok(
			Date.now() - Date.parse(readyRecord.lastAttemptAt) < 60000,
			"Run escaped the bounded retry window"
		);
		report.cancelledNoticeRemainsPending = true;
		await js(
			`document.querySelector('[data-testid="voice-control"][aria-label="End conversation"]').click()`
		);
		await wait("End closes actual media", async () => {
			const current = await media();
			return (
				(await ui()).armed === "false" &&
				current.microphones.every((row) => row.state === "ended") &&
				current.contexts.every((value) => value === "closed") &&
				current.peers.every((row) => row.state === "closed")
			);
		});
		report.finalMedia = await media();
		assert.equal(startClicks, 1);
		assert.ok(report.finalMedia.microphones[0].stops >= 1);
		assert.equal(report.offers.length, 4);
		assert.equal(report.releases.length, 1);
		assert.equal(report.attends.length, 3);
		assert.equal(report.models.length, 4);
		assert.deepEqual(report.blocked, []);
		report.status = "passed";
		await quit();
	} catch (error) {
		await quit(error);
	}
}

function selfCheck() {
	assert.equal(typeof installControlledMedia, "function");
	assert.equal(typeof measureControlledPcm, "function");
	new Function(`return (${installControlledMedia.toString()})`);
	const seed = seedState("2026-10-30T00:00:00.000Z");
	assert.deepEqual(
		seed.jobs.map((job) => job.state),
		["needs-input", "failed", "ready"]
	);
	assert.ok(
		seed.notices.every(
			(row, index) => row.headSha === seed.jobs[index].headSha && row.announcedAt === null
		)
	);
	assert.equal(seed.jobs[0].decisions[0].id, seed.notices[0].decisionId);
	assert.ok(
		Date.parse(seed.notices[2].createdAt) > Date.parse(seed.notices[0].createdAt),
		"Newest ready event must not trivially win the priority test"
	);
	assert.ok(seed.jobs.every((job) => job.checks.length === 0 && job.worktreePath === null));
	const input = {
		sessionId: "s",
		turnId: "t",
		generation: 1,
		requestId: "request",
		claimId: "claim",
	};
	assertAttentionInput(input);
	for (const extra of [{ text: "fake user" }, { prId: "fake-pr" }, { workspace: {} }])
		assert.throws(() => assertAttentionInput({ ...input, ...extra }));
	const claim = { id: "claim", items: [seed.notices[0]] };
	const body = {
		tools: [],
		max_output_tokens: 512,
		input: [{ role: "developer", content: JSON.stringify({ assistantInitiatedAttention: claim }) }],
	};
	assertReadOnlyRequest(body, claim);
	assert.throws(() => assertReadOnlyRequest({ ...body, tools: [{ name: "start_work" }] }, claim));
	assert.throws(() =>
		assertReadOnlyRequest(
			{ ...body, input: [{ role: "user", content: "fake question" }, ...body.input] },
			claim
		)
	);
	assertDrainProof({ nonSilent: 8, lastNonSilentAt: 1000 }, 1000, 1400);
	assert.throws(() => assertDrainProof({ nonSilent: 8, lastNonSilentAt: 1000 }, 1000, 1050));
	assert.throws(() => assertDrainProof({ nonSilent: 0, lastNonSilentAt: 1000 }, 1000, 1400));
	const tone = Float32Array.from(
		{ length: 4800 },
		(_, i) => Math.sin((i * Math.PI * 2 * 300) / 48000) * 0.14
	);
	assert.ok(measureControlledPcm(tone, 48000).rms > 0.09);
	console.log(
		"ATTENTION_SELF_CHECK_PASS: seed pins, no-text initiative, readonly provider packet, PCM/drain guards, shared fixture syntax; NO app/SQLite/media/network launched"
	);
}

if (
	require.main === module ||
	(process.versions.electron && process.argv[1] && resolve(process.argv[1]) === resolve(__filename))
) {
	if (process.argv.includes("--self-check")) selfCheck();
	else
		native().catch((error) => {
			console.error(error.message);
			process.exitCode = 1;
		});
}
