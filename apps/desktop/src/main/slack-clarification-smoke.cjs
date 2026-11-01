// MET-76 / MET-8. ROOT ONLY, after building integration (from apps/desktop):
// env -u ELECTRON_RUN_AS_NODE electron src/main/slack-clarification-smoke.cjs [out/main/index.js]
// AUTHOR: node --check only; do not launch, build, acquire keys, or wire a package script here.
// Real default App, renderer, preload, routers, SlackWorkspace classification/capture and SQLite.
// Only global HTTP transport is populated with controlled Slack/Muse responses. No service/RPC
// replacement, capture injection, fixture startup switch, clock replacement, OAuth grant injection,
// exact-reply consent, coding admission, live Slack/GitHub, microphone or process-restart claim.
// Uses the actual optional manual .env user-token import (OAuth native consent has its own gate).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const childProcess = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const { syncBuiltinESMExports } = require("node:module");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const MODEL = "https://api.meta.ai/v1/responses";
const MODEL_KEY = "controlled-clarification-model-not-a-key";
const TOKEN = "xoxp-controlled-clarification-not-a-token";
const NEXT_TOKEN = "xoxp-controlled-clarification-second-account";
const ACTOR = { workspaceId: "T76001", userId: "U76001" };
const NEXT_ACTOR = { workspaceId: "T76001", userId: "U76003" };
const REQUESTER = "U76002";
const CHANNEL = "C76001";
const APP_ID = "A76001";
const TITLE = "Controlled clarification request";
const ORIGINAL = `PRIVATE-ORIGINAL-76: <@${ACTOR.userId}> please prepare the report; ask me which period.`;
const ANSWER = "PRIVATE-ANSWER-76: Use October 2026, totals only.";
const QUESTION = "Which reporting period and level of detail should the report cover?";
const BRIEF = `PRIVATE-BRIEF-76: ${REQUESTER} requested October 2026 totals only.`;
const SCOPE = "Ask only which reporting period and level of detail the report should cover.";
const SCOPES = [
	"channels:read",
	"channels:history",
	"groups:read",
	"groups:history",
	"im:read",
	"im:history",
	"mpim:read",
	"mpim:history",
	"users:read",
	"chat:write",
];
const CLARIFICATION = 'section[aria-label="Slack clarification"]';
const SLACK_SETTINGS = '#configuration section[aria-label="Slack connection"]';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const digest = (text) => createHash("sha256").update(text).digest("hex");
const timestamp = () => {
	const now = Date.now();
	return `${Math.floor(now / 1000)}.${String((now % 1000) * 1000).padStart(6, "0")}`;
};
const dataOf = (result) => result?.result?.data?.json;
function localURL(value) {
	try {
		return ["file:", "data:", "blob:", "about:", "devtools:"].includes(new URL(value).protocol);
	} catch {
		return false;
	}
}
function metadataOnly(snapshot) {
	for (const item of snapshot.items) {
		assert.equal(item.clarification, undefined, "Polling exposed stored thread/brief");
		if (item.clarificationMetadata)
			assert.deepEqual(
				Object.keys(item.clarificationMetadata).sort(),
				["policyId", "policyRevision", "status", "confirmedAt", "expiresAt"].sort()
			);
	}
	for (const marker of [ORIGINAL, ANSWER, BRIEF, QUESTION])
		assert.ok(
			!JSON.stringify(snapshot).includes(marker),
			"Private clarification escaped routine polling"
		);
}
function modelResponse(body, value) {
	assert.equal(body.stream, true);
	assert.equal(body.store, false);
	assert.deepEqual(body.tools ?? [], [], "Intake/clarification must have no action tools");
	return new Response(
		`data: ${JSON.stringify({
			type: "response.completed",
			response: {
				id: `controlled-${randomUUID()}`,
				model: body.model,
				status: "completed",
				usage: null,
				output: [
					{
						type: "message",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: JSON.stringify(value) }],
					},
				],
			},
		})}\n\n`,
		{ headers: { "content-type": "text/event-stream" } }
	);
}

// Same observation pattern as day-smoke: wrap app rAF callbacks; never fabricate frames/acks.
const frameObserver = `(() => {
	const visible = e => !!e && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0;
	const read = () => {
		const root = document.querySelector('.canvas-workspace[data-workspace-sequence]');
		const selected = [...document.querySelectorAll('[data-center-section="day"][data-selected-id]')].find(visible);
		const item = selected?.querySelector('article.day-item[aria-label="Day work item"]');
		return { sequence: Number(root?.dataset.workspaceSequence), itemId: selected?.dataset.selectedId,
			title: item?.querySelector('h1')?.textContent, visible: visible(item) && !document.querySelector('dialog[open]') };
	};
	const original = window.requestAnimationFrame;
	const audit = window.__clarificationFrames = { frames: [], read };
	window.requestAnimationFrame = function(callback) {
		const scheduled = read();
		return original.call(window, timestamp => {
			audit.frames.push({ ...read(), timestamp, at: Date.now(), scheduledSequence: scheduled.sequence });
			if (audit.frames.length > 160) audit.frames.shift();
			return callback(timestamp);
		});
	};
})()`;
function displayedReceipt(row, itemId) {
	assert.equal(row.status, "accepted");
	const w = row.input.workspace;
	const selected = w.canvases.find((c) => c.id === w.primaryId);
	assert.equal(selected.section, "day");
	assert.equal(selected.selectedId, itemId);
	const matches = (frame) =>
		frame?.itemId === itemId &&
		frame.title === TITLE &&
		frame.visible &&
		frame.sequence === w.sequence;
	assert.ok(matches(row.ui?.state), "Positive receipt preceded the actual selected source item");
	const frames = row.ui.frames.filter(
		(frame) => matches(frame) && frame.at <= row.at && frame.scheduledSequence === w.sequence
	);
	assert.ok(
		new Set(frames.map((frame) => frame.timestamp)).size >= 2,
		"Positive receipt preceded two matching app frames"
	);
}

async function native() {
	assert.ok(
		process.versions.electron && !process.env.ELECTRON_RENDERER_URL,
		"Root must run built default Electron; author only runs node --check"
	);
	const built = resolve(process.argv[2] ?? join(__dirname, "../../out/main/index.js"));
	assert.ok(fs.existsSync(built), "Build the integrated App first");
	const { app, BrowserWindow, ipcMain, shell, session } = require("electron");
	for (const key of Object.keys(process.env))
		if (
			/(?:TOKEN|SECRET|API_KEY|CLIENT_ID|VOICE_ID)/i.test(key) ||
			/^(?:SLACK_|LINEAR_|GITHUB_|GH_|META_|MODEL_|ELEVENLABS_|MUSE_|VITE_|METAHACKATHON_)/.test(
				key
			)
		)
			delete process.env[key];
	const owned = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "met-slack-clarification-")));
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
			`MODEL_API_KEY=${MODEL_KEY}\nSLACK_INTERNAL_APP=1\nSLACK_APP_ID=${APP_ID}\n${token ? `SLACK_USER_TOKEN=${token}\n` : ""}`,
			{ mode: 0o600 }
		);
	writeConfig(); // No source token or stored source/job at startup.
	process.env.METAHACKATHON_ENV_FILE = envPath;
	app.setPath("userData", profile);
	const reportPath = join(__dirname, "../../out/slack-clarification-smoke-report.json");
	fs.mkdirSync(join(__dirname, "../../out"), { recursive: true });
	const report = {
		status: "running",
		builtMain: built,
		builtMainSha256: digest(fs.readFileSync(built)),
		controlledHTTP: true,
		credentialFlow: "actual-manual-user-token-import",
		liveSlack: false,
		liveGitHub: false,
		liveModel: false,
		liveOAuth: false,
		liveSpeech: false,
		physicalMicrophone: false,
		fullProcessRestart: false,
		clockReplaced: false,
		checks: [],
		ipc: [],
		http: [],
		posts: [],
		blocked: [],
	};
	const secrets = [MODEL_KEY, TOKEN, NEXT_TOKEN];
	const redact = (value) =>
		secrets.reduce((text, secret) => text.split(secret).join("[CONTROLLED]"), String(value));
	const save = () => fs.writeFileSync(reportPath, `${redact(JSON.stringify(report, null, 2))}\n`);
	const originals = {
		fetch: globalThis.fetch,
		handle: ipcMain.handle,
		open: shell.openExternal,
		socket: globalThis.WebSocket,
	};
	const children = new Map();
	let failure;
	let complete = false;
	let stopping = false;
	let auditInstalled = false;
	let win;
	let itemId;
	let Database;
	let sourceEnabled = false;
	let member = true;
	let sourceEdited = false;
	let changedHeadReads = 0;
	let membershipDenials = 0;
	let answered = false;
	let holdScope = null;
	let held = null;
	const source = { ts: timestamp(), user: REQUESTER, text: ORIGINAL, reply_count: 0 };
	const sent = [];
	let answer;
	const fail = (error) => {
		failure ??= error;
		return error;
	};
	const forbid = (surface) => {
		report.blocked.push(surface);
		throw fail(Error(`Forbidden ${surface}`));
	};
	async function wait(label, read, timeout = 18000) {
		const end = Date.now() + timeout;
		for (let count = 0; count < 180 && Date.now() < end; count++) {
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
	const state = () =>
		sql((db) =>
			JSON.parse(db.prepare("SELECT data_json FROM day_state WHERE id=1").get().data_json)
		);
	const record = () => state().records.find((row) => row.item.id === itemId);
	const checkPolicy = (item) => {
		const c = item.clarification;
		assert.ok(c);
		assert.deepEqual(c.policy.actor, ACTOR);
		assert.equal(c.policy.source.workspaceId, ACTOR.workspaceId);
		assert.equal(c.policy.source.conversationId, CHANNEL);
		assert.equal(c.policy.source.messageId, source.ts);
		assert.equal(c.policy.source.revisionId, source.ts);
		assert.equal(c.policy.originalRequest, ORIGINAL);
		assert.equal(c.policy.sendAuthority, "clarification-only-original-thread");
		assert.equal(c.policy.maxMessages, 1);
		assert.equal(c.policy.durationMinutes, 5);
		if (c.confirmedAt) {
			assert.equal(
				Date.parse(c.expiresAt) - Date.parse(c.confirmedAt),
				300000,
				"Expiry must derive exactly from the captured confirmation instant"
			);
			assert.ok(Date.parse(c.expiresAt) > Date.now(), "Fresh delegation is already expired");
		}
		assert.equal(item.acceptance, "pending");
		assert.equal(item.jobId, null);
		assert.equal(item.answerReceipt, null);
		assert.notEqual(item.phase, "closed");
	};
	for (const name of [
		"spawn",
		"spawnSync",
		"exec",
		"execSync",
		"execFile",
		"execFileSync",
		"fork",
	]) {
		children.set(name, childProcess[name]);
		childProcess[name] = () => forbid(`child-process:${name}`);
	}
	syncBuiltinESMExports();
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
	// Audit the registered default router without changing inputs, results, or authority.
	ipcMain.handle = function (channel, handler) {
		if (channel !== "trpc:request") return originals.handle.call(this, channel, handler);
		return originals.handle.call(this, channel, async (event, request) => {
			const input = request.input?.json;
			const watched = /^(?:day\.|slack.connect$|workspace.applied$)/.test(request.path);
			const row = watched ? { path: request.path, input, at: Date.now() } : null;
			if (row) report.ipc.push(row);
			if (row?.path === "workspace.applied" && win && !win.isDestroyed()) {
				row.ui = await win.webContents.executeJavaScript(
					"window.__clarificationFrames ? ({state:window.__clarificationFrames.read(),frames:window.__clarificationFrames.frames.slice()}) : null"
				);
				row.observedAt = Date.now();
			}
			const result = await handler(event, request);
			if (row) {
				row.finishedAt = Date.now();
				row.rejected = !!result?.error;
				if (request.path === "day.snapshot" && !result.error) {
					try {
						metadataOnly(dataOf(result));
					} catch (error) {
						throw fail(error);
					}
				}
				if (request.path === "day.operate") {
					row.itemId = dataOf(result)?.itemId;
					row.sequence = dataOf(result)?.snapshot.sequence;
					if (!result.error && input.operation.kind !== "propose_clarification")
						try {
							metadataOnly(dataOf(result).snapshot);
						} catch (error) {
							throw fail(error);
						}
				}
				if (request.path === "workspace.applied") row.status = dataOf(result)?.status;
			}
			return result;
		});
	};
	globalThis.fetch = async (input, init = {}) => {
		try {
			const url = new URL(String(input.url ?? input));
			assert.equal(init.method, "POST");
			if (url.href === MODEL) {
				assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${MODEL_KEY}`);
				const body = JSON.parse(init.body);
				assert.deepEqual(body.tools ?? [], []);
				const context = JSON.parse(body.input[0].content[0].text);
				assert.ok(report.http.filter((r) => r.kind === "model").length < 20, "Model-call budget");
				if (body.instructions.startsWith("Classify one Slack message")) {
					assert.ok([ACTOR.userId, NEXT_ACTOR.userId].includes(context.actor.userId));
					assert.equal(context.actor.workspaceId, ACTOR.workspaceId);
					assert.equal(context.message.source.workspaceId, ACTOR.workspaceId);
					report.http.push({
						kind: "model",
						purpose: "classifier",
						messageId: context.message.source.messageId,
					});
					const classification =
						context.message.source.messageId === source.ts
							? {
									title: TITLE,
									summary: "Controlled report request requiring bounded context.",
									kind: "request",
									intent: "request_to_actor",
									explicitOwnPromise: false,
									repositoryId: null,
									questions: [],
									priorityReason: "Controlled incoming work request.",
									priorityRank: 50,
									sourceQuote: null,
								}
							: null;
					return modelResponse(body, classification);
				}
				assert.ok(
					body.instructions.startsWith("Identify only missing context"),
					"Unexpected model workload"
				);
				assert.deepEqual(context.policy.actor, ACTOR);
				assert.equal(context.policy.source.messageId, source.ts);
				assert.ok(context.messages.length >= 1 && context.messages.length <= 4);
				assert.ok(context.messages.some((m) => m.text === ORIGINAL && m.authorId === REQUESTER));
				report.http.push({
					kind: "model",
					purpose: "clarification",
					policyId: context.policy.id,
					messageCount: context.messages.length,
					at: Date.now(),
				});
				if (context.policy.scope === holdScope) {
					assert.equal(held, null, "Only one bounded analysis hold");
					await new Promise((done, reject) => {
						const finish = () => {
							clearTimeout(timer);
							init.signal?.removeEventListener("abort", abort);
							done();
						};
						const abort = () => {
							clearTimeout(timer);
							reject(Error("Controlled request cancelled"));
						};
						const timer = setTimeout(
							() => reject(fail(Error("Analysis hold exceeded 14 seconds"))),
							14000
						);
						held = { release: finish, policyId: context.policy.id };
						init.signal?.addEventListener("abort", abort, { once: true });
						if (init.signal?.aborted) abort();
					});
				}
				const hasAnswer = context.messages.some(
					(m) => m.authorId === REQUESTER && m.text === ANSWER
				);
				return modelResponse(
					body,
					hasAnswer
						? { summary: BRIEF, missing: [], questions: [], escalation: null }
						: {
								summary: "The requester has not specified the reporting period/detail.",
								missing: ["Reporting period and detail"],
								questions: [QUESTION],
								escalation: null,
							}
				);
			}
			assert.equal(url.origin, "https://slack.com", "Only fixed official provider origins");
			assert.equal(url.search, "");
			assert.ok(url.pathname.startsWith("/api/"));
			assert.equal(init.redirect, "error");
			const auth = new Headers(init.headers).get("authorization");
			assert.ok([`Bearer ${TOKEN}`, `Bearer ${NEXT_TOKEN}`].includes(auth));
			const requestActor = auth === `Bearer ${TOKEN}` ? ACTOR : NEXT_ACTOR;
			const method = url.pathname.slice(5);
			assert.ok(report.http.length < 700, "Slack HTTP/source budget");
			report.http.push({ kind: "slack", method, at: Date.now() });
			const json = method === "chat.postMessage";
			const fields = json
				? JSON.parse(init.body)
				: Object.fromEntries(new URLSearchParams(init.body));
			const response = (value) =>
				Response.json({ ok: true, ...value }, { headers: { "x-oauth-scopes": SCOPES.join(",") } });
			if (method === "auth.test")
				return response({
					team_id: requestActor.workspaceId,
					user_id: requestActor.userId,
					team: "Controlled clarification workspace",
					user: "controlled-user",
					url: "https://controlled.slack.com/",
				});
			if (method === "users.info") {
				assert.ok([ACTOR.userId, NEXT_ACTOR.userId, REQUESTER].includes(fields.user));
				return response({
					user: {
						id: fields.user,
						team_id: ACTOR.workspaceId,
						name: "controlled-user",
						is_bot: false,
						deleted: false,
						profile: {
							display_name: "Controlled participant",
							real_name: "Controlled participant",
						},
					},
				});
			}
			const channel = {
				id: CHANNEL,
				name: "controlled-clarification",
				is_channel: true,
				is_private: true,
				is_member: member,
			};
			if (method === "users.conversations")
				return response({
					channels: member ? [channel] : [],
					response_metadata: { next_cursor: "" },
				});
			assert.equal(fields.channel, CHANNEL, "One controlled source only");
			if (method === "conversations.info") {
				if (!member) membershipDenials++;
				return response({ channel });
			}
			if (method === "conversations.members")
				return response({
					members: member ? [requestActor.userId, REQUESTER] : [REQUESTER],
					response_metadata: { next_cursor: "" },
				});
			if (method === "chat.postMessage") {
				assert.ok(member && !sourceEdited && requestActor === ACTOR);
				assert.equal(fields.thread_ts, source.ts);
				assert.equal(fields.text, QUESTION, "Delegation never grants an exact final reply");
				assert.equal(report.posts.length, 0, "Bound is one controlled question");
				const durable = record();
				checkPolicy(durable.item);
				assert.equal(durable.item.clarification.status, "active");
				const attempt = durable.outbox.find((r) => r.body === fields.text && r.providerKey);
				assert.ok(
					attempt?.clarification && attempt.status === "uncertain",
					"Durable reservation must precede POST"
				);
				assert.equal(attempt.superseded, false);
				assert.equal(attempt.bodyDigest, digest(fields.text));
				assert.equal(attempt.source.revisionId, source.ts);
				const message = {
					ts: timestamp(),
					thread_ts: source.ts,
					user: ACTOR.userId,
					text: fields.text,
				};
				sent.push(message);
				report.posts.push({
					policyId: durable.item.clarification.policy.id,
					requestId: attempt.requestId,
					bodyDigest: attempt.bodyDigest,
					messageId: message.ts,
					originalThread: source.ts,
					reservedBeforeHTTP: true,
				});
				return response({ channel: CHANNEL, ts: message.ts, message });
			}
			assert.ok(
				["conversations.history", "conversations.replies"].includes(method),
				"Unexpected Slack API"
			);
			assert.ok(!fields.cursor);
			assert.ok(Number(fields.limit) >= 1 && Number(fields.limit) <= 15);
			if (method === "conversations.replies") assert.equal(fields.ts, source.ts);
			// After the privacy check, automatic intake is empty; only the explicit exact-source
			// observation supplies the changed revision to exercise the real immutable reader.
			const exactRead = fields.oldest === source.ts && fields.latest === source.ts;
			if (sourceEdited && exactRead) changedHeadReads++;
			let messages =
				(sourceEnabled || (sourceEdited && exactRead)) && requestActor === ACTOR
					? [
							sourceEdited
								? {
										...source,
										text: "PRIVATE-EDIT-76: changed source request",
										edited: { user: REQUESTER, ts: timestamp() },
									}
								: { ...source, reply_count: sent.length + Number(answered) },
						]
					: [];
			if (method === "conversations.replies" && messages.length)
				messages.push(...sent, ...(answered ? [answer] : []));
			const compare = (a, b) => BigInt(a.replace(".", "")) - BigInt(b.replace(".", ""));
			messages = messages.filter(
				(m) =>
					(!fields.oldest ||
						(fields.inclusive === "true"
							? compare(m.ts, fields.oldest) >= 0
							: compare(m.ts, fields.oldest) > 0)) &&
					(!fields.latest ||
						(fields.inclusive === "true"
							? compare(m.ts, fields.latest) <= 0
							: compare(m.ts, fields.latest) < 0))
			);
			return response({
				messages: messages.slice(0, Number(fields.limit)),
				has_more: false,
				response_metadata: { next_cursor: "" },
			});
		} catch (error) {
			if (error.message === "Controlled request cancelled") throw error;
			throw fail(error);
		}
	};
	const hardStop = setTimeout(() => {
		report.status = "failed";
		report.error = "Hard deadline: profile retained; shutdown did not finish";
		report.retainedProfile = owned;
		save();
		app.exit(1);
	}, 190000);
	const deadline = setTimeout(() => stop(Error("175-second clarification gate deadline")), 175000);
	function stop(error) {
		if (error) fail(error);
		if (stopping) return;
		stopping = true;
		held?.release();
		installAudit();
		app.quit();
	}
	function installAudit() {
		if (auditInstalled) return;
		auditInstalled = true;
		// Registered after main's real disposal/SQLite close; only then reopen durable evidence.
		app.once("will-quit", () => {
			clearTimeout(deadline);
			clearTimeout(hardStop);
			try {
				if (failure) throw failure;
				assert.ok(complete, "App quit before all assertions");
				assert.ok(win.isDestroyed());
				const diagnostics = fs.readFileSync(
					join(profile, "diagnostics/conversation.jsonl"),
					"utf8"
				);
				assert.ok(
					diagnostics
						.split("\n")
						.filter(Boolean)
						.map(JSON.parse)
						.some((row) => row.stage === "shutdown-complete")
				);
				const final = record();
				assert.equal(final.item.clarification.status, "complete");
				assert.equal(final.item.clarification.summary, BRIEF);
				assert.equal(final.outbox.filter((r) => r.status === "delivered").length, 1);
				const receipts = final.item.clarification.attempts;
				assert.equal(receipts.length, 1);
				assert.equal(receipts[0].receipt.source.messageId, report.posts[0].messageId);
				assert.deepEqual(report.blocked, []);
				report.sqliteAfterShutdown = {
					sequence: state().sequence,
					receipt: receipts[0].receipt,
					bodyDigest: receipts[0].bodyDigest,
					inferredBriefDigest: digest(BRIEF),
				};
				report.status = "passed";
			} catch (error) {
				report.status = "failed";
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
			for (const [name, original] of children) childProcess[name] = original;
			syncBuiltinESMExports();
			save();
			console.log(`SLACK_CLARIFICATION_SMOKE_${report.status.toUpperCase()}: ${reportPath}`);
			if (report.status !== "passed") app.exit(1);
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
		await wait("default App and preload", () =>
			js("!!document.querySelector('main[data-session-id]') && !!window.electron?.trpc?.request")
		);
		assert.equal(new URL(win.webContents.getURL()).protocol, "file:");
		await js(frameObserver);
		report.builtRendererSha256 = digest(fs.readFileSync(new URL(win.webContents.getURL())));
		const raw = (type, path, input = {}) =>
			js(`window.electron.trpc.request(${JSON.stringify({ type, path, input: { json: input } })})`);
		const rpc = async (type, path, input = {}) => {
			const result = await raw(type, path, input);
			assert.ok(!result?.error, `${path}: ${JSON.stringify(result?.error)}`);
			return dataOf(result);
		};
		const snapshot = () => rpc("query", "day.snapshot");
		const currentItem = async () => (await snapshot()).items.find((i) => i.id === itemId);
		const click = (selector) =>
			js(
				`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled||!e.getBoundingClientRect().width)throw Error('Missing enabled visible control');e.click();})()`
			);
		const button = (scope, label) =>
			js(
				`(() => {const es=[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].filter(e=>e.textContent.trim()===${JSON.stringify(label)}&&e.getBoundingClientRect().width);if(es.length!==1||es[0].disabled)throw Error('Missing enabled button: '+${JSON.stringify(label)});es[0].click();})()`
			);
		const setField = (selector, value) =>
			js(
				`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing input');const p=e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(String(value))});e.dispatchEvent(new Event('input',{bubbles:true}));})()`
			);
		const openSummary = (label) =>
			js(
				`(() => {const e=[...document.querySelectorAll(${JSON.stringify(`${CLARIFICATION} summary`)})].find(e=>e.textContent===${JSON.stringify(label)});if(!e)throw Error('Missing disclosure');if(!e.parentElement.open)e.click();})()`
			);
		const reload = async () => {
			const loaded = new Promise((done) => win.webContents.once("did-finish-load", done));
			win.webContents.reload();
			await loaded;
			await wait("reloaded default App", () =>
				js("!!document.querySelector('main[data-session-id]') && !!window.electron?.trpc?.request")
			);
		};
		const selectItem = async () => {
			await click('.command-rail button[aria-label^="My day"]');
			await wait("actual source item in sidebar", () =>
				js(
					`[...document.querySelectorAll('.day-queue button.command-item')].some(e=>e.querySelector('.command-item-title')?.textContent===${JSON.stringify(TITLE)})`
				)
			);
			await js(
				`(() => {const e=[...document.querySelectorAll('.day-queue button.command-item')].find(e=>e.querySelector('.command-item-title')?.textContent===${JSON.stringify(TITLE)});e.click();})()`
			);
			await wait("actual selected item", () =>
				js(`document.querySelector('.day-item h1')?.textContent===${JSON.stringify(TITLE)}`)
			);
		};
		const operationFromUI = async (label, kind) => {
			const start = report.ipc.length;
			await button(CLARIFICATION, label);
			const row = await wait(`real ${kind} response`, () =>
				report.ipc
					.slice(start)
					.find((r) => r.path === "day.operate" && r.input.operation.kind === kind && r.finishedAt)
			);
			assert.equal(row.rejected, false, `${kind} rejected`);
			assert.equal(row.itemId, itemId);
			await wait("UI adopted operation revision", () =>
				js(
					`[...document.querySelectorAll('${CLARIFICATION} button')].some(e=>e.textContent==='Inspect current clarification')`
				)
			);
			return row;
		};
		const inspectUI = async () => {
			for (let attempt = 0; attempt < 5; attempt++) {
				if (await js(`!!document.querySelector('${CLARIFICATION} blockquote')`)) return;
				await wait("inspection control", () =>
					js(
						`[...document.querySelectorAll('${CLARIFICATION} button')].some(e=>e.textContent==='Inspect current clarification'&&!e.disabled)`
					)
				);
				const start = report.ipc.length;
				await button(CLARIFICATION, "Inspect current clarification");
				const row = await wait("fresh inspection result", () =>
					report.ipc.slice(start).find((r) => r.path === "day.clarification" && r.finishedAt)
				);
				if (!row.rejected) {
					await wait("fresh source inspection in actual UI", () =>
						js(
							`document.querySelector('${CLARIFICATION} blockquote')?.textContent===${JSON.stringify(ORIGINAL)}`
						)
					);
					return;
				}
				await sleep(1700); // Actual shared Slack pacing; no clock or transport-budget bypass.
			}
			throw Error("Fresh UI inspection exhausted bounded retries");
		};
		const proposeUI = async (scope) => {
			await openSummary("Prepare a new delegation");
			await setField(`${CLARIFICATION} textarea`, scope);
			await setField(`${CLARIFICATION} input[type=number]`, 1);
			await setField(`${CLARIFICATION} label:last-of-type input`, 5);
			for (let attempt = 0; attempt < 5; attempt++) {
				await sleep(1700);
				await wait("proposal form ready", () =>
					js(`!!document.querySelector('${CLARIFICATION} button[type=submit]:not(:disabled)')`)
				);
				const start = report.ipc.length;
				await button(CLARIFICATION, "Review delegation proposal");
				const row = await wait("proposal result", () =>
					report.ipc
						.slice(start)
						.find(
							(r) =>
								r.path === "day.operate" &&
								r.input.operation.kind === "propose_clarification" &&
								r.finishedAt
						)
				);
				if (!row.rejected) {
					await wait("proposal actually displayed", () =>
						js(
							`document.querySelector('${CLARIFICATION} blockquote')?.textContent===${JSON.stringify(ORIGINAL)}`
						)
					);
					checkPolicy(record().item);
					assert.equal(record().item.clarification.status, "proposed");
					return;
				}
			}
			throw Error("Proposal exhausted bounded pacing retries");
		};

		assert.equal((await rpc("query", "app.config")).envPath, envPath);
		assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
		assert.deepEqual((await snapshot()).items, []);
		assert.equal((await rpc("query", "hub.snapshot")).jobs.length, 0);
		assert.equal(await js("document.querySelector('#conversation-panel')?.hidden"), true);
		writeConfig(TOKEN);
		await click('.command-rail button[aria-label="Settings"]');
		await wait("Settings", () => js("document.querySelector('#configuration')?.open"));
		await js(
			`(() => {const e=[...document.querySelectorAll('${SLACK_SETTINGS} summary')].find(e=>e.textContent==='Developer connection methods');if(!e)throw Error('Missing developer import');e.click();})()`
		);
		await button(SLACK_SETTINGS, "Import .env Slack user token");
		await wait("real verified source actor", async () => {
			const status = await rpc("query", "slack.status");
			return (
				status.phase === "connected" &&
				status.account?.userId === ACTOR.userId &&
				status.membershipSync?.phase === "complete"
			);
		});
		assert.deepEqual((await snapshot()).actor, ACTOR);
		assert.deepEqual((await snapshot()).items, []);
		sourceEnabled = true;
		await click('#configuration button[aria-label="Close settings"]');
		const captured = await wait(
			"real SlackWorkspace classifier and Day capture",
			async () => {
				const s = await snapshot();
				return s.items.find((i) => i.source?.source.messageId === source.ts);
			},
			25000
		);
		itemId = captured.id;
		assert.equal(captured.requestedById, REQUESTER);
		assert.equal(captured.acceptance, "pending");
		assert.equal(captured.jobId, null);
		assert.equal(captured.source.source.revisionId, source.ts);
		await wait("durable source classification and capture checkpoint", () =>
			sql((db) =>
				db
					.prepare("SELECT data_json FROM slack_workspace_sources")
					.all()
					.map((r) => JSON.parse(r.data_json))
					.some(
						(r) =>
							r.source.messageId === source.ts && r.dayApplied && r.decision?.kind === "request"
					)
			)
		);
		assert.ok(report.http.some((r) => r.purpose === "classifier" && r.messageId === source.ts));
		assert.ok(!report.ipc.some((r) => r.input?.operation?.kind === "capture_manual"));
		report.checks.push(
			"empty startup; actual manual credential verification, bounded Slack intake, Muse JSON classifier and durable Day capture, no injected capture"
		);
		await selectItem();
		const display = await wait("accepted source-item display receipt", () =>
			report.ipc.find(
				(row) =>
					row.path === "workspace.applied" &&
					row.status === "accepted" &&
					row.input.workspace.canvases.some(
						(c) =>
							c.id === row.input.workspace.primaryId &&
							c.section === "day" &&
							c.selectedId === itemId
					)
			)
		);
		displayedReceipt(display, itemId);
		report.actualBuiltApp = true;
		report.actualPreloadIPC = true;
		report.checks.push(
			"actual Day selection committed exact title/item and two app animation frames before positive workspace receipt"
		);
		const noDraft = await raw("mutation", "day.operate", {
			requestId: randomUUID(),
			operation: {
				kind: "send_reply",
				itemId,
				expectedRevision: (await currentItem()).revision,
				draftRevision: 1,
				body: "This final reply has no exact draft or consent.",
			},
		});
		assert.ok(noDraft.error);
		assert.equal(report.posts.length, 0);
		await proposeUI(`${SCOPE} Pause probe.`);
		assert.equal(report.posts.length, 0);
		// Hold only an actual model HTTP response; the real main supervisor remains the actor.
		for (const [suffix, label, kind, status] of [
			["Pause probe.", "Pause clarification", "pause_clarification", "paused"],
			["Revoke probe.", "Revoke delegation", "revoke_clarification", "revoked"],
		]) {
			if (status === "revoked") await proposeUI(`${SCOPE} ${suffix}`);
			holdScope = `${SCOPE} ${suffix}`;
			held = null;
			const confirmation = await operationFromUI(
				"Authorize this clarification delegation",
				"confirm_clarification"
			);
			checkPolicy(record().item);
			const c = record().item.clarification;
			report.confirmations ??= [];
			report.confirmations.push({
				policyId: c.policy.id,
				confirmedAt: c.confirmedAt,
				expiresAt: c.expiresAt,
				durationMinutes: c.policy.durationMinutes,
				ipcStartedAt: confirmation.at,
				ipcFinishedAt: confirmation.finishedAt,
			});
			const confirmedAt = Date.parse(c.confirmedAt);
			assert.ok(
				confirmedAt >= confirmation.at && confirmedAt <= confirmation.finishedAt,
				"Confirmation must be captured during the actual IPC operation"
			);
			await wait("actual model analysis in flight", () => held);
			await inspectUI();
			await operationFromUI(label, kind);
			assert.equal(record().item.clarification.status, status);
			const revision = record().item.clarification.policy.revision;
			holdScope = null;
			held.release();
			await sleep(2300);
			assert.equal(record().item.clarification.status, status);
			assert.equal(record().item.clarification.policy.revision, revision);
			assert.equal(report.posts.length, 0, "Late model result crossed pause/revoke fence");
			report.checks.push(`actual UI ${status} fences in-flight model HTTP; no controlled POST`);
		}
		await proposeUI(SCOPE);
		const oldPolicy = record().item.clarification.policy;
		const stale = await raw("mutation", "day.operate", {
			requestId: randomUUID(),
			operation: {
				kind: "confirm_clarification",
				itemId,
				expectedRevision: (await currentItem()).revision - 1,
				policyId: oldPolicy.id,
				policyRevision: oldPolicy.revision,
			},
		});
		assert.ok(stale.error, "Stale item revision granted delegation");
		assert.equal(report.posts.length, 0);
		await operationFromUI("Authorize this clarification delegation", "confirm_clarification");
		checkPolicy(record().item);
		const delivered = await wait(
			"actual controlled Slack receipt persisted",
			() => {
				const r = record();
				return r.outbox.some((o) => o.status === "delivered") && r;
			},
			25000
		);
		checkPolicy(delivered.item);
		assert.equal(report.posts.length, 1);
		assert.equal(delivered.item.clarification.attempts.length, 1);
		const attempt = delivered.item.clarification.attempts[0];
		assert.equal(attempt.body, QUESTION);
		assert.equal(attempt.status, "delivered");
		assert.equal(attempt.receipt.requestId, attempt.requestId);
		assert.equal(attempt.receipt.source.threadId, source.ts);
		assert.equal(attempt.receipt.bodyDigest, digest(QUESTION));
		assert.equal(attempt.receipt.source.messageId, report.posts[0].messageId);
		answer = { ts: timestamp(), thread_ts: source.ts, user: REQUESTER, text: ANSWER };
		answered = true;
		await wait(
			"actual requester answer yields inferred brief",
			() => record().item.clarification.status === "complete",
			25000
		);
		assert.equal(record().item.clarification.summary, BRIEF);
		assert.ok(
			record().item.clarification.evidence.some(
				(m) => m.authorId === REQUESTER && m.text === ANSWER
			)
		);
		checkPolicy(record().item);
		assert.equal(report.posts.length, 1);
		report.checks.push(
			"exact captured confirmation+5 minutes on real clock; stale revision denied; one bounded original-thread POST, actual SlackClient receipt and requester-attributed inferred brief; no final reply/ownership/job/closure"
		);

		await reload();
		await selectItem();
		for (let n = 0; n < 3; n++) metadataOnly(await snapshot());
		assert.ok(
			!(await js(`document.querySelector('${CLARIFICATION}')?.innerText ?? ''`)).includes(BRIEF)
		);
		await sleep(1700);
		await inspectUI();
		assert.ok(
			(await js(`document.querySelector('${CLARIFICATION}')?.innerText ?? ''`)).includes(BRIEF)
		);
		const exact = await currentItem();
		member = false;
		await reload(); // Retire renderer's already-authorized inspection; do not edit its store or DOM.
		await selectItem();
		for (let n = 0; n < 3; n++) metadataOnly(await snapshot());
		const deniedStart = report.ipc.length;
		const deniedReadsBefore = membershipDenials;
		await button(CLARIFICATION, "Inspect current clarification");
		await wait("fresh membership denial over real IPC", () =>
			report.ipc
				.slice(deniedStart)
				.some((r) => r.path === "day.clarification" && r.finishedAt && r.rejected)
		);
		await wait("honest UI inspection denial", () =>
			js(
				`document.querySelector('${CLARIFICATION} [role=alert]')?.textContent.includes('could not be authorized')`
			)
		);
		assert.ok(
			membershipDenials > deniedReadsBefore,
			"Inspection denial must reach fresh provider membership"
		);
		const privateUI = await js(`document.querySelector('${CLARIFICATION}')?.innerText ?? ''`);
		for (const value of [ORIGINAL, ANSWER, QUESTION, BRIEF]) assert.ok(!privateUI.includes(value));
		assert.equal(
			record().item.clarification.summary,
			BRIEF,
			"Denied inspection must retain private durable evidence"
		);
		report.checks.push(
			"renderer reload restores metadata only; explicit fresh inspection reveals brief, changed membership denies a new UI read without erasing stored result"
		);
		member = true;
		sourceEnabled = false;
		sourceEdited = true;
		await sleep(1700);
		const edited = await raw("query", "day.clarification", {
			itemId,
			expectedRevision: exact.revision,
		});
		assert.ok(edited.error, "Changed actual source head/revision exposed cached original thread");
		assert.ok(
			changedHeadReads > 0,
			"Head denial must observe the actual changed provider revision, not only throttling"
		);
		assert.equal(report.posts.length, 1);
		// Change only the owned test configuration; actual import retires the old Day actor.
		writeConfig(NEXT_TOKEN);
		await click('.command-rail button[aria-label="Settings"]');
		await wait("Settings account import", () =>
			js("document.querySelector('#configuration')?.open")
		);
		await js(
			`(() => {const e=[...document.querySelectorAll('${SLACK_SETTINGS} summary')].find(e=>e.textContent==='Developer connection methods');if(!e.parentElement.open)e.click();})()`
		);
		await button(SLACK_SETTINGS, "Import .env Slack user token");
		await wait(
			"different verified actor",
			async () => (await snapshot()).actor.userId === NEXT_ACTOR.userId
		);
		assert.deepEqual((await snapshot()).items, []);
		const wrongActor = await raw("query", "day.clarification", {
			itemId,
			expectedRevision: exact.revision,
		});
		assert.ok(wrongActor.error, "Other account accessed private clarification");
		assert.equal(record().item.clarification.summary, BRIEF);
		assert.equal((await rpc("query", "hub.snapshot")).jobs.length, 0);
		assert.equal(report.posts.length, 1);
		assert.equal(win.contentView.children.length, 0);
		assert.deepEqual(report.blocked, []);
		report.checks.push(
			"changed actual source revision and separately imported account both deny old inspection; original private SQLite outcome retained; no worker/browser surface/live calls"
		);
		complete = true;
		stop();
	} catch (error) {
		stop(error);
	}
}
if (require.main === module || process.versions.electron)
	native().catch((error) => {
		console.error(
			`SLACK_CLARIFICATION_SMOKE_FAILED: ${String(error.message).split(MODEL_KEY).join("[CONTROLLED]")}`
		);
		process.exitCode = 1;
	});
