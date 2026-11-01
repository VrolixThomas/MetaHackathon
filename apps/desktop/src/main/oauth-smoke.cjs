// ROOT ONLY, after building the default App (from apps/desktop):
// env -u ELECTRON_RUN_AS_NODE electron src/main/oauth-smoke.cjs [built-main]
// AUTHOR ONLY: node --check this-file; node this-file --self-check.
// Controlled provider records are transport inputs, never fabricated successful RPC results.
// No real browser, credentials, microphone, model, GitHub writes or Linear mutations.
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
const PROVIDERS = ["github", "linear"];
const CLIENTS = { github: "controlled-github-client", linear: "controlled-linear-client" };
const SECRETS = {
	model: "oauth-smoke-controlled-model-key",
	client: "oauth-smoke-controlled-github-client-secret",
	github: "oauth-smoke-controlled-github-access",
	githubRefresh: "oauth-smoke-controlled-github-refresh",
	linear: "oauth-smoke-controlled-linear-initial-access",
	linearRefresh: "oauth-smoke-controlled-linear-initial-refresh",
	linearNew: "oauth-smoke-controlled-linear-rotated-access",
	linearNewRefresh: "oauth-smoke-controlled-linear-rotated-refresh",
	manualGitHub: "oauth-smoke-controlled-manual-github",
	manualAlias: "oauth-smoke-controlled-manual-gh-alias",
	manualLinear: "oauth-smoke-controlled-manual-linear",
};
const AUTHORIZE = {
	github: "https://github.com/login/oauth/authorize",
	linear: "https://linear.app/oauth/authorize",
};
const TOKEN = {
	github: "https://github.com/login/oauth/access_token",
	linear: "https://api.linear.app/oauth/token",
};
const REPOSITORY = "oauth-smoke/controlled-repository";
const GH_PROFILE = {
	id: 53001,
	login: "oauth-smoke-viewer",
	name: "Controlled GitHub Viewer",
	avatar_url: "https://avatars.githubusercontent.com/u/53001?v=4",
};
const LINEAR_PROFILE = { id: "oauth-smoke-linear-viewer", name: "Controlled Linear Viewer" };
const TICKET_ID = "oauth-smoke-owned-ticket";
const FOREIGN_ID = "oauth-smoke-other-owner-ticket";
const FOREIGN_TITLE = "OTHER_OWNER_PRIVATE_TITLE_MUST_NOT_LEAK";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const callback = (provider) =>
	`http://${provider === "slack" ? "localhost" : "127.0.0.1"}:${PORT}/oauth/${provider}/callback`;
const challenge = (verifier) => createHash("sha256").update(verifier).digest("base64url");

function ticket(foreign = false) {
	return {
		id: foreign ? FOREIGN_ID : TICKET_ID,
		identifier: foreign ? "OAUTH-999" : "OAUTH-53",
		title: foreign ? FOREIGN_TITLE : "Controlled OAuth native acceptance ticket",
		description: "Controlled provider input; no executed worker evidence.",
		url: `https://linear.app/oauth-smoke/issue/${foreign ? "OAUTH-999" : "OAUTH-53"}`,
		updatedAt: "2026-10-30T10:00:00.000Z",
		priority: 2,
		state: { id: "oauth-smoke-state", name: "Todo", type: "unstarted" },
		team: { id: "oauth-smoke-team", name: "Controlled OAuth team" },
		project: null,
		assignee: foreign ? { id: "other-owner", name: "Other Owner" } : LINEAR_PROFILE,
	};
}

function publicSafe(value, markers) {
	const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
	for (const marker of markers)
		assert.ok(!text.includes(marker), "Private controlled material escaped a public surface");
	assert.ok(!text.includes(FOREIGN_TITLE), "Another owner's ticket escaped through IPC/UI");
}

function authorization(provider, address) {
	const url = new URL(address);
	assert.equal(`${url.origin}${url.pathname}`, AUTHORIZE[provider]);
	assert.equal(url.searchParams.get("client_id"), CLIENTS[provider]);
	assert.equal(url.searchParams.get("redirect_uri"), callback(provider));
	assert.equal(url.searchParams.get("code_challenge_method"), "S256");
	assert.match(url.searchParams.get("state") ?? "", /^[A-Za-z0-9_-]{43}$/);
	assert.match(url.searchParams.get("code_challenge") ?? "", /^[A-Za-z0-9_-]{43}$/);
	assert.ok(!url.searchParams.has("client_secret"));
	assert.ok(!url.searchParams.has("code_verifier"));
	assert.ok(!address.includes(SECRETS.client));
	if (provider === "linear") {
		assert.equal(url.searchParams.get("response_type"), "code");
		assert.equal(url.searchParams.get("actor"), "user");
		assert.equal(url.searchParams.get("prompt"), "consent");
		assert.equal(url.searchParams.get("scope"), "read,write");
	} else assert.equal(url.searchParams.get("scope"), "repo read:user read:org offline_access");
	return {
		provider,
		state: url.searchParams.get("state"),
		challenge: url.searchParams.get("code_challenge"),
	};
}

function tokenForm(provider, options, flow) {
	assert.equal(options.method, "POST");
	const headers = new Headers(options.headers);
	assert.equal(headers.get("content-type"), "application/x-www-form-urlencoded");
	assert.equal(headers.get("accept"), "application/json");
	assert.equal(headers.get("authorization"), null);
	assert.equal(options.redirect, "error");
	assert.equal(typeof options.body, "string");
	const form = new URLSearchParams(options.body);
	assert.equal(form.get("client_id"), CLIENTS[provider]);
	if (provider === "github")
		assert.ok(
			form.get("client_secret") === SECRETS.client,
			"GitHub token POST needs client secret"
		);
	else assert.equal(form.has("client_secret"), false, "Linear PKCE must work without a secret");
	const refresh = form.get("grant_type") === "refresh_token";
	const keys = ["client_id", "grant_type", ...(provider === "github" ? ["client_secret"] : [])];
	if (refresh) {
		assert.equal(provider, "linear");
		assert.ok(form.get("refresh_token") === SECRETS.linearRefresh, "Refresh must use saved token");
		keys.push("refresh_token");
	} else {
		assert.equal(form.get("grant_type"), "authorization_code");
		assert.ok(flow && form.get("code") === flow.code, "Token code must come from actual callback");
		assert.equal(form.get("redirect_uri"), callback(provider));
		const verifier = form.get("code_verifier") ?? "";
		assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
		assert.ok(challenge(verifier) === flow.challenge, "PKCE verifier must match opened URL");
		keys.push("code", "redirect_uri", "code_verifier");
	}
	assert.deepEqual([...form.keys()].sort(), keys.sort(), "Only standard OAuth form fields");
	return { refresh, verifier: form.get("code_verifier") };
}

function callbackOnly(url) {
	return (
		url.origin === `http://127.0.0.1:${PORT}` &&
		!url.username &&
		!url.password &&
		/^\/oauth\/(github|linear)\/callback(?:\/wrong)?$/.test(url.pathname)
	);
}

async function portOpen() {
	return new Promise((done, reject) => {
		const socket = net.createConnection({ host: "127.0.0.1", port: PORT });
		const finish = (value) => {
			socket.destroy();
			done(value);
		};
		socket.setTimeout(750);
		socket.once("connect", () => finish(true));
		socket.once("error", (error) => {
			if (error.code === "ECONNREFUSED") finish(false);
			else reject(error);
		});
		socket.once("timeout", () => {
			socket.destroy();
			reject(new Error("Callback port probe timed out"));
		});
	});
}

async function native() {
	assert.ok(process.versions.electron, "Root must launch this harness with Electron");
	assert.ok(!process.env.ELECTRON_RENDERER_URL, "Built default App required");
	const { app, BrowserWindow, ipcMain, shell, safeStorage } = require("electron");
	const owned = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "met-oauth-smoke-")));
	const owner = randomUUID();
	const ownerPath = join(owned, ".oauth-owner");
	const envPath = join(owned, ".env");
	const storePath = join(owned, "oauth/oauth.sessions.encrypted.json");
	fs.writeFileSync(ownerPath, owner, { mode: 0o600 });
	fs.writeFileSync(
		envPath,
		`MODEL_API_KEY=${SECRETS.model}\nGITHUB_OAUTH_CLIENT_ID=${CLIENTS.github}\nGITHUB_OAUTH_CLIENT_SECRET=${SECRETS.client}\nLINEAR_OAUTH_CLIENT_ID=${CLIENTS.linear}\nLINEAR_OAUTH_CLIENT_SECRET=\n`,
		{ mode: 0o600 }
	);
	// Explicit env file prevents development-path lookup and old credential migration.
	for (const name of [
		"GITHUB_TOKEN",
		"GH_TOKEN",
		"LINEAR_API_KEY",
		"MODEL_API_KEY",
		"META_API_KEY",
		"ELEVENLABS_API_KEY",
		"ELEVENLABS_VOICE_ID",
		"GITHUB_OAUTH_CLIENT_ID",
		"GITHUB_OAUTH_CLIENT_SECRET",
		"LINEAR_OAUTH_CLIENT_ID",
		"LINEAR_OAUTH_CLIENT_SECRET",
	])
		delete process.env[name];
	process.env.METAHACKATHON_ENV_FILE = envPath;
	app.setPath("userData", owned);
	const reportPath = join(__dirname, "../../out/oauth-smoke-report.json");
	fs.mkdirSync(dirname(reportPath), { recursive: true });
	const report = {
		status: "running",
		actualBuiltApp: false,
		actualPreloadIPC: false,
		controlledProviders: true,
		actualCallbackHTTP: false,
		actualSafeStorage: false,
		liveOAuthProviders: false,
		liveSpeech: false,
		physicalMicrophone: false,
		workerExecutionClaimed: false,
		userData: owned,
		checks: [],
		tokenPosts: [],
		providerReads: [],
		oauthRPC: [],
		blocked: [],
	};
	const privateMarkers = new Set(Object.values(SECRETS));
	const redact = (value) => {
		let text = String(value);
		for (const marker of privateMarkers) text = text.split(marker).join("[CONTROLLED-PRIVATE]");
		return text;
	};
	const save = () => fs.writeFileSync(reportPath, `${redact(JSON.stringify(report, null, 2))}\n`);
	let failure;
	let quitting = false;
	let win;
	let mainImported = false;
	const markFailure = (error) => {
		failure ??= error;
		return error;
	};
	async function wait(label, read, timeout = 10000) {
		const until = Date.now() + timeout;
		while (Date.now() < until) {
			if (failure) throw failure;
			const value = await read();
			if (value) return value;
			await sleep(40);
		}
		throw new Error(`Timed out: ${label}`);
	}
	function quit(error) {
		if (error) markFailure(error);
		if (quitting) return;
		quitting = true;
		if (error || failure) {
			report.status = "failed";
			report.error = redact((error ?? failure).message);
		}
		save();
		app.quit();
	}
	const originalFetch = globalThis.fetch;
	const originalOpen = shell.openExternal;
	const originalHandle = ipcMain.handle;
	const originals = new Map();
	const flows = [];
	const counters = { github: 0, linear: 0, refresh: 0, githubProfile: 0, linearProfile: 0 };
	const guard = (kind) => () => {
		report.blocked.push(kind);
		throw markFailure(new Error(`OAuth smoke forbids ${kind}`));
	};
	// No CLI import, worker or voice sidecar may escape the clean-profile test.
	for (const name of [
		"spawn",
		"spawnSync",
		"exec",
		"execSync",
		"execFile",
		"execFileSync",
		"fork",
	]) {
		originals.set(name, childProcess[name]);
		childProcess[name] = guard(`child process ${name}`);
	}
	syncBuiltinESMExports();
	shell.openExternal = async (address) => {
		try {
			const provider = PROVIDERS.find((name) => address.startsWith(`${AUTHORIZE[name]}?`));
			assert.ok(provider, "Unexpected shell.openExternal target");
			const flow = authorization(provider, address);
			publicSafe(address, privateMarkers);
			privateMarkers.add(flow.state);
			flow.code = `oauth-smoke-controlled-code-${randomUUID()}`;
			privateMarkers.add(flow.code);
			flows.push(flow);
		} catch (error) {
			throw markFailure(error);
		}
	};
	app.on("browser-window-created", (_event, window) => {
		window.setIgnoreMouseEvents(true);
		window.setFocusable(false);
	});
	app.on("web-contents-created", (_event, contents) => {
		contents.session.webRequest.onBeforeRequest(
			{ urls: ["http://*/*", "https://*/*"] },
			(details, done) => {
				report.blocked.push(`Chromium ${new URL(details.url).origin}`);
				markFailure(new Error("OAuth smoke forbids Chromium network navigation"));
				done({ cancel: true });
			}
		);
	});
	ipcMain.handle = function (channel, handler) {
		if (channel !== "trpc:request") return originalHandle.call(this, channel, handler);
		report.actualPreloadIPC = true;
		return originalHandle.call(this, channel, async (sender, request) => {
			try {
				assert.ok(
					!["app.requestMicrophone", "runtime.githubSignIn", "voice.offer"].includes(request.path)
				);
				if (request.path === "hub.operate")
					assert.equal(
						request.input?.json?.operation?.kind,
						"refresh",
						"No worker/provider writes"
					);
				const result = await handler(sender, request);
				publicSafe(result, privateMarkers);
				if (request.path.startsWith("oauth.") && request.path !== "oauth.status") {
					const row = result.result?.data?.json;
					report.oauthRPC.push({
						path: request.path,
						provider: row?.provider,
						phase: row?.phase,
						source: row?.source,
						rejected: !!result.error,
					});
				}
				return result;
			} catch (error) {
				throw markFailure(error);
			}
		});
	};
	globalThis.fetch = async (input, options = {}) => {
		try {
			const url = new URL(String(input.url ?? input));
			if (callbackOnly(url))
				return originalFetch(input, {
					...options,
					redirect: "error",
					signal: AbortSignal.timeout(2500),
				});
			const provider = PROVIDERS.find((name) => url.href === TOKEN[name]);
			if (provider) {
				const flow = flows.filter((item) => item.provider === provider).at(-1);
				const form = new URLSearchParams(options.body);
				for (const key of ["code", "code_verifier"])
					if (form.get(key)) privateMarkers.add(form.get(key));
				const parsed = tokenForm(provider, options, flow);
				if (parsed.verifier) privateMarkers.add(parsed.verifier);
				if (parsed.refresh) counters.refresh++;
				else counters[provider]++;
				assert.ok(
					counters[provider] <= 1 && counters.refresh <= 1,
					"Unexpected/replayed token exchange"
				);
				report.tokenPosts.push({
					provider,
					grant: parsed.refresh ? "refresh_token" : "authorization_code",
					pkceVerified: !parsed.refresh,
					clientSecretIncluded: provider === "github",
				});
				return Response.json({
					access_token:
						provider === "github"
							? SECRETS.github
							: parsed.refresh
								? SECRETS.linearNew
								: SECRETS.linear,
					refresh_token:
						provider === "github"
							? SECRETS.githubRefresh
							: parsed.refresh
								? SECRETS.linearNewRefresh
								: SECRETS.linearRefresh,
					token_type: "Bearer",
					scope: provider === "github" ? "repo read:user read:org" : "read,write",
					expires_in: provider === "linear" && !parsed.refresh ? 30 : 3600,
				});
			}
			const headers = new Headers(options.headers);
			assert.ok(
				![...headers.values()].some((value) => value.includes(SECRETS.client)),
				"Client secret left token endpoint"
			);
			if (url.origin === "https://api.github.com") {
				assert.equal(options.method ?? "GET", "GET", "Zero GitHub writes");
				assert.ok(
					headers.get("authorization") === `Bearer ${SECRETS.github}`,
					"GitHub must use OAuth Bearer"
				);
				report.providerReads.push({ provider: "github", path: url.pathname, bearer: true });
				if (url.pathname === "/user") {
					if (headers.get("user-agent") === "Muse-Desktop") counters.githubProfile++;
					return Response.json(GH_PROFILE);
				}
				if (url.pathname === "/user/repos")
					return Response.json([{ full_name: REPOSITORY, default_branch: "main", private: true }]);
			} else if (url.href === "https://api.linear.app/graphql") {
				assert.equal(options.method, "POST");
				const body = JSON.parse(options.body);
				assert.ok(!/\bmutation\b/i.test(body.query), "Zero Linear issue writes");
				const profile = body.query === "{ viewer { id name } }";
				const access = profile ? SECRETS.linear : SECRETS.linearNew;
				assert.ok(
					headers.get("authorization") === `Bearer ${access}`,
					"Linear client must use refreshed OAuth Bearer"
				);
				const operation = profile ? "OAuthProfile" : /query\s+(\w+)/.exec(body.query)?.[1];
				report.providerReads.push({
					provider: "linear",
					operation,
					bearer: true,
					refreshed: !profile,
				});
				if (profile) {
					counters.linearProfile++;
					return Response.json({ data: { viewer: LINEAR_PROFILE } });
				}
				assert.equal(counters.refresh, 1, "Refresh must precede main client data queries");
				if (operation === "HubViewer") return Response.json({ data: { viewer: LINEAR_PROFILE } });
				const page = (nodes) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
				if (operation === "HubTickets") {
					assert.equal(body.variables.filter.assignee.id.eq, LINEAR_PROFILE.id);
					return Response.json({ data: { issues: page([ticket()]) } });
				}
				if (operation === "HubTicket") {
					assert.ok([TICKET_ID, FOREIGN_ID].includes(body.variables.id));
					return Response.json({ data: { issue: ticket(body.variables.id === FOREIGN_ID) } });
				}
				if (operation === "HubTeams")
					return Response.json({
						data: {
							teams: page([
								{ id: "oauth-smoke-team", name: "Controlled OAuth team", key: "OAUTH" },
							]),
						},
					});
				if (operation === "HubProjects") return Response.json({ data: { projects: page([]) } });
			}
			report.blocked.push(url.origin);
			throw new Error("OAuth smoke forbids unexpected provider/network requests");
		} catch (error) {
			throw markFailure(error);
		}
	};
	const hardStop = setTimeout(() => {
		report.status = "failed";
		report.error = "149-second hard deadline; native shutdown did not finish";
		report.cleanup = { finished: false, retainedOwnedProfile: owned };
		save();
		app.exit(1);
	}, 149000);
	const deadline = setTimeout(() => quit(new Error("140-second OAuth smoke deadline")), 140000);
	// Install AFTER main import so main closes SQLite and disposes services before final audit.
	function installFinalAudit() {
		app.once("will-quit", (event) => {
			event.preventDefault();
			clearTimeout(deadline);
			void (async () => {
				try {
					if (failure) throw failure;
					assert.equal(report.status, "passed", "App quit before OAuth checks completed");
					assert.equal(await portOpen(), false, "OAuth callback listener survived app quit");
					if (report.status === "passed") {
						const diagnostics = fs.readFileSync(
							join(owned, "diagnostics/conversation.jsonl"),
							"utf8"
						);
						publicSafe(diagnostics, privateMarkers);
						assert.ok(
							diagnostics
								.split("\n")
								.filter(Boolean)
								.map(JSON.parse)
								.some((row) => row.stage === "shutdown-complete")
						);
						const Database = require("better-sqlite3");
						const db = new Database(join(owned, "metahackathon.db"), { readonly: true });
						try {
							const state = JSON.parse(
								db.prepare("SELECT data_json FROM hub_state WHERE id=1").get().data_json
							);
							assert.deepEqual(state.jobs, []);
							assert.deepEqual(state.tickets, []);
						} finally {
							db.close();
						}
						report.checks.push(
							"pending callback closed by actual app quit; shutdown diagnostics and SQLite reopen"
						);
					}
				} catch (error) {
					report.status = "failed";
					report.error = redact(error.message);
				} finally {
					try {
						assert.equal(fs.readFileSync(ownerPath, "utf8"), owner);
						fs.rmSync(owned, { recursive: true, maxRetries: 3, retryDelay: 50 });
						report.cleanup = {
							appQuit: true,
							callbackClosed: !(await portOpen()),
							ownedTempRemoved: !fs.existsSync(owned),
						};
					} catch (error) {
						report.status = "failed";
						report.error = redact(error.message);
					}
					globalThis.fetch = originalFetch;
					shell.openExternal = originalOpen;
					ipcMain.handle = originalHandle;
					ipcMain.removeHandler("trpc:request");
					for (const [name, original] of originals) childProcess[name] = original;
					syncBuiltinESMExports();
					save();
					clearTimeout(hardStop);
					console.log(`OAUTH_SMOKE_${report.status.toUpperCase()}: ${reportPath}`);
					app.exit(report.status === "passed" ? 0 : 1);
				}
			})();
		});
	}
	try {
		assert.equal(
			await portOpen(),
			false,
			"Fixed callback port is already occupied; do not touch its owner"
		);
		await import(
			pathToFileURL(resolve(process.argv[2] ?? join(__dirname, "../../out/main/index.js"))).href
		);
		mainImported = true;
		installFinalAudit();
		await app.whenReady();
		assert.ok(safeStorage.isEncryptionAvailable(), "Real OS safeStorage encryption required");
		assert.notEqual(safeStorage.getSelectedStorageBackend?.(), "basic_text");
		win = await wait("built root window", () => BrowserWindow.getAllWindows()[0]);
		await wait("default renderer", () => !win.webContents.isLoadingMainFrame());
		const js = (code) => win.webContents.executeJavaScript(code);
		const rawRPC = async (type, path, input = {}) => {
			return js(
				`window.electron.trpc.request(${JSON.stringify({ type, path, input: { json: input } })})`
			);
		};
		const rpc = async (path, input = {}) => {
			const result = await rawRPC("query", path, input);
			assert.ok(!result.error, `${path}: ${result.error?.message ?? ""}`);
			return result.result.data.json;
		};
		const statuses = () => rpc("oauth.status");
		const status = async (provider) => (await statuses()).find((row) => row.provider === provider);
		const hub = () => rpc("hub.snapshot");
		const uiSafe = async () => publicSafe(await js("document.body.innerText"), privateMarkers);
		const click = async (selector) => {
			await wait(`enabled visible ${selector}`, () =>
				js(
					`(() => {const e=document.querySelector(${JSON.stringify(selector)});return !!e&&!e.disabled&&e.getBoundingClientRect().width>0;})()`
				)
			);
			await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
		};
		const button = (provider, action) =>
			`#configuration [data-testid="oauth-${provider}-${action}"]`;
		const uiStatus = (provider) =>
			js(
				`document.querySelector('#configuration [data-testid="${provider}-account-status"]')?.textContent`
			);
		const encrypted = (expected) => {
			assert.equal(fs.lstatSync(storePath).isSymbolicLink(), false);
			assert.equal(fs.statSync(storePath).mode & 0o777, 0o600);
			assert.equal(fs.statSync(dirname(storePath)).mode & 0o777, 0o700);
			const raw = fs.readFileSync(storePath, "utf8");
			publicSafe(raw, privateMarkers);
			const envelope = JSON.parse(raw);
			assert.equal(envelope.version, 1);
			assert.deepEqual(Object.keys(envelope).sort(), ["version", ...expected].sort());
			for (const provider of expected) {
				const bytes = Buffer.from(envelope[provider], "base64");
				publicSafe(bytes.toString("utf8"), privateMarkers);
				const session = JSON.parse(safeStorage.decryptString(bytes));
				assert.equal(session.provider, provider);
				assert.equal(
					session.account.id,
					provider === "github" ? String(GH_PROFILE.id) : LINEAR_PROFILE.id
				);
				assert.ok(
					session.accessToken === (provider === "github" ? SECRETS.github : SECRETS.linearNew),
					"Actual encrypted access token mismatch"
				);
				assert.ok(
					session.refreshToken ===
						(provider === "github" ? SECRETS.githubRefresh : SECRETS.linearNewRefresh),
					"Actual encrypted refresh token mismatch"
				);
			}
			report.actualSafeStorage = true;
		};
		const registrations = () => {
			const env = parseEnv(fs.readFileSync(envPath, "utf8"));
			assert.equal(env.GITHUB_OAUTH_CLIENT_ID, CLIENTS.github);
			assert.ok(
				env.GITHUB_OAUTH_CLIENT_SECRET === SECRETS.client,
				"Registered client secret changed"
			);
			assert.equal(env.LINEAR_OAUTH_CLIENT_ID, CLIENTS.linear);
			assert.equal(env.LINEAR_OAUTH_CLIENT_SECRET, "");
			return env;
		};
		const begin = async (provider) => {
			const previous = flows.length;
			await click(button(provider, "connect"));
			const flow = await wait(
				`${provider} controlled external authorization`,
				() => flows.length === previous + 1 && flows.at(-1)
			);
			assert.equal(flow.provider, provider);
			await wait(
				`${provider} actual main connecting`,
				async () => (await status(provider)).phase === "connecting"
			);
			assert.ok(
				report.oauthRPC.some(
					(row) =>
						row.path === "oauth.start" && row.provider === provider && row.phase === "connecting"
				)
			);
			await wait(`${provider} Settings connecting state`, async () =>
				/browser|sign-in/.test(await uiStatus(provider))
			);
			assert.equal(await portOpen(), true);
			await uiSafe();
			return flow;
		};
		let staticHtml;
		const callbackRequest = async (address, method, expected) => {
			const response = await globalThis.fetch(address, { method });
			assert.equal(response.status, expected);
			assert.equal(response.headers.get("cache-control"), "no-store");
			assert.equal(response.headers.get("referrer-policy"), "no-referrer");
			assert.ok(response.headers.get("content-security-policy").includes("default-src 'none'"));
			const html = await response.text();
			publicSafe(html, privateMarkers);
			assert.match(html, /Return to MuseFocus to continue\./);
			if (staticHtml) assert.equal(html, staticHtml, "Callback HTML must be static");
			staticHtml = html;
		};
		await wait("RootApp Home", () =>
			js("document.querySelector('.hub-center')?.dataset.centerSection==='home'")
		);
		report.actualBuiltApp = true;
		const initial = await hub();
		assert.deepEqual(initial.connections, {
			github: false,
			linear: false,
			model: true,
			coding: true,
		});
		for (const key of ["repositories", "reviews", "tickets", "jobs", "notices"])
			assert.deepEqual(initial[key], []);
		assert.deepEqual(initial.viewer, { githubLogin: null, linearName: null });
		assert.equal((await rpc("app.config")).configured.github, false);
		assert.equal(fs.existsSync(storePath), false);
		const env = registrations();
		assert.ok(!env.GITHUB_TOKEN && !env.GH_TOKEN && !env.LINEAR_API_KEY);
		for (const row of await statuses()) {
			assert.equal(row.phase, "disconnected");
			assert.equal(row.source, null);
			assert.equal(row.account, null);
			assert.equal(row.configurationReady, PROVIDERS.includes(row.provider));
			assert.equal(row.callbackUrl, callback(row.provider));
		}
		await click('.command-rail button[aria-label="Settings"]');
		await wait("actual Settings dialog", () =>
			js("document.querySelector('#configuration')?.open")
		);
		for (const provider of PROVIDERS)
			await wait(
				`${provider} disconnected UI`,
				async () => (await uiStatus(provider)) === "Disconnected"
			);
		assert.ok(
			await js(
				"(() => {const e=document.querySelector('#configuration .configuration-advanced');return e?.querySelector('summary')?.textContent==='Other connection methods'&&!e.open&&!!e.querySelector('[data-testid=github-connect]');})()"
			)
		);
		report.checks.push("empty owned profile; OAuth widget in actual Settings; advanced CLI closed");
		for (const provider of PROVIDERS) {
			const flow = await begin(provider);
			const valid = `${callback(provider)}?${new URLSearchParams({ code: flow.code, state: flow.state })}`;
			for (const [address, method, expected] of [
				[
					`${callback(provider)}?${new URLSearchParams({ code: flow.code, state: "x".repeat(43) })}`,
					"GET",
					400,
				],
				[valid, "POST", 404],
				[
					`${callback(provider)}/wrong?${new URLSearchParams({ code: flow.code, state: flow.state })}`,
					"GET",
					404,
				],
			]) {
				await callbackRequest(address, method, expected);
				assert.equal(counters[provider], 0, "Invalid callback must not exchange a token");
				assert.equal((await status(provider)).phase, "connecting");
			}
			await callbackRequest(valid, "GET", 200);
			await wait(`${provider} actual signed-in status`, async () => {
				const row = await status(provider);
				return row.phase === "connected" && row.source === "oauth" && row.account;
			});
			await wait(
				`${provider} default controller connected UI`,
				async () => (await uiStatus(provider)) === "Connected"
			);
			const profile = provider === "github" ? GH_PROFILE.name : LINEAR_PROFILE.name;
			assert.ok(
				await js(
					`document.querySelector('#configuration [data-testid="${provider}-account-status"]').parentElement.textContent.includes(${JSON.stringify(profile)})`
				)
			);
			await wait(`${provider} callback listener closed`, async () => !(await portOpen()));
			// Replaying a consumed callback must fail at HTTP or connection level, never exchange twice.
			try {
				const replay = await originalFetch(valid, {
					redirect: "error",
					signal: AbortSignal.timeout(1500),
				});
				assert.ok([404, 410].includes(replay.status), "Consumed callback accepted twice");
				await replay.body?.cancel();
			} catch (error) {
				assert.equal(
					error.cause?.code,
					"ECONNREFUSED",
					"Replay failure must be closed callback listener"
				);
			}
			assert.equal(counters[provider], 1);
			await uiSafe();
		}
		report.actualCallbackHTTP = true;
		const connected = await wait("real clients populate authenticated Hub", async () => {
			const snapshot = await hub();
			return (
				!snapshot.refreshing &&
				snapshot.viewer.githubLogin === GH_PROFILE.login &&
				snapshot.viewer.linearName === LINEAR_PROFILE.name &&
				snapshot.tickets.length === 1 &&
				snapshot
			);
		});
		assert.deepEqual(connected.connections, {
			github: true,
			linear: true,
			model: true,
			coding: true,
		});
		assert.deepEqual(connected.errors, []);
		assert.equal(connected.tickets[0].id, TICKET_ID);
		assert.equal(connected.tickets[0].assigneeId, LINEAR_PROFILE.id);
		assert.equal((await rpc("app.config")).configured.github, true);
		assert.equal((await rpc("runtime.githubAccount")).login, GH_PROFILE.login);
		assert.equal(
			(await rpc("runtime.credentialStatus")).find((row) => row.provider === "github").storage,
			"os-encrypted"
		);
		assert.deepEqual(await rpc("hub.repositories"), [
			{ repository: REPOSITORY, defaultBranch: "main", private: true },
		]);
		assert.equal((await rpc("hub.ticket", { id: TICKET_ID })).assigneeId, LINEAR_PROFILE.id);
		assert.equal((await rpc("hub.linearScopes"))[0].id, "oauth-smoke-team");
		const foreign = await rawRPC("query", "hub.ticket", { id: FOREIGN_ID });
		assert.ok(foreign.error && !foreign.result, "Other owner's provider record must be rejected");
		const invalid = await rawRPC("mutation", "oauth.start", {
			provider: "github",
			requestId: randomUUID(),
			unexpected: SECRETS.client,
		});
		assert.ok(
			invalid.error && !invalid.result,
			"Strict OAuth input must reject private extra material"
		);
		assert.equal(counters.githubProfile, 1);
		assert.equal(counters.linearProfile, 1);
		assert.equal(counters.refresh, 1);
		encrypted(PROVIDERS);
		report.checks.push(
			"both real callbacks; PKCE token forms; profile validation; refreshed Linear Bearer; Hub metadata and owner rejection; actual encrypted 0600 sessions"
		);
		// Seed dormant alternatives only AFTER OAuth succeeds. Verify OAuth priority, then selected
		// Linear disconnect clears its manual alternative while preserving the other account.
		fs.appendFileSync(
			envPath,
			`GITHUB_TOKEN=${SECRETS.manualGitHub}\nGH_TOKEN=${SECRETS.manualAlias}\nLINEAR_API_KEY=${SECRETS.manualLinear}\n`
		);
		for (const row of (await statuses()).filter((row) => PROVIDERS.includes(row.provider)))
			assert.equal(row.source, "oauth");
		assert.equal((await status("slack")).source, null);
		await rpc("hub.repositories");
		await rpc("hub.linearScopes");
		await click(button("linear", "disconnect"));
		await wait("Linear disconnected and fetched ticket queue cleared", async () => {
			const row = await status("linear");
			const snapshot = await hub();
			return (
				row.phase === "disconnected" &&
				row.source === null &&
				!snapshot.connections.linear &&
				snapshot.viewer.linearName === null &&
				snapshot.tickets.length === 0
			);
		});
		assert.equal((await status("linear")).account, null);
		assert.equal((await status("github")).phase, "connected");
		assert.equal((await status("github")).source, "oauth");
		assert.ok(!registrations().LINEAR_API_KEY);
		encrypted(["github"]);
		const readsBefore = report.providerReads.length;
		assert.ok((await rawRPC("query", "hub.ticket", { id: TICKET_ID })).error);
		assert.ok((await rawRPC("query", "hub.linearScopes")).error);
		assert.equal(
			report.providerReads.length,
			readsBefore,
			"Disconnected Linear cannot query provider"
		);
		await wait("Linear disconnected UI", async () => (await uiStatus("linear")) === "Disconnected");
		const cleared = registrations();
		assert.ok(!cleared.LINEAR_API_KEY);
		assert.ok(
			cleared.GITHUB_TOKEN === SECRETS.manualGitHub && cleared.GH_TOKEN === SECRETS.manualAlias,
			"Disconnect must preserve the other provider's manual fields"
		);
		assert.equal((await rpc("app.config")).configured.github, true);
		await rpc("hub.repositories");
		await uiSafe();
		report.checks.push(
			"actual UI Linear disconnect clears its session, manual alternative, viewer and fetched tickets; GitHub account/manual fields and registration credentials retained"
		);
		const reconnect = await begin("github");
		await click(button("github", "cancel"));
		await wait(
			"cancelled reconnect main state",
			async () => (await status("github")).phase !== "connecting"
		);
		await wait("cancelled reconnect port closed", async () => !(await portOpen()));
		assert.ok(
			report.oauthRPC.some((row) => row.path === "oauth.cancel" && row.provider === "github")
		);
		assert.equal((await status("github")).source, "oauth");
		assert.ok(
			reconnect.state !== flows.find((flow) => flow.provider === "github").state,
			"Reconnect needs a fresh state"
		);
		encrypted(["github"]);
		await rpc("hub.repositories");
		await wait("retained account Disconnect remains available after cancelled reconnect", () =>
			js(
				`(() => {const e=document.querySelector(${JSON.stringify(button("github", "disconnect"))});return !!e&&!e.disabled&&e.getBoundingClientRect().width>0;})()`
			)
		);
		report.checks.push(
			"actual UI cancelled GitHub reconnect closes listener, retains previous encrypted session and keeps Disconnect available"
		);
		// A new pending flow must be closed by actual main-process disposal on quit.
		await begin("github");
		assert.equal(counters.github, 1);
		assert.equal(counters.linear, 1);
		assert.deepEqual(report.blocked, []);
		assert.equal(win.contentView.children.length, 0, "No native browser or preview created");
		assert.deepEqual((await hub()).jobs, []);
		report.status = "passed";
		quit();
	} catch (error) {
		if (!mainImported) installFinalAudit();
		quit(error);
	}
}

function selfCheck() {
	const verifier = "v".repeat(43);
	for (const provider of PROVIDERS) {
		const url = new URL(AUTHORIZE[provider]);
		url.search = new URLSearchParams({
			client_id: CLIENTS[provider],
			redirect_uri: callback(provider),
			state: "s".repeat(43),
			code_challenge: challenge(verifier),
			code_challenge_method: "S256",
			scope: provider === "github" ? "repo read:user read:org offline_access" : "read,write",
			...(provider === "linear" ? { response_type: "code", actor: "user", prompt: "consent" } : {}),
		}).toString();
		const flow = { ...authorization(provider, url.href), code: "controlled-code" };
		const form = new URLSearchParams({
			client_id: CLIENTS[provider],
			grant_type: "authorization_code",
			code: flow.code,
			redirect_uri: callback(provider),
			code_verifier: verifier,
			...(provider === "github" ? { client_secret: SECRETS.client } : {}),
		});
		const options = {
			method: "POST",
			redirect: "error",
			body: form.toString(),
			headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
		};
		assert.equal(tokenForm(provider, options, flow).refresh, false);
		form.set("code_verifier", "x".repeat(43));
		assert.throws(() => tokenForm(provider, { ...options, body: form.toString() }, flow));
		url.searchParams.set("client_secret", SECRETS.client);
		assert.throws(() => authorization(provider, url.href));
	}
	const refresh = {
		method: "POST",
		redirect: "error",
		headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: CLIENTS.linear,
			grant_type: "refresh_token",
			refresh_token: SECRETS.linearRefresh,
		}).toString(),
	};
	assert.equal(tokenForm("linear", refresh).refresh, true);
	assert.throws(() =>
		tokenForm("linear", { ...refresh, body: `${refresh.body}&client_secret=no` })
	);
	publicSafe(
		{ phase: "connected", source: "oauth", account: LINEAR_PROFILE },
		Object.values(SECRETS)
	);
	for (const marker of [...Object.values(SECRETS), FOREIGN_TITLE])
		assert.throws(() => publicSafe({ error: marker }, Object.values(SECRETS)));
	assert.ok(callbackOnly(new URL(callback("github"))));
	assert.ok(callbackOnly(new URL(`${callback("linear")}/wrong?state=x`)));
	for (const address of [
		"http://127.0.0.1:43188/oauth/github/callback",
		"https://127.0.0.1:43187/oauth/github/callback",
		"http://localhost:43187/oauth/github/callback",
		"http://127.0.0.1:43187/",
		"https://api.github.com/user",
	])
		assert.equal(callbackOnly(new URL(address)), false);
	assert.equal(ticket().assignee.id, LINEAR_PROFILE.id);
	assert.notEqual(ticket(true).assignee.id, LINEAR_PROFILE.id);
	console.log(
		"OAUTH_SELF_CHECK_PASS: authorization/PKCE/form/refresh guards, public redaction, callback allowlist and controlled ownership records; no Electron, network, filesystem or environment reads"
	);
}

if (process.argv.includes("--self-check")) selfCheck();
else if (
	require.main === module ||
	(process.versions.electron && process.argv[1] && resolve(process.argv[1]) === resolve(__filename))
)
	native().catch(() => {
		console.error(
			"OAUTH_SMOKE_FAILED: native harness initialization failed; root must run Electron"
		);
		process.exitCode = 1;
	});
