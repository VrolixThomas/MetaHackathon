// ROOT ONLY, after building the integrated default App (from apps/desktop):
// env -u ELECTRON_RUN_AS_NODE electron src/main/slack-oauth-smoke.cjs [out/main/index.js]
// AUTHOR ONLY: node --check this-file; node this-file --self-check. No native imports in self-check.
// Requires root's Slack OAuth, all-joined coordinator/RPC/Settings and source profile-label bindings.
// Production callback must be http://localhost:43187/oauth/slack/callback;
// no callbackPort injection. Existing oauth.{status,start,cancel,disconnect} and slack.{status,
// conversations,follow} run through the actual preload/router. Source status must independently
// confirm all_joined + membershipSync.complete + all three conversations before any list/save click.
// Advanced 'Conversations and exclusions' / 'Show conversations' / 'Save exclusions' excludes one.
// Labels must come from actual conversation/profile responses, never raw-ID or invented DM names.
// Only fixed-origin provider transport and shell.openExternal are controlled. No successful RPC
// replacement, seeded connection, live consent, worker, model, source-ingestion or speech claim.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const childProcess = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const { syncBuiltinESMExports } = require("node:module");
const { tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { parseEnv } = require("node:util");

const PORT = 43187;
const CALLBACK = `http://localhost:${PORT}/oauth/slack/callback`;
const AUTHORIZE = "https://slack.com/oauth/v2/authorize";
const TOKEN = "https://slack.com/api/oauth.v2.access";
const CLIENT = "slack-oauth-smoke-controlled-client";
const ACCESS = "xoxp-slack-oauth-smoke-controlled-not-a-live-token";
const ACTOR = { workspaceId: "T66001", userId: "U66001" };
const PROFILE = {
	id: ACTOR.userId,
	displayName: "Controlled Slack Viewer",
	login: "controlled-viewer",
};
const DM_PROFILE = {
	id: "U66002",
	displayName: "Controlled Slack Teammate",
	login: "controlled-teammate",
};
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
const CHANNELS = [
	{ id: "C66001", name: "controlled-selected-channel", is_channel: true, is_private: false },
	{ id: "D66001", user: DM_PROFILE.id, is_im: true },
	{ id: "C66002", name: "controlled-excluded-channel", is_channel: true, is_private: false },
];
const JOINED = CHANNELS.map((row) => row.id);
const EXCLUDED = [CHANNELS[2].id];
const hash = (value) => createHash("sha256").update(value).digest("base64url");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const rowScope = '#configuration [data-oauth-provider="slack"]';
const sourceScope = '#configuration section[aria-label="Slack connection"]';

function assertFollowing(row, excluded = []) {
	assert.equal(row.phase, "connected");
	assert.equal(row.error, null);
	assert.equal(row.followMode, "all_joined");
	assert.equal(row.membershipSync?.phase, "complete");
	assert.equal(row.membershipSync.discoveredCount, JOINED.length);
	assert.ok(
		Number.isFinite(Date.parse(row.membershipSync.completedAt)),
		"Completed discovery needs a timestamp"
	);
	assert.deepEqual([...row.excludedConversationIds].sort(), [...excluded].sort());
	assert.deepEqual([...row.watching].sort(), JOINED.filter((id) => !excluded.includes(id)).sort());
}
function assertConversationLabels(items, labels) {
	assert.deepEqual(items.map((row) => row.id).sort(), [...JOINED].sort());
	const expected = items.map((row) => {
		assert.equal(row.workspaceId, ACTOR.workspaceId);
		const source = CHANNELS.find((channel) => channel.id === row.id);
		assert.equal(row.name, source.is_im ? DM_PROFILE.displayName : source.name);
		assert.equal(row.visibility, source.is_im ? "direct_message" : "public_channel");
		return `${row.name} · ${row.visibility.replaceAll("_", " ")}`;
	});
	assert.deepEqual([...labels].sort(), expected.sort());
	for (const label of labels)
		for (const id of [...JOINED, ACTOR.userId, DM_PROFILE.id])
			assert.ok(!label.includes(id), "Conversation label must not fall back to a raw source ID");
}
function scrubEnvironment(env) {
	for (const key of Object.keys(env))
		if (
			/^(?:GITHUB_|GH_|LINEAR_|SLACK_|MODEL_|META_|ELEVENLABS_|OPENAI_|ANTHROPIC_|AZURE_OPENAI_|VITE_|METAHACKATHON_)/.test(
				key
			)
		)
			delete env[key];
}
function publicSafe(value, markers) {
	const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
	for (const marker of markers)
		assert.ok(!text.includes(marker), "Private controlled material escaped to metadata/UI/disk");
	if (value && typeof value === "object")
		for (const [key, nested] of Object.entries(value)) {
			assert.ok(
				!/^(?:access_?token|refresh_?token|client_?secret|code_?verifier)$/i.test(key),
				"Private field escaped through IPC"
			);
			if (nested && typeof nested === "object") publicSafe(nested, markers);
		}
}
function authorization(address) {
	const url = new URL(address);
	assert.equal(`${url.origin}${url.pathname}`, AUTHORIZE);
	assert.equal(url.searchParams.get("client_id"), CLIENT);
	assert.equal(url.searchParams.get("redirect_uri"), CALLBACK);
	assert.equal(url.searchParams.get("code_challenge_method"), "S256");
	for (const key of ["state", "code_challenge"])
		assert.match(url.searchParams.get(key) ?? "", /^[A-Za-z0-9_-]{43}$/);
	assert.deepEqual([...url.searchParams.get("user_scope").split(",")].sort(), [...SCOPES].sort());
	assert.deepEqual(
		[...url.searchParams.keys()].sort(),
		[
			"client_id",
			"redirect_uri",
			"state",
			"user_scope",
			"code_challenge",
			"code_challenge_method",
		].sort()
	);
	return {
		state: url.searchParams.get("state"),
		challenge: url.searchParams.get("code_challenge"),
	};
}
function tokenForm(options, flow) {
	assert.equal(options.method, "POST");
	assert.equal(options.redirect, "error");
	const headers = new Headers(options.headers);
	assert.equal(
		headers.get("authorization"),
		null,
		"Slack PKCE must not need Basic/client-secret auth"
	);
	assert.equal(headers.get("content-type"), "application/x-www-form-urlencoded");
	assert.equal(headers.get("accept"), "application/json");
	assert.equal(typeof options.body, "string");
	const form = new URLSearchParams(options.body);
	assert.deepEqual(
		[...form.keys()].sort(),
		["client_id", "grant_type", "code", "redirect_uri", "code_verifier"].sort()
	);
	assert.equal(form.get("client_id"), CLIENT);
	assert.equal(form.get("grant_type"), "authorization_code");
	assert.equal(form.get("redirect_uri"), CALLBACK);
	assert.ok(flow && form.get("code") === flow.code, "Exchange code must come from actual callback");
	assert.match(form.get("code_verifier") ?? "", /^[A-Za-z0-9_-]{43}$/);
	assert.ok(
		hash(form.get("code_verifier")) === flow.challenge,
		"PKCE verifier must match the opened URL"
	);
}
function callbackOnly(url) {
	return (
		url.origin === `http://localhost:${PORT}` &&
		!url.username &&
		!url.password &&
		url.pathname === "/oauth/slack/callback"
	);
}
function localURL(address) {
	try {
		return ["file:", "data:", "blob:", "about:", "devtools:"].includes(new URL(address).protocol);
	} catch {
		return false;
	}
}
async function portOpen() {
	const probes = await Promise.all(
		["127.0.0.1", "::1"].map(
			(host) =>
				new Promise((done, reject) => {
					const socket = net.createConnection({ host, port: PORT });
					const finish = (value) => {
						socket.destroy();
						done(value);
					};
					socket.setTimeout(750, () => {
						socket.destroy();
						reject(new Error("Callback port probe timed out"));
					});
					socket.once("connect", () => finish(true));
					socket.once("error", (error) => {
						if (
							["ECONNREFUSED", "EAFNOSUPPORT", "EADDRNOTAVAIL", "ENETUNREACH"].includes(error.code)
						)
							finish(false);
						else reject(error);
					});
				})
		)
	);
	return probes.some(Boolean);
}

async function native() {
	assert.ok(
		process.versions.electron,
		"Root must launch with Electron; author may run --self-check only"
	);
	assert.ok(!process.env.ELECTRON_RENDERER_URL, "Built default App required");
	const builtMain = resolve(process.argv[2] ?? join(__dirname, "../../out/main/index.js"));
	assert.ok(fs.existsSync(builtMain), "Root must build the integrated default App first");
	const { app, BrowserWindow, ipcMain, shell, safeStorage } = require("electron");
	const owned = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "met-slack-oauth-smoke-")));
	const owner = randomUUID();
	const ownerPath = join(owned, ".owner");
	const profile = join(owned, "profile");
	const envPath = join(owned, ".env");
	const storePath = join(profile, "oauth/oauth.sessions.encrypted.json");
	fs.writeFileSync(ownerPath, owner, { mode: 0o600 });
	fs.mkdirSync(profile, { mode: 0o700 });
	fs.writeFileSync(envPath, `SLACK_OAUTH_CLIENT_ID=${CLIENT}\n`, { mode: 0o600 });
	scrubEnvironment(process.env);
	process.env.METAHACKATHON_ENV_FILE = envPath;
	app.setPath("userData", profile);
	const reportPath = join(__dirname, "../../out/slack-oauth-smoke-report.json");
	const screenshotPath = join(dirname(reportPath), "slack-oauth-controlled-settings.png");
	fs.mkdirSync(dirname(reportPath), { recursive: true });
	const report = {
		status: "running",
		controlledProviderInputs: true,
		liveConsent: false,
		liveSpeech: false,
		physicalMicrophone: false,
		sourceIngestion: false,
		workerExecution: false,
		processRestart: false,
		builtMain,
		builtMainSha256: hash(fs.readFileSync(builtMain)),
		checks: [],
		rpc: [],
		reads: [],
		tokenPosts: 0,
		blocked: [],
	};
	const markers = new Set([ACCESS]);
	const redact = (value) => {
		let text = String(value);
		for (const marker of markers) text = text.split(marker).join("[CONTROLLED-PRIVATE]");
		return text;
	};
	const save = () => fs.writeFileSync(reportPath, `${redact(JSON.stringify(report, null, 2))}\n`);
	let failure;
	let win;
	let complete = false;
	let stopping = false;
	let auditInstalled = false;
	const fail = (error) => {
		failure ??= error;
		return error;
	};
	const forbid = (kind) => {
		report.blocked.push(kind);
		throw fail(new Error(`Slack smoke forbids ${kind}`));
	};
	async function wait(label, read, timeout = 12000) {
		const until = Date.now() + timeout;
		while (Date.now() < until) {
			if (failure) throw failure;
			const value = await read();
			if (value) return value;
			await sleep(40);
		}
		throw new Error(`Timed out: ${label}`);
	}
	function stop(error) {
		if (error) fail(error);
		if (stopping) return;
		stopping = true;
		installAudit();
		app.quit();
	}
	const original = {
		fetch: globalThis.fetch,
		open: shell.openExternal,
		handle: ipcMain.handle,
		WebSocket: globalThis.WebSocket,
	};
	const children = new Map();
	const flows = [];
	let exclusionsApplied = false;
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
		childProcess[name] = () => forbid(`child process ${name}`);
	}
	syncBuiltinESMExports();
	globalThis.WebSocket = class {
		constructor() {
			forbid("WebSocket");
		}
	};
	shell.openExternal = async (address) => {
		try {
			const flow = authorization(address);
			assert.ok(!flows.some((old) => old.state === flow.state), "Login state must be fresh");
			flow.code = `controlled-code-${randomUUID()}`;
			markers.add(flow.state);
			markers.add(flow.code);
			flows.push(flow);
		} catch (error) {
			throw fail(error);
		}
	};
	app.on("browser-window-created", (_event, window) => {
		window.setIgnoreMouseEvents(true);
		window.setFocusable(false);
	});
	app.on("web-contents-created", (_event, contents) => {
		contents.session.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, done) => {
			const allowed = localURL(details.url);
			if (!allowed) {
				report.blocked.push("Chromium network");
				fail(new Error("Unexpected Chromium network request"));
			}
			done({ cancel: !allowed });
		});
	});
	ipcMain.handle = function (channel, handler) {
		if (channel !== "trpc:request") return original.handle.call(this, channel, handler);
		report.actualPreloadIPC = true;
		return original.handle.call(this, channel, async (sender, request) => {
			try {
				// Default App checks/prepares unconfigured voice on startup; no capture or media turn.
				if (
					(request.path.startsWith("voice.") &&
						!["voice.status", "voice.prepare", "voice.release", "voice.cancel"].includes(
							request.path
						)) ||
					[
						"agent.start",
						"conversation.start",
						"conversation.attend",
						"runtime.githubSignIn",
						"app.requestMicrophone",
						"slack.connect",
						"slack.watch",
					].includes(request.path)
				)
					forbid(`RPC ${request.path}`);
				if (request.path === "hub.operate" && request.input?.json?.operation?.kind !== "refresh")
					forbid("worker/provider operation");
				if (request.path === "slack.follow")
					assert.deepEqual(request.input?.json, {
						mode: "all_joined",
						excludedConversationIds: EXCLUDED,
					});
				const result = await handler(sender, request); // Observe only; never supply success.
				publicSafe(result, markers);
				if (request.path === "slack.follow" && !result.error) exclusionsApplied = true;
				if (
					[
						"oauth.start",
						"oauth.cancel",
						"oauth.disconnect",
						"slack.follow",
						"slack.conversations",
					].includes(request.path)
				)
					report.rpc.push({
						path: request.path,
						provider: request.input?.json?.provider,
						input: request.path === "slack.follow" ? request.input?.json : undefined,
						items:
							request.path === "slack.conversations" ? result.result?.data?.json?.items : undefined,
						rejected: !!result.error,
					});
				return result;
			} catch (error) {
				throw fail(error);
			}
		});
	};
	globalThis.fetch = async (input, options = {}) => {
		try {
			const url = new URL(String(input.url ?? input));
			if (callbackOnly(url))
				return original.fetch(input, {
					...options,
					redirect: "error",
					signal: AbortSignal.timeout(2500),
				});
			if (url.href === TOKEN) {
				const form = new URLSearchParams(options.body);
				for (const key of ["code", "code_verifier"]) if (form.get(key)) markers.add(form.get(key));
				tokenForm(options, flows.at(-1));
				assert.equal(++report.tokenPosts, 1, "Only one actual callback may exchange a code");
				return Response.json({
					ok: true,
					app_id: "A66001",
					team: { id: ACTOR.workspaceId, name: "Controlled workspace" },
					authed_user: {
						id: ACTOR.userId,
						token_type: "user",
						scope: SCOPES.join(","),
						access_token: ACCESS,
					},
				});
			}
			assert.equal(url.origin, "https://slack.com", "Only fixed-origin Slack API inputs allowed");
			assert.equal(url.search, "");
			assert.equal(options.method, "POST");
			assert.equal(options.redirect, "error");
			assert.ok(
				new Headers(options.headers).get("authorization") === `Bearer ${ACCESS}`,
				"Slack source must use the actual OAuth user grant"
			);
			const headers = new Headers(options.headers);
			const method = url.pathname.slice("/api/".length);
			assert.equal(url.pathname, `/api/${method}`);
			assert.equal(
				headers.get("content-type"),
				"application/x-www-form-urlencoded",
				"Slack read APIs must receive their actual form arguments"
			);
			const fields = Object.fromEntries(new URLSearchParams(options.body));
			report.reads.push({ method, conversationId: fields.channel ?? null });
			const response = (body) =>
				Response.json({ ok: true, ...body }, { headers: { "x-oauth-scopes": SCOPES.join(",") } });
			if (method === "auth.test")
				return response({
					team_id: ACTOR.workspaceId,
					user_id: ACTOR.userId,
					team: "Controlled workspace",
					user: PROFILE.login,
					url: "https://controlled.slack.com/",
				});
			if (method === "users.info") {
				const person = [PROFILE, DM_PROFILE].find((row) => row.id === fields.user);
				assert.ok(person, "Only controlled account/DM profiles may be read");
				return response({
					user: {
						id: person.id,
						team_id: ACTOR.workspaceId,
						name: person.login,
						is_bot: false,
						deleted: false,
						profile: { display_name: person.displayName, real_name: person.displayName },
					},
				});
			}
			if (method === "users.conversations")
				return response({ channels: CHANNELS, response_metadata: { next_cursor: "" } });
			assert.ok(JOINED.includes(fields.channel), "Only controlled joined conversations may be read");
			if (method === "conversations.info")
				return response({ channel: CHANNELS.find((row) => row.id === fields.channel) });
			if (method === "conversations.members")
				return response({
					members: [ACTOR.userId, "U66002"],
					response_metadata: { next_cursor: "" },
				});
			if (method === "conversations.history") {
				assert.ok(
					!exclusionsApplied || !EXCLUDED.includes(fields.channel),
					"Excluded conversation history must stop after actual follow acknowledgement"
				);
				return response({ messages: [], has_more: false, response_metadata: { next_cursor: "" } });
			}
			return forbid("unexpected Slack API method");
		} catch (error) {
			throw fail(error);
		}
	};
	const hardStop = setTimeout(() => {
		report.status = "failed";
		report.error =
			"119-second hard deadline; owned profile retained because shutdown did not finish";
		report.retainedProfile = owned;
		save();
		app.exit(1);
	}, 119000);
	const deadline = setTimeout(() => stop(new Error("105-second Slack OAuth deadline")), 105000);
	function installAudit() {
		if (auditInstalled) return;
		auditInstalled = true;
		// Install after actual main so its disposal/SQLite-close handlers run before this audit.
		app.once("will-quit", (event) => {
			event.preventDefault();
			clearTimeout(deadline);
			void (async () => {
				try {
					if (failure) throw failure;
					assert.ok(complete, "App quit before acceptance completed");
					assert.ok(!win || win.isDestroyed(), "Owned window survived shutdown");
					assert.equal(await portOpen(), false, "Pending Slack callback listener survived quit");
					const diagnostics = fs.readFileSync(
						join(profile, "diagnostics/conversation.jsonl"),
						"utf8"
					);
					publicSafe(diagnostics, markers);
					assert.ok(
						diagnostics
							.split("\n")
							.filter(Boolean)
							.map(JSON.parse)
							.some((row) => row.stage === "shutdown-complete")
					);
					assert.deepEqual(report.blocked, []);
					report.checks.push(
						"actual app shutdown closes pending callback; shutdown-complete observed; no SQLite import by harness"
					);
					report.status = "passed";
				} catch (error) {
					report.status = "failed";
					report.error = redact(error.message);
				} finally {
					try {
						assert.equal(fs.realpathSync(owned), owned);
						assert.equal(fs.lstatSync(owned).isSymbolicLink(), false);
						assert.equal(fs.readFileSync(ownerPath, "utf8"), owner, "Refusing unowned cleanup");
						fs.rmSync(owned, { recursive: true, maxRetries: 3, retryDelay: 50 });
						report.ownedTempRemoved = !fs.existsSync(owned);
					} catch (error) {
						report.status = "failed";
						report.error = redact(error.message);
					}
					globalThis.fetch = original.fetch;
					globalThis.WebSocket = original.WebSocket;
					shell.openExternal = original.open;
					ipcMain.handle = original.handle;
					for (const [name, value] of children) childProcess[name] = value;
					syncBuiltinESMExports();
					save();
					clearTimeout(hardStop);
					console.log(`SLACK_OAUTH_SMOKE_${report.status.toUpperCase()}: ${reportPath}`);
					app.exit(report.status === "passed" ? 0 : 1);
				}
			})();
		});
	}
	try {
		assert.equal(await portOpen(), false, "Fixed callback port occupied; do not touch its owner");
		await import(pathToFileURL(builtMain).href);
		installAudit();
		await app.whenReady();
		assert.ok(safeStorage.isEncryptionAvailable(), "Actual OS encryption required");
		assert.notEqual(safeStorage.getSelectedStorageBackend?.(), "basic_text");
		win = await wait("default built App window", () => BrowserWindow.getAllWindows()[0]);
		await wait("built renderer", () => !win.webContents.isLoadingMainFrame());
		assert.equal(new URL(win.webContents.getURL()).protocol, "file:");
		const js = (code) => win.webContents.executeJavaScript(code);
		const rpc = async (path) => {
			const result = await js(
				`window.electron.trpc.request(${JSON.stringify({ type: "query", path, input: { json: {} } })})`
			);
			assert.ok(!result.error, `${path} failed`);
			return result.result.data.json;
		};
		const statuses = () => rpc("oauth.status");
		const slack = async () => (await statuses()).find((row) => row.provider === "slack");
		const others = async () => (await statuses()).filter((row) => row.provider !== "slack");
		const click = async (selector) => {
			await wait(`visible enabled ${selector}`, () =>
				js(
					`(() => {const e=document.querySelector(${JSON.stringify(selector)});return !!e&&!e.disabled&&e.getBoundingClientRect().width>0;})()`
				)
			);
			await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
		};
		const action = (kind) => `${rowScope} [data-testid="oauth-slack-${kind}"]`;
		const buttonText = async (scope, text) => {
			await wait(`button ${text}`, () =>
				js(
					`(() => {const e=[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e||e.disabled||!e.getBoundingClientRect().width)return false;e.click();return true;})()`
				)
			);
		};
		const uiSafe = async () => publicSafe(await js("document.documentElement.outerHTML"), markers);
		const envOnly = () => {
			assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
			const env = parseEnv(fs.readFileSync(envPath, "utf8"));
			assert.equal(env.SLACK_OAUTH_CLIENT_ID, CLIENT);
			assert.deepEqual(
				Object.entries(env).filter(([, value]) => value !== ""),
				[["SLACK_OAUTH_CLIENT_ID", CLIENT]]
			);
		};
		const envelope = () => {
			assert.equal(fs.lstatSync(storePath).isSymbolicLink(), false);
			assert.equal(fs.statSync(storePath).mode & 0o777, 0o600);
			assert.equal(fs.statSync(dirname(storePath)).mode & 0o777, 0o700);
			const raw = fs.readFileSync(storePath, "utf8");
			publicSafe(raw, markers);
			const value = JSON.parse(raw);
			assert.equal(value.version, 1);
			return value;
		};
		const begin = async () => {
			const previous = flows.length;
			await click(action("connect"));
			const flow = await wait(
				"actual external Slack authorization URL",
				() => flows.length === previous + 1 && flows.at(-1)
			);
			await wait("actual main connecting", async () => (await slack()).phase === "connecting");
			assert.equal(await portOpen(), true);
			return flow;
		};
		await wait("default App", () =>
			js(
				"!!document.querySelector('main[data-session-id]')&&!!document.querySelector('.command-rail')&&!!window.electron?.trpc?.request"
			)
		);
		report.actualBuiltApp = true;
		assert.equal((await rpc("app.config")).envPath, envPath);
		envOnly();
		const baseline = await others();
		assert.deepEqual(baseline.map((row) => row.provider).sort(), ["github", "linear"]);
		for (const row of baseline) {
			assert.equal(row.phase, "disconnected");
			assert.equal(row.account, null);
			assert.equal(row.source, null);
		}
		assert.equal((await slack()).configurationReady, true);
		assert.equal((await slack()).callbackUrl, CALLBACK);
		assert.equal((await slack()).phase, "disconnected");
		assert.equal(fs.existsSync(storePath), false);
		await click('.command-rail button[aria-label="Settings"]');
		await wait("actual Settings", () => js("document.querySelector('#configuration')?.open"));
		await wait("Sign in with Slack", () =>
			js(
				`document.querySelector(${JSON.stringify(action("connect"))})?.textContent.trim()==='Sign in with Slack'`
			)
		);
		await begin();
		await click(action("cancel"));
		await wait(
			"cancelled callback closes",
			async () => (await slack()).phase !== "connecting" && !(await portOpen())
		);
		assert.equal((await slack()).source, null);
		assert.equal(report.tokenPosts, 0);
		assert.deepEqual(await others(), baseline);
		report.checks.push(
			"actual UI Sign in/Cancel; localhost listener closes without token exchange; other providers unchanged"
		);
		const flow = await begin();
		for (const [state, expected] of [
			["x".repeat(43), 400],
			[flow.state, 200],
		]) {
			const response = await globalThis.fetch(
				`${CALLBACK}?${new URLSearchParams({ code: flow.code, state })}`
			);
			assert.equal(response.status, expected);
			assert.equal(response.headers.get("cache-control"), "no-store");
			assert.equal(response.headers.get("referrer-policy"), "no-referrer");
			assert.ok(response.headers.get("content-security-policy")?.includes("default-src 'none'"));
			publicSafe(await response.text(), markers);
			if (expected === 400) {
				assert.equal(report.tokenPosts, 0);
				assert.equal((await slack()).phase, "connecting");
			}
		}
		const connected = await wait("actual verified OAuth account", async () => {
			const row = await slack();
			return row.phase === "connected" && row.source === "oauth" && row;
		});
		assert.equal(connected.account.id, ACTOR.userId);
		assert.equal(connected.account.displayName, PROFILE.displayName);
		const followed = await wait(
			"automatic all-joined discovery for the connected source actor",
			async () => {
				const row = await rpc("slack.status");
				return (
					row.phase === "connected" &&
					row.account?.workspaceId === ACTOR.workspaceId &&
					row.account?.userId === ACTOR.userId &&
					row.followMode === "all_joined" &&
					row.membershipSync?.phase === "complete" &&
					row
				);
			}
		);
		assertFollowing(followed);
		assert.ok(
			!report.rpc.some((row) => ["slack.follow", "slack.conversations"].includes(row.path)),
			"All joined conversations must be followed before any conversation-list or save action"
		);
		assert.ok(report.reads.some((row) => row.method === "users.conversations"));
		await wait("connected OAuth UI", () =>
			js(
				`document.querySelector(${JSON.stringify(`${rowScope} [data-testid="slack-account-status"]`)})?.textContent==='Connected'`
			)
		);
		await wait("callback consumed and closed", async () => !(await portOpen()));
		const saved = envelope();
		assert.ok(saved.slack, "Slack grant must be persisted encrypted");
		const session = JSON.parse(safeStorage.decryptString(Buffer.from(saved.slack, "base64")));
		assert.equal(session.provider, "slack");
		assert.equal(session.account.id, ACTOR.userId);
		assert.deepEqual(session.slack, { appId: "A66001", ...ACTOR });
		assert.ok(
			session.accessToken === ACCESS,
			"Encrypted persisted token must be the exchanged user token"
		);
		assert.equal(session.refreshToken, null);
		assert.deepEqual([...session.scopes].sort(), [...SCOPES].sort());
		assert.ok(
			report.reads.some((row) => row.method === "auth.test") &&
				report.reads.some((row) => row.method === "users.info")
		);
		report.actualCallbackHTTP = true;
		report.actualSafeStorage = true;
		report.checks.push(
			"wrong state rejected; actual HTTP localhost callback, PKCE without secret/bot scope, verified user and same source actor; real encrypted 0600 grant"
		);
		await wait("source following UI independently of OAuth consent", () =>
			js(
				`document.querySelector(${JSON.stringify(`${sourceScope} h3`)})?.textContent==='Following your Slack conversations'&&document.querySelector(${JSON.stringify(`${sourceScope} [data-testid="slack-source-status"]`)})?.textContent.includes('Following all active channels and DMs you belong to · 3 conversations')`
			)
		);
		await wait("one automatic bounded history read", () =>
			report.reads.some((row) => row.method === "conversations.history")
		);
		report.checks.push(
			"actual source status confirms all_joined, completed discovery and all three joined conversations before any list/save UI action; automatic empty-history read"
		);
		await wait("collapsed advanced conversation exclusions", () =>
			js(
				`(() => {const e=[...document.querySelectorAll(${JSON.stringify(`${sourceScope} details > summary`)})].find(e=>e.textContent.trim()==='Conversations and exclusions');if(!e)return false;if(e.parentElement.open)throw new Error('Advanced exclusions must start collapsed');e.click();return true;})()`
			)
		);
		await buttonText(sourceScope, "Show conversations");
		const listed = await wait("actual conversation RPC source labels", () =>
			report.rpc.find((row) => row.path === "slack.conversations" && !row.rejected && row.items)?.items
		);
		await wait("all three included source checkboxes", () =>
			js(
				`(() => {const es=[...document.querySelectorAll(${JSON.stringify(`${sourceScope} label input[type=checkbox]`)})];return es.length===3&&es.every(e=>e.checked&&!e.disabled);})()`
			)
		);
		assertConversationLabels(
			listed,
			await js(
				`[...document.querySelectorAll(${JSON.stringify(`${sourceScope} label`)})].map(e=>e.textContent.trim())`
			)
		);
		await wait("uncheck the third source conversation", () =>
			js(
				`(() => {const label=[...document.querySelectorAll(${JSON.stringify(`${sourceScope} label`)})].find(e=>e.textContent.includes(${JSON.stringify(CHANNELS[2].name)}));const e=label?.querySelector('input[type=checkbox]');if(!e||e.disabled)return false;if(e.checked)e.click();return !e.checked;})()`
			)
		);
		await buttonText(sourceScope, "Save exclusions");
		const remaining = await wait("actual all-joined exclusions and completed rediscovery", async () => {
			const row = await rpc("slack.status");
			return (
				row.followMode === "all_joined" &&
				row.membershipSync?.phase === "complete" &&
				row.excludedConversationIds?.includes(EXCLUDED[0]) &&
				row
			);
		});
		assertFollowing(remaining, EXCLUDED);
		assert.equal(exclusionsApplied, true);
		assert.equal(report.rpc.filter((row) => row.path === "slack.follow" && !row.rejected).length, 1);
		assert.deepEqual(report.rpc.find((row) => row.path === "slack.follow").input, {
			mode: "all_joined",
			excludedConversationIds: EXCLUDED,
		});
		await wait("source exclusion UI confirmed", () =>
			js(
				`document.querySelector(${JSON.stringify(`${sourceScope} [data-testid="slack-source-status"]`)})?.textContent.includes('2 conversations · 1 excluded')`
			)
		);
		await uiSafe();
		envOnly();
		assert.deepEqual(await others(), baseline);
		await js(
			`new Promise(resolve=>{document.querySelector(${JSON.stringify(rowScope)}).scrollIntoView({block:'center'});requestAnimationFrame(()=>requestAnimationFrame(resolve));})`
		);
		try {
			const shot = await win.webContents.capturePage();
			assert.ok(!shot.isEmpty());
			fs.writeFileSync(screenshotPath, shot.toPNG());
			report.screenshot = {
				path: screenshotPath,
				label: "Connected Slack Settings — controlled provider inputs, not live consent",
			};
		} catch {
			report.screenshot = { available: false };
		}
		report.checks.push(
			"actual advanced UI preserves provider/profile labels, excludes third via exact slack.follow RPC and retains first channel/DM; empty history only, no model/ingestion"
		);
		await begin();
		await click(action("cancel"));
		await wait(
			"cancel reconnect closes listener",
			async () => (await slack()).phase !== "connecting" && !(await portOpen())
		);
		assert.equal((await slack()).source, "oauth");
		assert.deepEqual(envelope(), saved);
		await click(action("disconnect"));
		await wait(
			"only Slack disconnected",
			async () =>
				(await slack()).phase === "disconnected" &&
				(await rpc("slack.status")).phase === "disconnected"
		);
		assert.equal((await slack()).account, null);
		assert.equal((await slack()).source, null);
		const removed = envelope();
		const { slack: _removed, ...expected } = saved;
		assert.deepEqual(removed, expected);
		envOnly();
		assert.deepEqual(await others(), baseline);
		assert.equal(await portOpen(), false);
		await uiSafe();
		for (const path of ["oauth.start", "oauth.cancel", "oauth.disconnect"])
			assert.ok(
				report.rpc.some((row) => row.path === path && row.provider === "slack" && !row.rejected)
			);
		report.checks.push(
			"UI reconnect/Cancel preserves encrypted grant; UI Disconnect clears Slack grant/account only, retains registration and GitHub/Linear baseline metadata"
		);
		await begin();
		assert.equal(report.tokenPosts, 1);
		complete = true;
		stop(); // Actual application disposal must close this pending production listener.
	} catch (error) {
		stop(error);
	}
}

function selfCheck() {
	const verifier = "v".repeat(43);
	const url = new URL(AUTHORIZE);
	url.search = new URLSearchParams({
		client_id: CLIENT,
		redirect_uri: CALLBACK,
		state: "s".repeat(43),
		user_scope: SCOPES.join(","),
		code_challenge: hash(verifier),
		code_challenge_method: "S256",
	}).toString();
	const flow = { ...authorization(url.href), code: "controlled-self-check-code" };
	const form = new URLSearchParams({
		client_id: CLIENT,
		grant_type: "authorization_code",
		code: flow.code,
		redirect_uri: CALLBACK,
		code_verifier: verifier,
	});
	const options = {
		method: "POST",
		redirect: "error",
		headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
		body: form.toString(),
	};
	tokenForm(options, flow);
	for (const [key, value] of [
		["scope", "chat:write"],
		["client_secret", "forbidden"],
		["code_verifier", verifier],
		["redirect_uri", "http://127.0.0.1:43187/oauth/slack/callback"],
	]) {
		const invalid = new URL(url);
		invalid.searchParams.set(key, value);
		assert.throws(() => authorization(invalid.href));
	}
	for (const [key, value] of [
		["client_secret", "forbidden"],
		["code_verifier", "x".repeat(43)],
		["code", "wrong-code"],
		["redirect_uri", `${CALLBACK}/wrong`],
	]) {
		const invalid = new URLSearchParams(form);
		invalid.set(key, value);
		assert.throws(() => tokenForm({ ...options, body: invalid.toString() }, flow));
	}
	assert.throws(() =>
		tokenForm(
			{ ...options, headers: { ...options.headers, Authorization: "Basic forbidden" } },
			flow
		)
	);
	assert.equal(callbackOnly(new URL(`${CALLBACK}?state=controlled`)), true);
	for (const address of [
		"http://localhost:43188/oauth/slack/callback",
		"http://127.0.0.1:43187/oauth/slack/callback",
		`${CALLBACK}/wrong`,
		"https://localhost:43187/oauth/slack/callback",
		"http://user:pass@localhost:43187/oauth/slack/callback",
		TOKEN,
	])
		assert.equal(callbackOnly(new URL(address)), false);
	assert.equal(localURL("file:///controlled/index.html"), true);
	for (const address of [CALLBACK, TOKEN, "wss://slack.com/socket", "bad url"])
		assert.equal(localURL(address), false);
	const env = {
		SLACK_USER_TOKEN: "s",
		SLACK_OAUTH_CLIENT_SECRET: "s",
		SLACK_APP_TOKEN: "s",
		SLACK_APP_ID: "s",
		GITHUB_TOKEN: "s",
		GH_TOKEN: "s",
		LINEAR_API_KEY: "s",
		MODEL_API_KEY: "s",
		ELEVENLABS_API_KEY: "s",
		META_API_KEY: "s",
		OPENAI_API_KEY: "s",
		ANTHROPIC_API_KEY: "s",
		METAHACKATHON_ENV_FILE: "s",
		VITE_MUSE_VOICE_PRECONNECT: "1",
		PATH: "retained",
	};
	scrubEnvironment(env);
	assert.deepEqual(env, { PATH: "retained" });
	publicSafe({ phase: "connected", account: PROFILE }, [ACCESS]);
	for (const invalid of [
		{ text: ACCESS },
		{ accessToken: "hidden" },
		{ nested: { refresh_token: "hidden" } },
	])
		assert.throws(() => publicSafe(invalid, [ACCESS]));
	const following = {
		phase: "connected",
		error: null,
		followMode: "all_joined",
		watching: JOINED,
		excludedConversationIds: [],
		membershipSync: {
			phase: "complete",
			discoveredCount: 3,
			completedAt: "2026-10-31T10:00:00.000Z",
		},
	};
	assertFollowing(following);
	assertFollowing(
		{ ...following, watching: JOINED.slice(0, 2), excludedConversationIds: EXCLUDED },
		EXCLUDED
	);
	for (const invalid of [
		{ ...following, followMode: "selected" },
		{ ...following, watching: JOINED.slice(0, 2) },
		{ ...following, membershipSync: { ...following.membershipSync, phase: "pending" } },
		{ ...following, membershipSync: { ...following.membershipSync, discoveredCount: 2 } },
	])
		assert.throws(() => assertFollowing(invalid));
	const items = CHANNELS.map((row) => ({
		id: row.id,
		workspaceId: ACTOR.workspaceId,
		name: row.is_im ? DM_PROFILE.displayName : row.name,
		visibility: row.is_im ? "direct_message" : "public_channel",
	}));
	const labels = items.map((row) => `${row.name} · ${row.visibility.replaceAll("_", " ")}`);
	assertConversationLabels(items, labels);
	assert.throws(() => assertConversationLabels(items, items.map((row) => row.id)));
	assert.throws(() =>
		assertConversationLabels(
			items.map((row) => (row.id === "D66001" ? { ...row, name: "controlled-selected-dm" } : row)),
			labels
		)
	);
	console.log(
		"SLACK_OAUTH_SELF_CHECK_PASS: PKCE/form/state, localhost/network/env/metadata guards, completed all-joined/exclusion state and source labels; no Electron/native imports, app, filesystem reads or network calls"
	);
}
if (process.argv.includes("--self-check")) selfCheck();
else if (
	require.main === module ||
	(process.versions.electron && process.argv[1] && resolve(process.argv[1]) === resolve(__filename))
)
	native().catch(() => {
		console.error(
			"SLACK_OAUTH_SMOKE_FAILED: native initialization failed; root must run Electron after integration"
		);
		process.exitCode = 1;
	});
