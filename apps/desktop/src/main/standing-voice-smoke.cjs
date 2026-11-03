// MET-8. Root-only native gate. See standing-voice-smoke/README.md.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const H = require("./standing-clarification-smoke/provider.cjs");
const { MODEL_KEY, TOKEN, APP_ID, digest } = H;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const localURL = (value) =>
	["file:", "data:", "blob:", "about:", "devtools:"].includes(new URL(value).protocol);
const dataOf = (result) => result?.result?.data?.json;
async function native() {
	assert.ok(
		process.versions.electron && !process.env.ELECTRON_RENDERER_URL,
		"Root must run built default Electron; author only runs node --check"
	);
	const built = resolve(process.argv[2] ?? join(__dirname, "../../out/main/index.js"));
	assert.ok(fs.existsSync(built), "Build the integrated App first");
	const { app, BrowserWindow, ipcMain, shell, session } = require("electron");
	app.commandLine.appendSwitch("use-fake-device-for-media-stream");
	for (const key of Object.keys(process.env))
		if (
			/(?:TOKEN|SECRET|API_KEY|CLIENT_ID|VOICE_ID)/i.test(key) ||
			/^(?:SLACK_|LINEAR_|GITHUB_|GH_|META_|MODEL_|ELEVENLABS_|MUSE_|VITE_|METAHACKATHON_)/.test(
				key
			)
		)
			delete process.env[key];
	const owned = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "met-standing-voice-")));
	const owner = randomUUID();
	const marker = join(owned, ".owner");
	fs.writeFileSync(marker, owner, { mode: 0o600 });
	const identity = fs.statSync(owned);
	const profile = join(owned, "profile");
	fs.mkdirSync(profile, { mode: 0o700 });
	const envPath = join(owned, ".env");
	const writeConfig = (token) =>
		fs.writeFileSync(
			envPath,
			`MODEL_API_KEY=${MODEL_KEY}\nELEVENLABS_API_KEY=controlled-standing-tts\nELEVENLABS_VOICE_ID=controlled-standing-voice\nSLACK_INTERNAL_APP=1\nSLACK_APP_ID=${APP_ID}\n${token ? `SLACK_USER_TOKEN=${token}\n` : ""}`,
			{ mode: 0o600 }
		);
	writeConfig(); // No source token or stored source/job at startup.
	process.env.METAHACKATHON_ENV_FILE = envPath;
	app.setPath("userData", profile);
	const reportPath = join(__dirname, "../../out/standing-voice-smoke-report.json");
	fs.mkdirSync(join(__dirname, "../../out"), { recursive: true });

	const report = {
		status: "running",
		builtMain: built,
		builtMainSha256: digest(fs.readFileSync(built)),
		controlledHTTP: true,
		liveSlack: false,
		liveModel: false,
		liveSpeech: false,
		syntheticAudio: true,
		controlledASR: true,
		controlledTTS: true,
		physicalSpeakerMuted: true,
		releases: [],
		speaks: [],
		narration: [],
		voice: { status: "running", acousticVerification: false },
		clockReplaced: false,
		fullProcessRestart: false,
		checks: [],
		ipc: [],
		checkpoints: [],
		polls: [],
		http: [],
		posts: [],
		blocked: [],
	};
	const redact = (value) =>
		[MODEL_KEY, TOKEN].reduce((s, key) => s.split(key).join("[CONTROLLED]"), String(value));
	const save = () => fs.writeFileSync(reportPath, `${redact(JSON.stringify(report, null, 2))}\n`);
	const originals = {
		fetch: globalThis.fetch,
		handle: ipcMain.handle,
		open: shell.openExternal,
		socket: globalThis.WebSocket,
	};
	let mediaTransport;
	let failure;
	let win;
	let Database;
	let complete = false;
	let stopping = false;
	let auditInstalled = false;
	const fail = (error) => {
		failure ??= error;
		return error;
	};
	const forbid = (surface) => {
		report.blocked.push(surface);
		throw fail(Error(`Forbidden ${surface}`));
	};
	async function wait(label, read, timeout = 30000) {
		const end = Date.now() + timeout;
		while (Date.now() < end) {
			if (failure) throw failure;
			const value = await read();
			if (value) return value;
			await sleep(150);
		}
		throw Error(`Timed out: ${label}`);
	}
	const sql = (read) => {
		const db = new Database(join(profile, "metahackathon.db"), {
			readonly: true,
			fileMustExist: true,
		});
		try {
			return read(db);
		} finally {
			db.close();
		}
	};
	const stored = (table) =>
		sql((db) => {
			const row = db.prepare(`SELECT data_json FROM ${table} WHERE id=1`).get();
			return row ? JSON.parse(row.data_json) : null;
		});
	const day = () => stored("day_state");
	const standing = () => stored("standing_clarification_state") ?? { rules: [], admissions: [] };
	const provider = H.create({ report, day, standing, fail });
	shell.openExternal = async () => forbid("external-browser");
	globalThis.WebSocket = class {
		constructor() {
			forbid("WebSocket");
		}
	};
	const restrict = (s) => {
		s.setPermissionRequestHandler((_, __, done) => done(false));
		s.setPermissionCheckHandler(() => false);
		s.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, done) => {
			const allowed = localURL(details.url);
			if (!allowed) {
				report.blocked.push("Chromium-network");
				fail(Error("Unexpected Chromium network"));
			}
			done({ cancel: !allowed });
		});
	};
	app.on("session-created", restrict);
	app.on("browser-window-created", (_, window) => {
		window.setFocusable(false);
		window.setIgnoreMouseEvents(true);
		window.webContents.on("before-input-event", (event) => event.preventDefault());
	});

	ipcMain.handle = function (channel, handler) {
		if (channel !== "trpc:request") return originals.handle.call(this, channel, handler);
		return originals.handle.call(this, channel, async (event, request) => {
			const watched =
				/^(conversation\.(?:start|cancel|narrationApplied)$|workspace.applied$|slack.connect$|voice\.(?:release|cancel)$)/.test(
					request.path
				);
			const row = watched
				? { path: request.path, input: request.input?.json, at: Date.now() }
				: null;
			if (row) report.ipc.push(row);
			if (row?.path === "conversation.narrationApplied" && row.input.status === "spoken")
				row.drain = await mediaTransport.observeReceipt(row.input).catch((error) => {
					throw fail(error);
				});
			const result = await handler(event, request);
			if (request.path === "conversation.poll") {
				const polled = dataOf(result);
				if (polled) report.polls.push({ turnId: request.input.json.turnId, status: polled.status });
				for (const action of dataOf(result)?.actions ?? []) {
					if (
						action.kind === "narration-checkpoint" &&
						!report.checkpoints.some((a) => a.requestId === action.requestId)
					)
						report.checkpoints.push(action);
				}
			}
			if (row) {
				row.finishedAt = Date.now();
				row.rejected = !!result?.error;
				row.result = dataOf(result);
			}
			return result;
		});
	};
	mediaTransport = require("./standing-voice-smoke/media.cjs").create({
		js: (code) => win.webContents.executeJavaScript(code),
		report,
		fail,
		provider,
	});
	globalThis.fetch = mediaTransport.fetch;
	const hardStop = setTimeout(() => {
		report.status = "failed";
		report.error = "Hard deadline; profile retained";
		report.retainedProfile = owned;
		save();
		app.exit(1);
	}, 540000);
	const deadline = setTimeout(() => stop(Error("Standing gate exceeded 8.5 minutes")), 510000);
	function stop(error) {
		if (error) fail(error);
		if (stopping) return;
		stopping = true;
		provider.release();
		mediaTransport?.dispose();
		installAudit();
		app.quit();
	}
	function installAudit() {
		if (auditInstalled) return;
		auditInstalled = true;
		app.once("will-quit", async (event) => {
			event.preventDefault();
			clearTimeout(deadline);
			clearTimeout(hardStop);
			try {
				report.sidecarManagerStopped = await mediaTransport.verifyStopped();
				try {
					report.sqliteObservedAtShutdown = { standing: standing(), day: day() };
				} catch (error) {
					report.sqliteObservationError = error.message;
				}
				if (failure) throw failure;
				assert.ok(complete, "App quit before gate completed");
				assert.ok(win.isDestroyed());
				assert.ok(
					fs
						.readFileSync(join(profile, "diagnostics/conversation.jsonl"), "utf8")
						.split("\n")
						.filter(Boolean)
						.map(JSON.parse)
						.some((r) => r.stage === "shutdown-complete")
				);
				const durable = standing();
				assert.equal(durable.rules.filter((r) => r.status === "active").length, 1);
				assert.equal(durable.admissions.length, 1);
				assert.equal(report.posts.length, 1);
				const deliveries = day()
					.records.flatMap((r) => r.outbox)
					.filter((r) => r.status === "delivered");
				assert.equal(deliveries.length, 1);
				report.sqliteAfterShutdown = { standing: durable, delivered: deliveries };
				assert.deepEqual(report.blocked, []);
				report.status = "passed";
				report.voice.status = "passed";
			} catch (error) {
				report.status = "failed";
				report.voice.status = "failed";
				report.error = redact(error.stack);
			}
			try {
				assert.equal(fs.realpathSync(owned), owned);
				assert.equal(fs.lstatSync(owned).isSymbolicLink(), false);
				const current = fs.statSync(owned);
				assert.equal(current.ino, identity.ino);
				assert.equal(current.dev, identity.dev);
				assert.equal(fs.readFileSync(marker, "utf8"), owner);
				fs.rmSync(owned, { recursive: true });
				report.cleanup = "removed verified owned temporary profile/config only";
			} catch (error) {
				report.status = "failed";
				report.cleanup = "retained unverified path";
				report.error = redact(error.message);
			}
			globalThis.fetch = originals.fetch;
			ipcMain.handle = originals.handle;
			shell.openExternal = originals.open;
			globalThis.WebSocket = originals.socket;

			save();
			console.log(`STANDING_VOICE_SMOKE_${report.status.toUpperCase()}: ${reportPath}`);
			app.exit(report.status === "passed" ? 0 : 1);
		});
	}
	try {
		await app.whenReady();
		restrict(session.defaultSession);
		await import(pathToFileURL(built).href);
		installAudit();
		Database = require("better-sqlite3");
		win = await wait("default window", () => BrowserWindow.getAllWindows()[0]);
		assert.equal(BrowserWindow.getAllWindows().length, 1);
		const js = (code) => win.webContents.executeJavaScript(code);
		win.webContents.setAudioMuted(true);
		await wait("actual App/preload", () =>
			js("!!document.querySelector('main[data-session-id]') && !!window.electron?.trpc?.request")
		);
		assert.equal(new URL(win.webContents.getURL()).protocol, "file:");
		report.builtRendererSha256 = digest(fs.readFileSync(new URL(win.webContents.getURL())));
		await require("./standing-voice-smoke/scenario.cjs").run({
			assert,
			js,
			wait,
			sleep,
			report,
			save,
			writeConfig,
			TOKEN,
			envPath,
			day,
			standing,
			provider,
			mediaTransport,
		});
		complete = true;
		stop();
	} catch (error) {
		stop(error);
	}
}
if (require.main === module || process.versions.electron)
	(process.argv.includes("--self-check")
		? require("./standing-voice-smoke/self-check.cjs").run()
		: native()
	).catch((error) => {
		console.error(`STANDING_VOICE_SMOKE_FAILED: ${error.message}`);
		process.exitCode = 1;
	});
