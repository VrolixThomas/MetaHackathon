// Root-only native bootstrap. All product calls run unchanged; only HTTP provider transports are controlled.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const { randomUUID } = require("node:crypto");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { source, AUTH_ORIGIN, TEAM_ORIGIN, SECRET, createProvider } = require("./providers.cjs");
const pause = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
async function wait(label, read, milliseconds = 30000) {
	const end = Date.now() + milliseconds;
	while (Date.now() < end) {
		const value = await read();
		if (value) return value;
		await pause(40);
	}
	throw new Error(`Timed out: ${label}`);
}
async function launch() {
	assert.ok(
		process.versions.electron && !process.env.ELECTRON_RENDERER_URL,
		"Root must run built Electron; author may run --self-check only"
	);
	const { app, BrowserWindow, ipcMain, session, shell, safeStorage } = require("electron");
	const builtMain = resolve(process.argv[2] ?? join(__dirname, "../../../out/main/index.js"));
	assert.ok(fs.existsSync(builtMain), "Root must build complete team composition first");
	for (const key of Object.keys(process.env))
		if (
			/(?:TOKEN|SECRET|API_KEY|CLIENT_ID|VOICE_ID)/i.test(key) ||
			/^(?:SLACK_|LINEAR_|GITHUB_|GH_|META_|MODEL_|ELEVENLABS_|MUSE_|SUPABASE_)/.test(key)
		)
			delete process.env[key];
	const owned = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "muse-team-native-")));
	const marker = randomUUID();
	fs.writeFileSync(join(owned, ".owner"), marker, { mode: 0o600 });
	const userData = join(owned, "profile");
	fs.mkdirSync(userData);
	app.setPath("userData", userData);
	const envPath = join(owned, ".env");
	fs.writeFileSync(
		envPath,
		`GITHUB_TOKEN=${SECRET.github}\nSUPABASE_URL=${AUTH_ORIGIN}\nSUPABASE_PUBLISHABLE_KEY=${SECRET.publishable}\nMUSE_TEAM_SERVICE_URL=${TEAM_ORIGIN}\nCODING_PROVIDER=muse-code\nMUSE_CODE_PATH=/controlled/missing-muse-cli\n`,
		{ mode: 0o600 }
	);
	process.env.METAHACKATHON_ENV_FILE = envPath;
	const fixture = source.createRepository(owned, {
		"package.json": JSON.stringify({
			name: "controlled-team-application",
			private: true,
			scripts: { test: "node check.cjs" },
		}),
		"check.cjs": `const fs=require('node:fs');if(!fs.readFileSync('a-logic.ts','utf8').includes('Math.max(0, quote.discount)'))process.exit(1);console.log('CONTROLLED declared check passed');\n`,
	});
	const provider = createProvider(fixture);
	const out = join(__dirname, "../../../out");
	fs.mkdirSync(out, { recursive: true });
	const reportPath = join(out, "team-workspace-smoke-report.json");
	const report = {
		status: "running",
		actualAppIPC: true,
		actualTeamService: true,
		controlledHTTP: true,
		liveProviders: false,
		liveConsent: false,
		realTwoUsers: false,
		deployedCloud: false,
		realSQLRLS: "separate-root-check",
		liveSpeech: false,
		steps: [],
		ipc: [],
		blocked: [],
		permissions: [],
		provider: provider.report,
	};
	const save = () => fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
	let win;
	let origin;
	let stopping = false;
	const server = http.createServer(async (request, response) => {
		try {
			const target = new URL(request.headers["x-controlled-target"]);
			assert.ok([AUTH_ORIGIN, TEAM_ORIGIN, "https://api.github.com"].includes(target.origin));
			const chunks = [];
			let count = 0;
			for await (const chunk of request) {
				count += chunk.length;
				assert.ok(count <= 4_000_000);
				chunks.push(chunk);
			}
			const body = count ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
			if (target.origin === "https://api.github.com")
				assert.equal(request.headers.authorization, `Bearer ${SECRET.github}`);
			const value =
				target.origin === AUTH_ORIGIN
					? provider.auth(target, body, request.headers)
					: target.origin === TEAM_ORIGIN
						? provider.team(target, body, request.headers)
						: provider.github(target, request.method);
			response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
			response.end(JSON.stringify(value));
		} catch (error) {
			report.providerError = error.stack ?? error.message;
			response.writeHead(500, { "Content-Type": "application/json" });
			response.end('{"error":"controlled-protocol-rejected"}');
		}
	});
	const originalFetch = globalThis.fetch;
	const originalOpen = shell.openExternal;
	const originalHandle = ipcMain.handle;
	globalThis.fetch = (input, options = {}) => {
		const url = new URL(String(input.url ?? input));
		if (url.origin === "https://api.meta.ai") {
			provider.report.modelCalls++;
			report.blocked.push(url.origin);
			return Promise.reject(new Error("A shared review must never invoke a second local model"));
		}
		if ([AUTH_ORIGIN, TEAM_ORIGIN, "https://api.github.com"].includes(url.origin)) {
			const headers = new Headers(options.headers);
			headers.set("x-controlled-target", url.toString());
			return originalFetch(`${origin}/controlled`, { ...options, headers, redirect: "error" });
		}
		report.blocked.push(url.origin);
		return Promise.reject(new Error("External transport forbidden by native team smoke"));
	};
	shell.openExternal = async (address) => {
		const callback = provider.authorize(address);
		const result = await originalFetch(callback, { redirect: "error" });
		assert.equal(result.status, 200);
	};
	ipcMain.handle = function (channel, handler) {
		if (channel !== "trpc:request") return originalHandle.call(this, channel, handler);
		return originalHandle.call(this, channel, async (event, request) => {
			const path = request?.path;
			const row =
				path?.startsWith("team.") ||
				["reviews.connect", "workspace.prepare", "workspace.applied"].includes(path)
					? { path, input: structuredClone(request.input?.json) }
					: null;
			if (row) report.ipc.push(row);
			try {
				const result = await handler(event, request);
				if (row) {
					row.result = structuredClone(result);
					row.completed = true;
				}
				return result;
			} catch (error) {
				if (row) row.error = error.message;
				throw error;
			}
		});
	};
	app.on("browser-window-created", (_event, window) => {
		window.setFocusable(false);
		window.setIgnoreMouseEvents(true);
	});
	const stop = async (error) => {
		if (stopping) return;
		stopping = true;
		report.status = error ? "failed" : "passed";
		if (error) report.error = error.stack ?? String(error);
		try {
			if (win && !win.isDestroyed())
				fs.writeFileSync(
					join(out, `team-workspace-smoke${error ? "-failure" : ""}.png`),
					(await win.webContents.capturePage()).toPNG()
				);
		} catch {}
		save();
		await new Promise((done) => {
			server.close(done);
			server.closeAllConnections();
		});
		app.quit();
	};
	const deadline = setTimeout(
		() => void stop(new Error("Team native smoke hard deadline")),
		180000
	);
	app.on("will-quit", () => {
		clearTimeout(deadline);
		globalThis.fetch = originalFetch;
		shell.openExternal = originalOpen;
		ipcMain.handle = originalHandle;
		try {
			assert.equal(server.listening, false);
			assert.equal(fs.readFileSync(join(owned, ".owner"), "utf8"), marker);
			assert.equal(
				fs.readFileSync(join(fixture.localPath, source.order[1]), "utf8"),
				fixture.dirty
			);
			fs.rmSync(owned, { recursive: true });
			report.cleanup = {
				ownedRemoved: !fs.existsSync(owned),
				serverClosed: true,
				originalSourcePreserved: true,
			};
		} catch (error) {
			report.status = "failed";
			report.cleanupError = error.message;
		}
		save();
		console.log(`TEAM_WORKSPACE_SMOKE_${report.status.toUpperCase()}: ${reportPath}`);
		if (report.status !== "passed") app.exit(1);
	});
	try {
		await new Promise((done, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", done);
		});
		origin = `http://127.0.0.1:${server.address().port}`;
		await app.whenReady();
		assert.equal(safeStorage.isEncryptionAvailable(), true, "Actual OS encryption required");
		assert.notEqual(safeStorage.getSelectedStorageBackend?.(), "basic_text");
		session.defaultSession.setPermissionRequestHandler((_webContents, permission, done) => {
			report.permissions.push(permission);
			done(false);
		});
		session.defaultSession.setPermissionCheckHandler(() => false);
		session.defaultSession.webRequest.onBeforeRequest((details, done) => {
			const url = new URL(details.url);
			const allowed = ["file:", "data:", "blob:", "devtools:"].includes(url.protocol);
			if (!allowed) report.blocked.push(url.origin);
			done({ cancel: !allowed });
		});
		await import(pathToFileURL(builtMain).href);
		win = await wait("actual default App", () => BrowserWindow.getAllWindows()[0]);
		await wait("built renderer loaded", () => !win.webContents.isLoadingMainFrame());
		const js = async (code) => {
			try {
				return await win.webContents.executeJavaScript(code);
			} catch (error) {
				report.failedScript = code;
				throw error;
			}
		};
		const raw = (type, path, input = {}) =>
			js(`window.electron.trpc.request(${JSON.stringify({ type, path, input: { json: input } })})`);
		const rpc = async (...args) => {
			const result = await raw(...args);
			assert.ok(!result.error, `${args[1]}: ${JSON.stringify(result.error)}`);
			return result.result.data.json;
		};
		const click = (selector) =>
			js(
				`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Missing enabled control: '+${JSON.stringify(selector)});e.click();})()`
			);
		const step = async (label, work) => {
			const result = await work();
			report.steps.push({ label, passed: true, result });
			save();
			console.log(`TEAM_WORKSPACE_STEP_PASS: ${label}`);
			return result;
		};
		return {
			app,
			win,
			safeStorage,
			userData,
			envPath,
			fixture,
			provider,
			report,
			js,
			raw,
			rpc,
			click,
			step,
			stop,
			wait,
			pause,
		};
	} catch (error) {
		await stop(error);
		throw error;
	}
}
module.exports = { launch, wait, pause };
