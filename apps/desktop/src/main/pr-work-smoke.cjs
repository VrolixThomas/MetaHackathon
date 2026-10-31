// ROOT ONLY after building integration:
// env -u ELECTRON_RUN_AS_NODE electron src/main/pr-work-smoke.cjs [built-main]
// AUTHOR ONLY: node --check this-file; node this-file --self-check.
// Phase one: actual default App/IPC/native views, controlled GitHub/model and owned local Git.
// No live providers, physical microphone, fabricated app results or injected display receipts.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const { AsyncLocalStorage } = require("node:async_hooks");
const { randomUUID, createHash } = require("node:crypto");
const { tmpdir } = require("node:os");
const { join, resolve, dirname } = require("node:path");
const { pathToFileURL } = require("node:url");
const fixtureSupport = require("./pr-work-smoke-support.cjs");
const {
	repository,
	prId,
	prURL,
	apiRoot,
	modelURL,
	order,
	git,
	createRepository,
	modelResponse,
	githubGET,
	assertPOST,
} = fixtureSupport;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function wait(label, read, milliseconds = 25_000) {
	const until = Date.now() + milliseconds;
	while (Date.now() < until) {
		const value = await read();
		if (value) return value;
		await sleep(40);
	}
	throw new Error(`Timed out: ${label}`);
}
function scrubAmbientCredentials() {
	for (const key of Object.keys(process.env)) {
		if (
			/(?:TOKEN|SECRET|API_KEY|CLIENT_ID|VOICE_ID)/i.test(key) ||
			/^(?:SLACK_|LINEAR_|GITHUB_|GH_|META_|MODEL_|ELEVENLABS_|MUSE_)/.test(key)
		)
			delete process.env[key];
	}
}
async function native() {
	assert.ok(
		process.versions.electron && !process.env.ELECTRON_RENDERER_URL,
		"Root must launch built Electron; authors may run --self-check only"
	);
	const { app, BrowserWindow, ipcMain, webContents, session } = require("electron");
	const builtMain = resolve(process.argv[2] ?? join(__dirname, "../../out/main/index.js"));
	assert.ok(fs.existsSync(builtMain), "Root must build integration first");
	scrubAmbientCredentials();
	const owned = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "met-pr-work-smoke-")));
	const owner = randomUUID();
	fs.writeFileSync(join(owned, ".owner"), owner, { mode: 0o600 });
	const userData = join(owned, "profile");
	fs.mkdirSync(userData);
	app.setPath("userData", userData);
	const envPath = join(owned, ".env");
	fs.writeFileSync(
		envPath,
		"MODEL_API_KEY=controlled-pr-work-model-only\nGITHUB_TOKEN=controlled-pr-work-github-only\n",
		{ mode: 0o600 }
	);
	process.env.METAHACKATHON_ENV_FILE = envPath;
	const fixture = createRepository(owned);
	const out = join(__dirname, "../../out");
	fs.mkdirSync(out, { recursive: true });
	const reportPath = join(out, "pr-work-smoke-report.json");
	const readablePath = join(out, "pr-work-smoke-report.md");
	const screenshot = join(out, "pr-work-smoke-comment-dialog.png");
	const report = {
		status: "running",
		phase: "phase-one-comments-and-keyboard",
		controlledGitHub: true,
		controlledModel: true,
		actualRendererIPC: false,
		physicalMicrophone: false,
		liveProviders: false,
		fullProcessRestartTested: false,
		appOwnedFixWorktreeTested: false,
		fixPhase: "Pending root feedback and fix handoffs",
		builtMain,
		builtMainSha256: createHash("sha256").update(fs.readFileSync(builtMain)).digest("hex"),
		steps: [],
		ipc: [],
		github: [],
		posts: [],
		modelCalls: 0,
		localRequests: [],
		nativeVisibility: [],
		modalLeaks: [],
		blocked: [],
		permissionRequests: [],
	};
	const save = () => {
		fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
		fs.writeFileSync(
			readablePath,
			[
				"# Controlled PR work smoke",
				"",
				`Status: ${report.status}`,
				"",
				...report.steps.map((item) => `- ${item.status.toUpperCase()}: ${item.label}`),
				"",
				`Controlled GitHub POST count: ${report.posts.length}`,
				`Actual dialog screenshot: ${report.dialogScreenshot ?? "not captured"}`,
				`Built main SHA-256: ${report.builtMainSha256}`,
				"",
				"Scope: actual built App/IPC/source/native browser; fake provider responses and owned test Git only.",
				"No physical microphone, live provider or full process restart claim. PR fix/worktree phase is pending.",
				...(report.error ? ["", `Failure: ${report.error}`] : []),
				"",
			].join("\n")
		);
	};
	save();
	const trace = new AsyncLocalStorage();
	const originalHandle = ipcMain.handle;
	const forwardFetch = globalThis.fetch;
	const provider = {
		liveHead: fixture.headSha,
		mode: "normal",
		gateEntered: false,
		gateAborted: false,
	};
	let win;
	let guest;
	let view;
	let origin;
	let modalGuard = false;
	let stopping = false;
	let visibilityMonitor;
	let serverClosed;
	const server = http.createServer((request, response) => {
		report.localRequests.push({ method: request.method, path: request.url });
		if (request.method !== "GET" || !["/controlled", "/favicon.ico"].includes(request.url)) {
			response.writeHead(404);
			response.end();
			return;
		}
		if (request.url === "/favicon.ico") {
			response.writeHead(204);
			response.end();
			return;
		}
		response.writeHead(200, {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'",
		});
		response.end(
			"<!doctype html><html><head><title>CONTROLLED PR modal page</title></head><body><h1>CONTROLLED TEST ONLY</h1><p id='native-sentinel'>Actual loopback page. Never live product content.</p></body></html>"
		);
	});
	const closeServer = () => {
		serverClosed ??= new Promise((done) => {
			server.close(done);
			server.closeAllConnections();
		});
		return serverClosed;
	};
	const stop = async (error) => {
		if (stopping) return;
		stopping = true;
		if (error) {
			report.status = "failed";
			report.error = error.stack ?? String(error);
			if (win && !win.isDestroyed()) {
				try {
					fs.writeFileSync(
						join(out, "pr-work-smoke-failure.png"),
						(await win.webContents.capturePage()).toPNG()
					);
				} catch {
					/* Preserve original failure. */
				}
			}
		}
		save();
		await closeServer();
		app.quit();
	};
	// Pass every actual main IPC call/result through unchanged. Async context only correlates provider reads.
	ipcMain.handle = function (channel, handler) {
		if (channel !== "trpc:request") return originalHandle.call(this, channel, handler);
		return originalHandle.call(this, channel, (event, request) => {
			const path = request?.path;
			const input = request?.input?.json;
			const audited =
				path?.startsWith("prComments.") ||
				["workspace.prepare", "workspace.applied"].includes(path);
			const row = audited
				? { path, input: structuredClone(input), startedAt: new Date().toISOString() }
				: null;
			if (row) report.ipc.push(row);
			return trace.run({ path, input }, async () => {
				try {
					const result = await handler(event, request);
					if (row) {
						row.result = structuredClone(result);
						row.completed = true;
					}
					return result;
				} catch (error) {
					if (row) {
						row.error = error.message;
						row.completed = true;
					}
					throw error;
				}
			});
		});
	};
	globalThis.fetch = async (input, options = {}) => {
		const address = String(input.url ?? input);
		const url = new URL(address);
		const method = options.method ?? input.method ?? "GET";
		const context = trace.getStore();
		try {
			if (address === modelURL) {
				assert.equal(method, "POST");
				return modelResponse(JSON.parse(options.body), ++report.modelCalls);
			}
			if (url.origin === "https://api.github.com") {
				report.github.push({
					method,
					path: url.pathname,
					confirmation: context?.path === "prComments.confirm" ? context.input.requestId : null,
				});
				if (method === "POST") {
					assert.equal(context?.path, "prComments.confirm");
					const body = JSON.parse(options.body);
					assertPOST(address, body, context.input, fixture);
					assert.equal(report.posts.length, 0, "Only one controlled external POST is permitted");
					report.posts.push({ url: address, body, requestId: context.input.requestId });
					return Response.json({ id: 123, html_url: `${prURL}#discussion_r123` });
				}
				assert.equal(method, "GET");
				if (address === `${apiRoot}/pulls/7` && context?.path === "prComments.confirm") {
					if (provider.mode === "moved-head") provider.liveHead = fixture.movedSha;
					if (provider.mode === "cancel-preflight") {
						provider.gateEntered = true;
						const signal = options.signal ?? input.signal;
						assert.ok(signal, "Actual provider preflight must carry main cancellation");
						return new Promise((_resolveRead, reject) => {
							const timeout = setTimeout(
								() => reject(new Error("Controlled preflight was not cancelled")),
								10_000
							);
							const abort = () => {
								clearTimeout(timeout);
								provider.gateAborted = true;
								reject(new DOMException("Controlled provider preflight cancelled", "AbortError"));
							};
							if (signal.aborted) abort();
							else signal.addEventListener("abort", abort, { once: true });
						});
					}
				}
				return Response.json(githubGET(address, fixture, provider.liveHead));
			}
			if (origin && url.origin === origin)
				return forwardFetch(input, { ...options, redirect: "error" });
			throw new Error("External provider request forbidden by controlled smoke");
		} catch (error) {
			// Expected provider cancellation is not an unapproved network request.
			if (error.name !== "AbortError")
				report.blocked.push({ origin: url.origin, message: error.message });
			throw error;
		}
	};
	app.on("will-quit", () => {
		clearTimeout(timer);
		clearInterval(visibilityMonitor);
		globalThis.fetch = forwardFetch;
		ipcMain.handle = originalHandle;
		try {
			assert.equal(server.listening, false);
			assert.ok(!guest || guest.isDestroyed(), "Native guest survived app disposal");
			assert.equal(fs.readFileSync(join(owned, ".owner"), "utf8"), owner);
			fs.rmSync(owned, { recursive: true });
			report.cleanup = {
				ownedTempRemoved: !fs.existsSync(owned),
				serverClosed: true,
				guestDisposed: true,
			};
		} catch (error) {
			report.status = "failed";
			report.error = error.message;
		}
		save();
		console.log(`PR_WORK_SMOKE_${report.status.toUpperCase()}: ${reportPath}`);
		if (report.status !== "passed") app.exit(1);
	});
	const timer = setTimeout(
		() => void stop(new Error("PR work native smoke hard deadline")),
		180_000
	);
	try {
		await new Promise((done, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", done);
		});
		origin = `http://127.0.0.1:${server.address().port}`;
		await app.whenReady();
		session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
			report.permissionRequests.push(permission);
			callback(false);
		});
		session.defaultSession.setPermissionCheckHandler(() => false);
		session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
			const url = new URL(details.url);
			const allowed =
				["file:", "devtools:", "data:", "blob:"].includes(url.protocol) || url.origin === origin;
			if (!allowed) report.blocked.push({ origin: url.origin, chromium: true });
			callback({ cancel: !allowed });
		});
		await import(pathToFileURL(builtMain).href);
		win = await wait("actual main window", () => BrowserWindow.getAllWindows()[0]);
		await wait("built renderer loaded", () => !win.webContents.isLoadingMainFrame());
		const js = (code) => win.webContents.executeJavaScript(code);
		const raw = (type, path, input) =>
			js(
				`window.electron.trpc.request(${JSON.stringify({ type, path, input: { json: input ?? null } })})`
			);
		const rpc = async (type, path, input) => {
			const result = await raw(type, path, input);
			assert.ok(!result.error, `${path}: ${JSON.stringify(result.error)}`);
			return result.result.data.json;
		};
		const step = async (label, work) => {
			const row = { label, status: "running" };
			report.steps.push(row);
			save();
			try {
				row.evidence = await work();
				row.status = "passed";
				save();
			} catch (error) {
				row.status = "failed";
				save();
				throw error;
			}
		};
		const click = async (selector, label) =>
			js(`(() => {
			const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(label)});
			if(!e||e.disabled)throw new Error('Missing or disabled control: '+${JSON.stringify(label)});
			e.click();
		})()`);
		const field = (selector, value) =>
			js(`(() => {
			const e=document.querySelector(${JSON.stringify(selector)});
			if(!e||e.disabled)throw new Error('Missing editable field');
			Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});
			e.dispatchEvent(new Event('input',{bubbles:true}));
		})()`);
		const frames = () => js("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
		const reviewUI = () =>
			js(`(() => {const e=document.querySelector('[aria-label="Prepared review"]');
			return e?{path:e.dataset.reviewPath,reviewId:e.dataset.reviewId,headSha:e.dataset.headSha,baseSha:e.dataset.baseSha,loading:e.dataset.reviewLoading,progress:e.dataset.reviewProgressPath}:null;})()`);
		const settled = async (path) => {
			const state = await reviewUI();
			if (!state || state.path !== path || state.loading !== "false" || state.progress !== path)
				return null;
			const sessionId = await js(
				"document.querySelector('main[data-session-id]').dataset.sessionId"
			);
			const observation = await rpc("query", "workspace.observe", { sessionId });
			const sequence = await js(
				"Number(document.querySelector('.canvas-workspace').dataset.workspaceSequence)"
			);
			return observation.workspace.sequence === sequence &&
				observation.workspace.review.path === path
				? state
				: null;
		};
		const press = async (key) => {
			win.show();
			win.focus();
			win.webContents.focus();
			await wait("isolated app document focus", () => js("document.hasFocus()"));
			win.webContents.sendInputEvent({ type: "keyDown", keyCode: key.toUpperCase() });
			win.webContents.sendInputEvent({ type: "char", keyCode: key });
			win.webContents.sendInputEvent({ type: "keyUp", keyCode: key.toUpperCase() });
			await frames();
		};
		const bare = async (key, path) => {
			await js("document.activeElement?.blur()");
			await press(key);
			return wait(`acknowledged keyboard file ${path}`, () => settled(path));
		};
		const navigations = () =>
			report.ipc.filter(
				(row) => row.path === "workspace.prepare" && row.input?.command?.kind === "navigate-review"
			).length;
		const phase = (expected) =>
			wait(`comment phase ${expected}`, () =>
				js(
					`document.querySelector('.pr-comment-composer')?.dataset.commentPhase===${JSON.stringify(expected)}`
				)
			);
		const commentRows = (path) => report.ipc.filter((row) => row.path === path);
		const openComment = async () => {
			const label = await js(
				"[...document.querySelectorAll('.app-header button')].find(e=>/^(Add|View) PR comment$/.test(e.textContent.trim()))?.textContent.trim()"
			);
			await click(".app-header button", label);
			await wait("actual comment dialog open", () =>
				js("document.querySelector('#pr-comment-composer')?.open===true")
			);
			if (view) await wait("native page hidden before comment dialog", () => !view.getVisible());
			modalGuard = true;
		};
		const closeComment = async () => {
			modalGuard = false;
			await js(
				"document.querySelector('#pr-comment-composer .workspace-dialog-heading button').click()"
			);
			await wait("comment dialog removed", () =>
				js("!document.querySelector('#pr-comment-composer')")
			);
		};
		const openReview = async (expectedPath = order[0]) => {
			await js("document.querySelector('[data-testid=repository-selector]').click()");
			await wait("repository dialog open", () =>
				js("document.querySelector('#repository-selector')?.open===true")
			);
			await wait("actual ready inbox control", () =>
				js(
					`!!document.querySelector('[data-pr-id="${prId}"][data-review-status="ready"] button.review-inbox-select:not(:disabled)')`
				)
			);
			await js(
				`document.querySelector('[data-pr-id="${prId}"] button.review-inbox-select').click()`
			);
			return wait("manually opened prepared file", () => settled(expectedPath));
		};
		await step("Empty startup and isolated dummy configuration", async () => {
			const config = await rpc("query", "app.config");
			assert.equal(config.envPath, envPath);
			assert.equal(config.configured.github, true);
			assert.equal(config.configured.elevenlabs, false);
			assert.equal(config.voiceId, null);
			await wait("default Home", () =>
				js("document.querySelector('.hub-center')?.dataset.centerSection==='home'")
			);
			assert.equal(await reviewUI(), null);
			assert.equal(
				await js(
					"![...document.querySelectorAll('.app-header button')].some(e=>e.textContent.trim()==='Add PR comment')"
				),
				true
			);
			return { configuredDummyEnv: true, emptyReview: true };
		});
		let ready;
		await step("Prepare real local source and manually open its PR", async () => {
			await rpc("mutation", "reviews.connect", { repository, localPath: fixture.localPath });
			ready = await wait("real ready review", async () => {
				const inbox = await rpc("query", "reviews.inbox");
				const item = inbox.items.find((entry) => entry.pr.id === prId);
				assert.notEqual(item?.status, "error", item?.error);
				return item?.status === "ready" ? item : null;
			});
			assert.deepEqual(
				ready.prepared.files.map((entry) => entry.path),
				order
			);
			const ui = await openReview();
			assert.equal(ui.headSha, fixture.headSha);
			assert.equal(ui.baseSha, fixture.baseSha);
			return ui;
		});
		await step("Actual j/k file navigation and clamped endpoints", async () => {
			await bare("j", order[1]);
			await bare("j", order[2]);
			let before = navigations();
			await bare("j", order[2]);
			assert.equal(navigations(), before);
			await bare("k", order[1]);
			await bare("k", order[0]);
			before = navigations();
			await bare("k", order[0]);
			assert.equal(navigations(), before);
			await bare("j", order[1]);
			return { actualPreparedOrder: order, endpointsDoNotIssueCommands: true };
		});
		await step("Actual loopback native page beside the prepared review", async () => {
			await js("document.querySelector('[data-testid=workspace-more]').click()");
			await wait("workspace options", () =>
				js("document.querySelector('#workspace-more')?.open===true")
			);
			await js("document.querySelector('[data-testid=local-preview-toggle]').click()");
			await wait("local URL dialog", () =>
				js("document.querySelector('#local-preview-prompt')?.open===true")
			);
			await field("input[name=local-preview-url]", `${origin}/controlled`);
			await js("document.querySelector('input[name=local-preview-url]').form.requestSubmit()");
			guest = await wait("real native guest", () =>
				webContents
					.getAllWebContents()
					.find((item) => !item.isDestroyed() && item.getURL() === `${origin}/controlled`)
			);
			await wait("browser canvas accepted before changing its layout", async () => {
				const sessionId = await js(
					"document.querySelector('main[data-session-id]').dataset.sessionId"
				);
				const { workspace } = await rpc("query", "workspace.observe", { sessionId });
				return (
					workspace.primaryId === "browser" &&
					workspace.browser?.url === `${origin}/controlled` &&
					(await js(
						"document.querySelector('.canvas-workspace')?.getAttribute('aria-busy')==='false'"
					))
				);
			});
			await wait("Code tab beside control", () =>
				js(
					"document.querySelector('.canvas-tab-kind[title=Code]')?.closest('.canvas-tab').querySelector('[aria-label^=Show]')?.disabled===false"
				)
			);
			await js(
				"document.querySelector('.canvas-tab-kind[title=Code]').closest('.canvas-tab').querySelector('[aria-label^=Show]').click()"
			);
			await wait("review and page settled", () => settled(order[1]));
			view = await wait("attached actual WebContentsView", () =>
				win.contentView.children.find((item) => item.webContents?.id === guest.id)
			);
			await wait("native guest visibly presented by app", () => view.getVisible());
			assert.equal(
				await guest.executeJavaScript("document.querySelector('#native-sentinel').textContent"),
				"Actual loopback page. Never live product content."
			);
			const setVisible = view.setVisible;
			view.setVisible = function (visible) {
				report.nativeVisibility.push({ visible, modalGuard, at: Date.now() });
				if (visible && modalGuard) report.modalLeaks.push({ visible, at: Date.now() });
				return setVisible.call(this, visible);
			};
			visibilityMonitor = setInterval(() => {
				if (modalGuard && !guest.isDestroyed() && view.getVisible())
					report.modalLeaks.push({ observed: true, at: Date.now() });
			}, 10);
			return { guestId: guest.id, mainId: win.webContents.id, actualPage: true };
		});
		let draft;
		const originalBody = "CONTROLLED TEST ONLY: <review words>\nExact initial body: ";
		const finalBody =
			"  CONTROLLED TEST ONLY: <review words>\nExact edited body. j/k remain text.  ";
		await step(
			"Typing j/k, exact draft/edit, unchecked consent and native modal resize",
			async () => {
				await openComment();
				await phase("compose");
				await field("#pr-comment-body", originalBody);
				await js(
					"document.querySelector('#pr-comment-body').focus();document.querySelector('#pr-comment-body').setSelectionRange(9999,9999)"
				);
				const before = navigations();
				await press("j");
				await press("k");
				assert.equal(
					await js("document.querySelector('#pr-comment-body').value"),
					`${originalBody}jk`
				);
				assert.equal(navigations(), before);
				assert.equal((await reviewUI()).path, order[1]);
				await field("#pr-comment-line", "2");
				await frames();
				await click("#pr-comment-composer button", "Review comment");
				await phase("review");
				const initial = commentRows("prComments.create").at(-1);
				assert.ok(initial.completed && !initial.result.error);
				const saved = initial.result.result.data.json;
				assert.equal(saved.originalWords, `${originalBody}jk`);
				assert.equal(saved.body, `${originalBody}jk`);
				assert.equal(saved.headSha, fixture.headSha);
				assert.equal(saved.location.path, order[1]);
				assert.equal(saved.location.startLine, 2);
				assert.equal(saved.location.endLine, 2);
				assert.equal(saved.evidence.kind, "source");
				await click("#pr-comment-composer button", "Edit comment");
				await phase("compose");
				await field("#pr-comment-body", finalBody);
				await frames();
				await click("#pr-comment-composer button", "Review comment");
				await phase("review");
				draft = commentRows("prComments.edit").at(-1).result.result.data.json;
				assert.equal(draft.id, saved.id);
				assert.equal(draft.revision, saved.revision + 1);
				assert.equal(draft.originalWords, saved.originalWords);
				assert.equal(draft.body, finalBody);
				assert.equal(
					await js("document.querySelector('.pr-comment-exact').textContent"),
					finalBody
				);
				assert.equal(
					await js("document.querySelector('.pr-comment-consent input').checked"),
					false
				);
				assert.equal(
					await js(
						"[...document.querySelectorAll('#pr-comment-composer button')].find(e=>e.textContent==='Post comment to GitHub').disabled"
					),
					true
				);
				await js(
					"[...document.querySelectorAll('#pr-comment-composer button')].find(e=>e.textContent==='Post comment to GitHub').click()"
				);
				await frames();
				assert.equal(commentRows("prComments.confirm").length, 0);
				assert.equal(report.posts.length, 0);
				const size = win.getContentBounds();
				for (const [width, height] of [
					[Math.max(1000, size.width - 100), Math.max(700, size.height - 70)],
					[size.width, size.height],
				]) {
					win.setContentSize(width, height);
					await frames();
					await sleep(100);
					assert.equal(view.getVisible(), false);
					assert.equal(await js("document.querySelector('#pr-comment-composer').open"), true);
				}
				assert.deepEqual(report.modalLeaks, []);
				fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
				report.dialogScreenshot = screenshot;
				return {
					draftId: draft.id,
					revision: draft.revision,
					headSha: draft.headSha,
					exactBody: finalBody,
					uncheckedConsent: true,
					postsBeforeConfirmation: 0,
					nativeHiddenThroughResize: true,
					screenshot,
				};
			}
		);
		await step(
			"Explicit UI confirmation posts once to exact PR with durable stable request identity",
			async () => {
				await js("document.querySelector('.pr-comment-consent input').click()");
				await frames();
				await click("#pr-comment-composer button", "Post comment to GitHub");
				await phase("posted");
				assert.equal(report.posts.length, 1);
				const confirmation = commentRows("prComments.confirm").at(-1);
				assert.equal(confirmation.input.draftId, draft.id);
				assert.equal(confirmation.input.draftRevision, draft.revision);
				assert.equal(confirmation.input.body, finalBody);
				assert.equal(confirmation.input.headSha, fixture.headSha);
				assert.equal(report.posts[0].requestId, confirmation.input.requestId);
				assert.deepEqual(await rpc("mutation", "prComments.confirm", confirmation.input), {
					url: `${prURL}#discussion_r123`,
				});
				assert.equal(report.posts.length, 1);
				const Database = require("better-sqlite3");
				const database = new Database(join(userData, "metahackathon.db"), { readonly: true });
				let rows;
				try {
					rows = database
						.prepare("SELECT request_id, signature, result_json FROM runtime_submissions")
						.all();
				} finally {
					database.close();
				}
				assert.equal(rows.length, 1);
				assert.equal(rows[0].request_id, confirmation.input.requestId);
				assert.match(rows[0].signature, /^[a-f0-9]{64}$/);
				assert.equal(JSON.parse(rows[0].result_json).url, `${prURL}#discussion_r123`);
				await closeComment();
				await wait("native page restored after modal", () => view.getVisible());
				return {
					requestId: confirmation.input.requestId,
					url: `${prURL}#discussion_r123`,
					ledger: rows,
					postCount: 1,
				};
			}
		);
		await step(
			"UI cancellation aborts actual provider preflight without a second POST",
			async () => {
				await openComment();
				await click("#pr-comment-composer button", "Write another comment");
				await phase("compose");
				await field("#pr-comment-body", "CONTROLLED TEST ONLY: cancelled before write");
				await field("#pr-comment-line", "2");
				await frames();
				await click("#pr-comment-composer button", "Review comment");
				await phase("review");
				provider.mode = "cancel-preflight";
				await js("document.querySelector('.pr-comment-consent input').click()");
				await frames();
				await click("#pr-comment-composer button", "Post comment to GitHub");
				await wait("actual confirmation provider gate", () => provider.gateEntered);
				const confirmation = commentRows("prComments.confirm").at(-1);
				await closeComment();
				await wait("main cancellation reaches provider signal", () => provider.gateAborted);
				await wait("actual confirm rejection", () => confirmation.completed);
				assert.ok(confirmation.result?.error || confirmation.error);
				assert.ok(
					commentRows("prComments.cancel").some(
						(entry) => entry.input.requestId === confirmation.input.requestId
					)
				);
				assert.equal(report.posts.length, 1);
				provider.mode = "normal";
				await openComment();
				await phase("uncertain");
				await closeComment();
				return {
					requestId: confirmation.input.requestId,
					providerSignalAborted: true,
					noAdditionalPOST: true,
					closeReopenRetainsAttempt: true,
				};
			}
		);
		await step(
			"Fresh head change rejects actual UI confirmation before any extra POST",
			async () => {
				modalGuard = false;
				const loaded = new Promise((done) => win.webContents.once("did-finish-load", done));
				win.webContents.reload();
				await loaded;
				await wait("new real renderer startup", () =>
					js("!!document.querySelector('[data-testid=repository-selector]')")
				);
				await openReview(order[1]);
				await openComment();
				await phase("compose");
				await field("#pr-comment-body", "CONTROLLED TEST ONLY: stale head must not post");
				await field("#pr-comment-line", "2");
				await frames();
				await click("#pr-comment-composer button", "Review comment");
				await phase("review");
				provider.mode = "moved-head";
				await js("document.querySelector('.pr-comment-consent input').click()");
				await frames();
				await click("#pr-comment-composer button", "Post comment to GitHub");
				await phase("uncertain");
				const confirmation = commentRows("prComments.confirm").at(-1);
				await wait("stale main request completed", () => confirmation.completed);
				assert.equal(provider.liveHead, fixture.movedSha);
				assert.ok(confirmation.result?.error || confirmation.error);
				assert.equal(report.posts.length, 1);
				return {
					rejectedHead: fixture.headSha,
					currentHead: fixture.movedSha,
					noAdditionalPOST: true,
					rendererReloadOnly: true,
				};
			}
		);
		assert.deepEqual(report.modalLeaks, []);
		assert.deepEqual(report.blocked, []);
		assert.equal(fs.readFileSync(join(fixture.localPath, "a-logic.ts"), "utf8"), fixture.dirty);
		assert.equal(git(fixture.localPath, "status", "--porcelain=v1"), fixture.status);
		assert.equal(git(fixture.localPath, "rev-parse", "HEAD").trim(), fixture.headSha);
		report.originalDirtyPreserved = true;
		report.actualRendererIPC = true;
		report.status = "passed";
		await stop();
	} catch (error) {
		await stop(error);
	}
}
async function selfCheck() {
	const fixture = {
		baseSha: "a".repeat(40),
		headSha: "b".repeat(40),
		movedSha: "c".repeat(40),
		filesAt: {},
	};
	assert.deepEqual(
		fixtureSupport.analysis().files.map((entry) => entry.path),
		order
	);
	assert.notDeepEqual(order, [...order].sort());
	assert.equal(githubGET(`${apiRoot}/pulls/7`, fixture, fixture.headSha).head.sha, fixture.headSha);
	assert.throws(() => githubGET("https://attacker.test/user", fixture, fixture.headSha));
	assert.throws(() =>
		githubGET("https://api.github.com/repos/unrelated/repo", fixture, fixture.headSha)
	);
	const confirmation = {
		requestId: "controlled-confirm",
		confirmed: true,
		body: "Exact controlled body",
	};
	const body = {
		body: confirmation.body,
		commit_id: fixture.headSha,
		path: order[1],
		line: 2,
		side: "RIGHT",
	};
	assertPOST(`${apiRoot}/pulls/7/comments`, body, confirmation, fixture);
	assert.throws(() => assertPOST(`${apiRoot}/pulls/8/comments`, body, confirmation, fixture));
	assert.throws(() =>
		assertPOST(`${apiRoot}/pulls/7/comments`, { ...body, body: "changed" }, confirmation, fixture)
	);
	assert.throws(() =>
		assertPOST(`${apiRoot}/pulls/7/comments`, { ...body, side: "LEFT" }, confirmation, fixture)
	);
	const response = modelResponse(
		{
			stream: true,
			store: false,
			model: "controlled-only",
			tools: [{ name: "submit_prepared_review" }],
		},
		1
	);
	assert.ok((await response.text()).includes('"submit_prepared_review"'));
	assert.throws(() => modelResponse({ stream: true, store: false, tools: [] }, 2));
	console.log(
		"PR_WORK_SELF_CHECK_PASS: pure endpoint/POST identity/model protocol guards only; NO Electron/Git/server/SQLite/provider/network/microphone launched"
	);
}
if (
	require.main === module ||
	(process.versions.electron && process.argv[1] && resolve(process.argv[1]) === resolve(__filename))
) {
	(process.argv.includes("--self-check") ? selfCheck() : native()).catch((error) => {
		console.error(error.stack ?? error.message);
		process.exitCode = 1;
	});
}
