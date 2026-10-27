// ROOT ONLY after build: env -u ELECTRON_RUN_AS_NODE electron src/main/local-browser-smoke.cjs
// Optional LOCAL_BROWSER_SMOKE_HOLD_MS=60000 leaves the successful page visible for root QA.
// Worker: node --check this-file; node this-file --self-check. No Electron/server launch.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const { randomUUID } = require("node:crypto");
const { tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const desktop = { width: 1024, height: 768 };
const phone = { width: 390, height: 844 };
const external = "https://blocked.invalid/local-browser-smoke";
const escapeHTML = (value) =>
	String(value).replace(
		/[&<>"']/g,
		(character) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]
	);
const serialize = (input) =>
	input === undefined ? { json: null, meta: { values: ["undefined"], v: 1 } } : { json: input };

function page(path, message, serial) {
	assert.ok(["/one", "/two"].includes(path));
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Owned local page ${path === "/one" ? "one" : "two"}</title><style>
*{box-sizing:border-box}body{margin:0;background:#edf1f5;color:#152532;font:17px system-ui}main{padding:28px;max-width:1100px;margin:auto}
nav{display:flex;gap:24px}a{color:#1558b0}h1{font-size:32px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:24px}
section{background:white;border:1px solid #b8c6d1;border-radius:12px;padding:24px}input,button{font:inherit;padding:12px;margin-top:12px;max-width:100%}
label,input{display:block}button{background:#143b5b;color:white;border:0;border-radius:6px}#layout:after{content:'desktop'}
@media(max-width:600px){.grid{grid-template-columns:1fr}#layout:after{content:'phone'}main{padding:18px}h1{font-size:26px}}
</style></head><body><main><nav><a id="one" href="/one">Page one</a><a id="two" href="/two">Page two</a></nav>
<h1>Native local browser acceptance</h1><p id="page">${escapeHTML(path)}</p><p>Responsive layout: <strong id="layout"></strong></p>
<div class="grid"><section><h2>Real form navigation</h2><form method="get" action="/two"><label>Message<input id="message" name="message" value="${escapeHTML(message)}"></label><button id="send" type="submit">Send to page two</button></form></section>
<section><h2>Server response</h2><p id="echo">${escapeHTML(message)}</p><p>Page load <output id="serial">${serial}</output></p><p>Controlled test site. No model, PR, payment or microphone.</p></section></div>
<p><a id="external" href="${external}">Blocked external navigation probe</a></p></main></body></html>`;
}
function expectedBounds(bounds, viewport, host) {
	const x = Math.max(0, Math.min(bounds.x, host.width));
	const y = Math.max(0, Math.min(bounds.y, host.height));
	const width = Math.min(bounds.width, Math.max(0, host.width - x));
	const height = Math.min(bounds.height, Math.max(0, host.height - y));
	const scale = Math.min(1, width / viewport.width, height / viewport.height);
	return {
		x: Math.round(x),
		y: Math.round(y),
		width: Math.max(1, Math.floor(viewport.width * scale)),
		height: Math.max(1, Math.floor(viewport.height * scale)),
	};
}
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function wait(label, read, timeout = 20_000) {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		const value = await read();
		if (value) return value;
		await pause(30);
	}
	throw new Error(`Timed out waiting for ${label}`);
}
const domScript = `(() => ({ url:location.href,title:document.title,viewport:{width:innerWidth,height:innerHeight},
	path:document.querySelector('#page')?.textContent,echo:document.querySelector('#echo')?.textContent,
	serial:Number(document.querySelector('#serial')?.textContent),value:document.querySelector('#message')?.value,
	sentinel:sessionStorage.getItem('local-smoke'),layout:getComputedStyle(document.querySelector('#layout'),'::after').content.replaceAll('"',''),
	columns:getComputedStyle(document.querySelector('.grid')).gridTemplateColumns.split(' ').length }))()`;

async function native() {
	const { app, BrowserWindow, webContents } = require("electron");
	assert.ok(
		process.versions.electron && !process.env.ELECTRON_RENDERER_URL,
		"Root must launch the actual built Electron app"
	);
	const holdMs = Number(process.env.LOCAL_BROWSER_SMOKE_HOLD_MS ?? 0);
	assert.ok(Number.isInteger(holdMs) && holdMs >= 0 && holdMs <= 60_000);
	const owned = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "met-local-browser-smoke-")));
	const owner = randomUUID();
	const envPath = join(owned, ".env");
	fs.writeFileSync(join(owned, ".owner"), owner, { mode: 0o600 });
	fs.writeFileSync(envPath, "MODEL_API_KEY=local-browser-smoke-unused-dummy\n", { mode: 0o600 });
	process.env.METAHACKATHON_ENV_FILE = envPath;
	app.setPath("userData", owned);
	const reportPath = join(__dirname, "../../out/local-browser-smoke-report.json");
	fs.mkdirSync(dirname(reportPath), { recursive: true });
	const report = {
		status: "running",
		controlledSite: true,
		liveProviders: false,
		liveSpeech: false,
		actualRendererIPC: false,
		steps: [],
		requests: [],
		blockedMainRequests: [],
	};
	const save = () => fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
	save();
	const forwardFetch = globalThis.fetch;
	globalThis.fetch = (input, options = {}) => {
		const url = new URL(String(input.url ?? input));
		if (
			url.protocol === "http:" &&
			!url.username &&
			!url.password &&
			["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
		)
			return forwardFetch(input, { ...options, redirect: "error" });
		report.blockedMainRequests.push(url.origin);
		return Promise.reject(new Error("Local browser smoke forbids provider/external requests"));
	};
	let serial = 0;
	const server = http.createServer((request, response) => {
		const url = new URL(request.url, "http://127.0.0.1");
		report.requests.push({ method: request.method, path: request.url });
		if (request.method !== "GET") {
			response.writeHead(405);
			response.end();
			return;
		}
		if (url.pathname === "/favicon.ico") {
			response.writeHead(204);
			response.end();
			return;
		}
		if (!["/one", "/two"].includes(url.pathname)) {
			response.writeHead(404);
			response.end();
			return;
		}
		response.writeHead(200, {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"content-security-policy":
				"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
		});
		response.end(page(url.pathname, url.searchParams.get("message") ?? "", ++serial));
	});
	let closing;
	const closeServer = () => {
		closing ??= new Promise((done) => {
			server.close(() => done());
			server.closeAllConnections();
		});
		return closing;
	};
	let finalGuest;
	const fail = async (error) => {
		report.status = "failed";
		report.error = String(error.message);
		save();
		await closeServer();
		app.quit();
	};
	const deadline = setTimeout(
		() => void fail(new Error("Local browser native smoke hard deadline")),
		120_000 + holdMs
	);
	try {
		await new Promise((done, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", done);
		});
		const origin = `http://127.0.0.1:${server.address().port}`;
		report.origin = origin;
		await import(
			pathToFileURL(resolve(process.argv[2] ?? join(__dirname, "../../out/main/index.js"))).href
		);
		await app.whenReady();
		app.on("will-quit", () => {
			clearTimeout(deadline);
			try {
				assert.ok(
					!finalGuest || finalGuest.isDestroyed(),
					"Reopened guest survived application disposal"
				);
				assert.equal(server.listening, false, "Owned test server was not closed");
				assert.equal(fs.readFileSync(join(owned, ".owner"), "utf8"), owner);
				fs.rmSync(owned, { recursive: true });
				report.cleanup = {
					guestDisposed: true,
					ownedServerClosed: true,
					ownedTempRemoved: !fs.existsSync(owned),
				};
			} catch (error) {
				report.status = "failed";
				report.error = error.message;
			}
			save();
			console.log(`LOCAL_BROWSER_SMOKE_${report.status.toUpperCase()}: ${reportPath}`);
			if (report.status !== "passed") app.exit(1);
		});
		const win = await wait("main window", () => BrowserWindow.getAllWindows()[0]);
		await wait("built renderer", () => !win.webContents.isLoadingMainFrame());
		const js = (code) => win.webContents.executeJavaScript(code);
		const raw = (type, path, input) =>
			js(
				`window.electron.trpc.request(${JSON.stringify({ type, path, input: serialize(input) })})`
			);
		const rpc = async (type, path, input) => {
			const result = await raw(type, path, input);
			assert.ok(!result.error, `${path}: ${JSON.stringify(result.error)}`);
			return result.result.data.json;
		};
		const state = () => rpc("query", "localBrowser.state");
		const command = (input) => rpc("mutation", "localBrowser.command", input);
		const hostBounds = () =>
			js(
				`(() => { const e=document.querySelector('[data-native-browser-content="true"]'); if(!e) return null; const b=e.getBoundingClientRect(); return b.width>0 && b.height>0 ? {x:Math.round(b.x),y:Math.round(b.y),width:Math.floor(b.width),height:Math.floor(b.height)} : null; })()`
			);
		const guestAtOrigin = () =>
			webContents
				.getAllWebContents()
				.filter(
					(contents) => !contents.isDestroyed() && contents.getURL().startsWith(`${origin}/`)
				);
		const config = await rpc("query", "app.config");
		assert.equal(config.envPath, envPath);
		assert.equal(config.configured.elevenlabs, false);
		assert.equal(config.voiceId, null);
		assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
		assert.equal(await state(), null);
		await wait("local preview toggle", () =>
			js(`!!document.querySelector('[data-testid="local-preview-toggle"]')`)
		);
		await js(`document.querySelector('[data-testid="local-preview-toggle"]').click()`);
		await wait("local URL form", () =>
			js(`!!document.querySelector('input[name="local-preview-url"]')`)
		);
		await js(
			`(() => { const e=document.querySelector('input[name="local-preview-url"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(`${origin}/one`)}); e.dispatchEvent(new Event('input',{bubbles:true})); })()`
		);
		await js(`document.querySelector('input[name="local-preview-url"]').form.requestSubmit()`);
		await wait("opened real page", async () => (await state())?.url === `${origin}/one`);
		const bounds = await wait("renderer native surface reservation", hostBounds);
		await rpc("mutation", "localBrowser.present", { bounds, viewport: desktop });
		assert.equal(guestAtOrigin().length, 1);
		const guest = guestAtOrigin()[0];
		const guestId = guest.id;
		assert.notEqual(guestId, win.webContents.id);
		const view = win.contentView.children.find((child) => child.webContents?.id === guestId);
		assert.ok(view, "Guest must be attached to the actual main native view");
		await guest.executeJavaScript(`sessionStorage.setItem('local-smoke',${JSON.stringify(owner)})`);
		const inspect = async (label, viewport = desktop, visible = true) => {
			const observed = await state();
			const dom = await guest.executeJavaScript(domScript);
			assert.equal(guestAtOrigin().length, 1);
			assert.equal(guestAtOrigin()[0].id, guestId);
			assert.equal(observed.provenance, "local-preview-unverified-revision");
			assert.equal(observed.url, dom.url);
			assert.equal(observed.title, dom.title);
			assert.deepEqual(observed.viewport, viewport);
			assert.deepEqual(dom.viewport, viewport);
			assert.equal(dom.sentinel, owner);
			assert.equal(dom.layout, viewport.width < 600 ? "phone" : "desktop");
			assert.equal(dom.columns, viewport.width < 600 ? 1 : 2);
			assert.equal(observed.canGoBack, guest.navigationHistory.canGoBack());
			assert.equal(observed.canGoForward, guest.navigationHistory.canGoForward());
			assert.equal(view.getVisible(), visible);
			if (visible)
				assert.deepEqual(
					view.getBounds(),
					expectedBounds(await hostBounds(), viewport, win.getContentBounds())
				);
			const result = {
				label,
				observed,
				dom,
				webContentsId: guestId,
				nativeBounds: view.getBounds(),
				visible,
			};
			report.steps.push(result);
			save();
			return result;
		};
		const first = await inspect("open desktop");
		assert.equal(first.dom.path, "/one");
		const preferences = guest.getLastWebPreferences();
		assert.equal(preferences.sandbox, true);
		assert.equal(preferences.contextIsolation, true);
		assert.equal(preferences.nodeIntegration, false);
		await guest.executeJavaScript("document.querySelector('#two').click()");
		await wait(
			"real linked-page navigation",
			() => !guest.isLoadingMainFrame() && guest.getURL() === `${origin}/two`
		);
		assert.equal((await inspect("real link")).dom.path, "/two");
		assert.equal((await command({ kind: "back" })).url, `${origin}/one`);
		assert.equal((await inspect("back")).observed.canGoForward, true);
		assert.equal((await command({ kind: "forward" })).url, `${origin}/two`);
		await inspect("forward");
		assert.equal(
			(await command({ kind: "navigate", url: `${origin}/one?via=ipc` })).url,
			`${origin}/one?via=ipc`
		);
		await inspect("navigate IPC");
		await guest.executeJavaScript(
			`(() => { const e=document.querySelector('#message'); e.value='native & safe'; e.dispatchEvent(new Event('input',{bubbles:true})); e.form.requestSubmit(); })()`
		);
		await wait(
			"actual form response",
			() =>
				!guest.isLoadingMainFrame() &&
				new URL(guest.getURL()).searchParams.get("message") === "native & safe"
		);
		const submitted = await inspect("real form submit");
		assert.equal(submitted.dom.echo, "native & safe");
		await command({ kind: "reload" });
		const reloaded = await inspect("reload");
		assert.ok(reloaded.dom.serial > submitted.dom.serial, "Reload must fetch new server bytes");
		assert.equal(reloaded.dom.echo, "native & safe");
		await rpc("mutation", "localBrowser.present", { bounds: await hostBounds(), viewport: phone });
		await inspect("phone", phone);
		await guest.executeJavaScript(
			"document.querySelector('#message').value='preserved unsubmitted draft'"
		);
		await rpc("mutation", "localBrowser.present", { bounds: null });
		const hidden = await inspect("hidden", phone, false);
		assert.equal(hidden.dom.value, "preserved unsubmitted draft");
		await rpc("mutation", "localBrowser.present", { bounds: await hostBounds() });
		const shown = await inspect("shown", phone);
		assert.equal(shown.dom.value, hidden.dom.value);
		assert.equal(shown.dom.serial, hidden.dom.serial);
		await rpc("mutation", "localBrowser.present", {
			bounds: await hostBounds(),
			viewport: desktop,
		});
		await inspect("desktop restored");
		const rejected = await raw("mutation", "localBrowser.command", {
			kind: "navigate",
			url: external,
		});
		assert.ok(rejected.error, "RPC must reject a nonlocal URL");
		let navigation;
		const onNavigate = (event, url) => {
			navigation = { url, prevented: event.defaultPrevented };
		};
		guest.once("will-navigate", onNavigate);
		await guest.executeJavaScript("document.querySelector('#external').click()");
		await wait("blocked page-origin external link", () => navigation);
		assert.equal(navigation.url, external);
		assert.equal(navigation.prevented, true);
		assert.equal(guest.getURL(), reloaded.dom.url);
		let networkError;
		try {
			await guest.session.fetch(external, { signal: AbortSignal.timeout(5000) });
		} catch (error) {
			networkError = error.message;
		}
		assert.match(
			networkError ?? "",
			/ERR_BLOCKED_BY_CLIENT/,
			"Native session must block the request, not merely fail DNS"
		);
		report.externalPolicy = { navigationPrevented: true, sessionBlocked: true, networkError };
		assert.deepEqual(report.blockedMainRequests, []);
		if (holdMs) {
			report.holdForRootQA = { milliseconds: holdMs, status: "pre-close checks passed" };
			save();
			console.log(
				`LOCAL_BROWSER_SMOKE_HOLD: ${holdMs}ms; root may use computer-use, no screenshots taken by harness`
			);
			await pause(holdMs);
		}
		await rpc("mutation", "localBrowser.close");
		assert.equal(await state(), null);
		await wait("explicit guest destruction", () => guest.isDestroyed());
		assert.ok(!win.contentView.children.includes(view));
		assert.equal(server.listening, true);
		report.explicitClose = { stateNull: true, guestDestroyed: true, viewDetached: true };
		await rpc("mutation", "localBrowser.open", { url: `${origin}/one` });
		await rpc("mutation", "localBrowser.present", { bounds, viewport: desktop });
		assert.equal(guestAtOrigin().length, 1);
		finalGuest = guestAtOrigin()[0];
		assert.notEqual(finalGuest.id, guestId);
		assert.equal(
			await finalGuest.executeJavaScript("sessionStorage.getItem('local-smoke')"),
			null,
			"Reopen must use a fresh isolated page"
		);
		report.disposalGuestId = finalGuest.id;
		report.actualRendererIPC = true;
		report.status = "passed";
		await closeServer();
		save();
		app.quit();
	} catch (error) {
		await fail(error);
	}
}

function selfCheck() {
	const one = page("/one", "<script>&'\"", 9);
	const two = page("/two", "reply", 10);
	assert.ok(
		one.includes('href="/two"') &&
			two.includes('href="/one"') &&
			one.includes('method="get" action="/two"')
	);
	assert.ok(one.includes("@media(max-width:600px)"));
	assert.ok(!one.includes("<script>"));
	assert.ok(one.includes("&lt;script&gt;&amp;"));
	assert.deepEqual(
		expectedBounds({ x: 20, y: 100, width: 640, height: 480 }, desktop, {
			width: 1440,
			height: 900,
		}),
		{ x: 20, y: 100, width: 640, height: 480 }
	);
	const narrow = expectedBounds({ x: 20, y: 100, width: 640, height: 480 }, phone, {
		width: 1440,
		height: 900,
	});
	assert.equal(narrow.width, Math.floor((390 * 480) / 844));
	assert.equal(narrow.height, 480);
	assert.deepEqual(serialize(undefined), { json: null, meta: { values: ["undefined"], v: 1 } });
	assert.deepEqual(serialize({ bounds: null }), { json: { bounds: null } });
	console.log(
		"LOCAL_BROWSER_SELF_CHECK_PASS: linked/form pages, escaping, responsive CSS, native bounds, IPC void envelope; no server/Electron/network launched"
	);
}
if (process.argv.includes("--self-check")) selfCheck();
else if (process.versions.electron || require.main === module)
	native().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
