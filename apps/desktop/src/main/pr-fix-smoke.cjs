// ROOT ONLY after integrated build:
// env -u ELECTRON_RUN_AS_NODE electron src/main/pr-fix-smoke.cjs [built-main]
// AUTHOR: node --check this-file; node this-file --self-check. No native/child launch by author.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const cp = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { syncBuiltinESMExports } = require("node:module");
const { tmpdir } = require("node:os");
const { basename, dirname, join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const S = require("./pr-fix-smoke-support.cjs");
const dataOf = (response) => response?.result?.data?.json;
async function wait(label, read, timeout = 45000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const value = await read();
		if (value) return value;
		await new Promise((done) => setTimeout(done, 40));
	}
	throw new Error(`Timed out waiting for ${label}`);
}
// Observe existing app RAF callbacks only. No frames are requested by this observer.
const observer = `(() => {
	const visible = e => !!e && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0 && getComputedStyle(e).visibility !== 'hidden';
	const read = () => {
		const canvas=document.querySelector('.canvas-workspace[data-workspace-sequence]');
		const e=[...document.querySelectorAll('.pr-fix-review')].find(visible);
		const m=document.querySelector('main.conversation-main'), exchange=[...document.querySelectorAll('article.exchange')].at(-1);
		return {sequence:canvas?Number(canvas.dataset.workspaceSequence):null,id:e?.dataset.prFixId??e?.dataset.prFixStatusId??null,
			path:e?.dataset.prFixPath??'',head:e?.dataset.prFixHead??null,base:e?.dataset.prFixBase??null,visible:visible(e),
			feedback:e?.querySelector('.pr-fix-original')?.textContent??null,
			conversation:{sessionId:m?.dataset.sessionId,turnId:m?.dataset.turnId,generation:Number(m?.dataset.generation),phase:exchange?.dataset.phase,answer:exchange?.querySelector('.assistant-message p')?.textContent??''},
			rows:[...(e?.querySelectorAll('.hub-diff-row')??[])].map(r=>r.lastElementChild.textContent),
			source:e?.querySelector('[data-source-sha]')?{sha:e.querySelector('[data-source-sha]').dataset.sourceSha,path:e.querySelector('[data-source-sha]').dataset.sourcePath,text:[...e.querySelectorAll('.hub-source-text')].map(r=>r.textContent).join('')}:null};
	};
	const audit={frames:[],read}; window.__prFixSmoke=audit;
	const original=window.requestAnimationFrame;
	window.requestAnimationFrame=function(callback){const scheduledSequence=read().sequence;return original.call(window,timestamp=>{
		audit.frames.push({...read(),at:Date.now(),timestamp,scheduledSequence});if(audit.frames.length>300)audit.frames.shift();return callback(timestamp);
	});};
	return true;
})()`;
function freshStore(profile) {
	const path = join(profile, "work", "pr-fixes", S.sha256(JSON.stringify(S.VIEWER)), "fixes.json");
	const file = fs.openSync(path, "r");
	try {
		assert.equal(fs.fstatSync(file).mode & 0o777, 0o600);
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} finally {
		fs.closeSync(file);
	}
}
async function native() {
	assert.ok(
		process.versions.electron,
		"Root must launch native acceptance; author uses --self-check"
	);
	assert.ok(!process.env.ELECTRON_RENDERER_URL, "Built default App required");
	const { app, BrowserWindow, ipcMain, session, shell } = require("electron");
	const builtMain = resolve(
		process.argv.slice(2).find((arg) => !arg.startsWith("--")) ??
			join(__dirname, "../../out/main/index.js")
	);
	assert.ok(fs.existsSync(builtMain));
	const owned = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "met-pr-fix-native-")));
	const owner = randomUUID();
	fs.writeFileSync(join(owned, ".owner"), owner, { mode: 0o600 });
	const profile = join(owned, "profile");
	fs.mkdirSync(profile, { mode: 0o700 });
	app.setPath("userData", profile);
	const envPath = join(owned, "isolated.env");
	fs.writeFileSync(
		envPath,
		"MODEL_API_KEY=pr-fix-controlled-model\nGITHUB_TOKEN=pr-fix-controlled-github\n",
		{ mode: 0o600 }
	);
	for (const key of Object.keys(process.env))
		if (
			/^(?:GITHUB_|GH_TOKEN$|LINEAR_|SLACK_|MODEL_|META_|ELEVENLABS_|VITE_MUSE_|METAHACKATHON_)/.test(
				key
			)
		)
			Reflect.deleteProperty(process.env, key);
	process.env.METAHACKATHON_ENV_FILE = envPath;
	const reportPath = join(__dirname, "../../out/pr-fix-smoke-report.json");
	fs.mkdirSync(dirname(reportPath), { recursive: true });
	const report = {
		status: "running",
		builtMain,
		builtMainSha256: S.sha256(fs.readFileSync(builtMain)),
		builtWorkerSha256: S.sha256(fs.readFileSync(join(dirname(builtMain), "coding-worker.js"))),
		harnessSha256: S.sha256(fs.readFileSync(__filename)),
		supportSha256: S.sha256(fs.readFileSync(join(__dirname, "pr-fix-smoke-support.cjs"))),
		controlledProviders: true,
		liveProviders: false,
		liveSpeech: false,
		microphoneCapture: false,
		fullProcessRestart: false,
		privateStoreFreshReopen: false,
		typedAgentNavigation: false,
		typedProviderRequests: [],
		githubWrites: 0,
		children: [],
		commands: [],
		receipts: [],
		blocked: [],
	};
	const save = () => fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
	const originalFetch = globalThis.fetch;
	const originalHandle = ipcMain.handle;
	const originalFork = cp.fork;
	const originalSpawn = cp.spawn;
	const originalOpen = shell.openExternal;
	const sessions = new Set();
	const children = [];
	const trace = [];
	let failure;
	let readUI;
	let complete = false;
	const fail = (error) => {
		failure ??= error instanceof Error ? error : new Error(String(error));
		report.status = "failed";
		report.error = failure.message;
		save();
		app.quit();
	};
	const deadline = setTimeout(() => fail(new Error("PR-fix native hard deadline")), 150000);
	app.on("browser-window-created", (_event, win) => {
		win.setIgnoreMouseEvents(true);
		win.setFocusable(false);
	});
	const restrict = (browserSession) => {
		if (sessions.has(browserSession)) return;
		sessions.add(browserSession);
		browserSession.setPermissionRequestHandler((_webContents, permission, callback) => {
			report.blocked.push(`permission:${permission}`);
			callback(false);
			fail(new Error("No native permissions/microphone permitted"));
		});
		browserSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
			const allowed = /^(?:file:|data:|blob:|about:|devtools:)/.test(details.url);
			callback({ cancel: !allowed });
			if (!allowed) {
				report.blocked.push("chromium-external");
				fail(new Error("External Chromium network forbidden"));
			}
		});
	};
	app.on("session-created", restrict);
	app.on("will-quit", () => {
		clearTimeout(deadline);
		globalThis.fetch = originalFetch;
		ipcMain.handle = originalHandle;
		cp.fork = originalFork;
		cp.spawn = originalSpawn;
		shell.openExternal = originalOpen;
		syncBuiltinESMExports();
		for (const child of children)
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		for (const s of sessions) {
			s.webRequest.onBeforeRequest(null);
			s.setPermissionRequestHandler(null);
		}
		if (!complete || failure) report.status = "failed";
		try {
			assert.equal(fs.readFileSync(join(owned, ".owner"), "utf8"), owner);
			fs.rmSync(owned, { recursive: true });
			report.ownedTempRemoved = !fs.existsSync(owned);
		} catch (error) {
			report.status = "failed";
			report.error = error.message;
		}
		save();
		console.log(`PR_FIX_SMOKE_${report.status.toUpperCase()}: ${reportPath}`);
		if (report.status !== "passed") app.exit(1);
	});
	try {
		const fixture = S.createRepository(owned);
		const gate = join(owned, "release-controlled-provider");
		globalThis.fetch = async (input, options = {}) => {
			const url = String(input.url ?? input);
			try {
				if (new URL(url).origin === "https://api.github.com") {
					const method = options.method ?? "GET";
					if (method !== "GET") report.githubWrites++;
					return Response.json(S.github(url, method, fixture));
				}
				if (url === S.MODEL) {
					const body = JSON.parse(options.body);
					if (body.tools.some((tool) => tool.name === "inspect_suggested_fixes")) {
						const step = S.conversationStep(body);
						const ui = await readUI();
						const calls = body.input.filter((item) => item.type === "function_call");
						const audit = {
							at: Date.now(),
							nextTool: step.tool ?? null,
							calls: calls.map((call) => ({
								name: call.name,
								id: call.call_id,
								args: JSON.parse(call.arguments),
							})),
							displayedPath: ui.current.path,
						};
						if (step.tool) {
							assert.equal(
								ui.current.path,
								S.FILES[0],
								"Read-only source inspection must not navigate"
							);
							assert.equal(
								ui.current.conversation.answer,
								"",
								"Inspection is not display/narration proof"
							);
						} else {
							const identity = ui.current.conversation;
							const accepted = await wait("real agent source receipt before final text", () =>
								trace.find(
									(entry) =>
										entry.path === "workspace.applied" &&
										entry.result?.status === "accepted" &&
										entry.input.sessionId === identity.sessionId &&
										entry.input.turnId === identity.turnId &&
										entry.input.generation === identity.generation &&
										entry.input.workspace.sequence === step.workspaceSequence
								)
							);
							S.assertReceipt(accepted, step.source);
							assert.equal(ui.current.path, step.source.path);
							assert.equal(ui.current.head, step.source.headSha);
							assert.equal(
								ui.current.conversation.answer,
								"",
								"Final text must follow actual display acknowledgement"
							);
							assert.ok(accepted.finishedAt <= Date.now());
							audit.acceptedRequestId = accepted.input.requestId;
							audit.acceptedAt = accepted.finishedAt;
							audit.finalTextGeneratedAt = Date.now();
							audit.text = step.text;
						}
						report.typedProviderRequests.push(audit);
						return S.parentModel(body, step);
					}
					return S.parentModel(body);
				}
				throw new Error("External provider transport forbidden");
			} catch (error) {
				report.blocked.push(error.message);
				fail(error);
				throw error;
			}
		};
		shell.openExternal = async () => {
			fail(new Error("External navigation/publication forbidden"));
			throw new Error("External navigation forbidden");
		};
		const hook = join(owned, "controlled-child-model.mjs");
		fs.writeFileSync(
			hook,
			`import {createRequire} from 'node:module';\nconst require=createRequire(import.meta.url);\nglobalThis.fetch=require(${JSON.stringify(join(__dirname, "pr-fix-smoke-support.cjs"))}).createChildModelFetch({gate:${JSON.stringify(gate)}});\n`,
			{ mode: 0o600 }
		);
		cp.fork = (modulePath, args, options) => {
			assert.equal(resolve(modulePath), join(dirname(builtMain), "coding-worker.js"));
			assert.ok(Array.isArray(args));
			assert.equal(options.env.ELECTRON_RUN_AS_NODE, "1");
			assert.ok(
				!Object.keys(options.env).some((key) => /TOKEN|API_KEY|NODE_OPTIONS/.test(key)),
				"Child env must not inherit credentials"
			);
			const child = originalFork(modulePath, args, {
				...options,
				execArgv: ["--import", pathToFileURL(hook).href, ...(options.execArgv ?? [])],
			});
			children.push(child);
			const observed = { entry: basename(modulePath), pid: child.pid, result: null, exited: false };
			report.children.push(observed);
			const send = child.send;
			child.send = function (value, ...rest) {
				if (value?.kind === "run") {
					assert.equal(value.envPath, envPath);
					observed.jobId = value.input.jobId;
					observed.worktreePath = value.input.worktreePath;
					observed.checkpointPath = value.input.checkpointPath;
				}
				return send.call(this, value, ...rest);
			};
			child.on("message", (event) => {
				if (event?.kind === "result") observed.result = event.result;
			});
			child.on("exit", (code, signal) => {
				observed.exited = true;
				observed.exitCode = code;
				observed.signal = signal;
			});
			return child;
		};
		cp.spawn = (command, args, options) => {
			if (basename(String(command)) === "git")
				assert.ok(
					!args.some((arg) => ["push", "merge", "fetch", "pull", "ls-remote"].includes(arg)),
					"Git publication/network/merge forbidden"
				);
			report.commands.push({ command: basename(String(command)), args });
			return originalSpawn(command, args, options);
		};
		// Audit existing handlers. Never replace results, invoke positive receipts, or alter inputs.
		ipcMain.handle = function (channel, handler) {
			if (channel !== "trpc:request") return originalHandle.call(this, channel, handler);
			return originalHandle.call(this, channel, async (event, request) => {
				const watched = [
					"prFixes.start",
					"prFixes.reviewed",
					"workspace.prepare",
					"workspace.applied",
					"conversation.start",
				].includes(request?.path);
				const entry = watched
					? { path: request.path, input: request.input?.json, receivedAt: Date.now() }
					: null;
				if (entry) trace.push(entry);
				if (entry?.path === "workspace.applied" && readUI) entry.ui = await readUI();
				const result = await handler(event, request);
				if (entry) {
					entry.result = dataOf(result);
					entry.error = result.error;
					entry.finishedAt = Date.now();
					if (entry.path.startsWith("prFixes.")) {
						report.fixRequests ??= [];
						report.fixRequests.push(entry);
						save();
					}
				}
				return result;
			});
		};
		syncBuiltinESMExports();
		await import(pathToFileURL(builtMain).href);
		await app.whenReady();
		restrict(session.defaultSession);
		const win = await wait("default App window", () => BrowserWindow.getAllWindows()[0]);
		assert.equal(BrowserWindow.getAllWindows().length, 1);
		win.setSize(1440, 1100);
		const js = (code) => win.webContents.executeJavaScript(code);
		await wait("default App preload", () =>
			js(`!!window.electron?.trpc?.request && !!document.querySelector('.command-rail')`)
		);
		await js(observer);
		readUI = () =>
			js("({current:window.__prFixSmoke.read(),frames:window.__prFixSmoke.frames.slice()})");
		const rpc = async (type, path, input = {}) => {
			assert.notEqual(path, "workspace.applied", "Only app handlers may issue display receipts");
			const result = await js(
				`window.electron.trpc.request(${JSON.stringify({ type, path, input: { json: input } })})`
			);
			assert.ok(!result.error, `${path}: ${JSON.stringify(result.error)}`);
			return dataOf(result);
		};
		const click = async (selector, text, includes = false) => {
			const code = `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(e=>!e.disabled&&e.textContent.trim()${includes ? ".includes" : "==="}${includes ? `(${JSON.stringify(text)})` : JSON.stringify(text)})`;
			await wait(`enabled ${text}`, () => js(`!!(${code})`));
			await js(`(${code}).click()`);
		};
		const receipt = async (expected, after) => {
			const found = await wait(`accepted fix workspace ${expected.path ?? "preparing"}`, () =>
				trace
					.slice(after)
					.find(
						(entry) =>
							entry.path === "workspace.applied" &&
							entry.result?.status === "accepted" &&
							S.primary(entry.input.workspace)?.section === "fixes" &&
							JSON.stringify(S.primary(entry.input.workspace)?.fixSource) ===
								JSON.stringify(expected)
					)
			);
			let frames;
			try {
				frames = S.assertReceipt(found, expected);
			} catch (error) {
				report.receiptFailure = {
					expected,
					input: found.input,
					result: found.result,
					ui: found.ui,
					receivedAt: found.receivedAt,
				};
				save();
				throw error;
			}
			report.receipts.push({
				input: found.input,
				result: found.result,
				frames,
				receivedAt: found.receivedAt,
			});
			return found;
		};
		assert.deepEqual(await rpc("query", "prFixes.list"), []);
		await rpc("mutation", "hub.operate", {
			requestId: randomUUID(),
			operation: { kind: "add-repository", repository: S.REPOSITORY, localPath: fixture.localPath },
		});
		await wait("real own feedback queue", async () =>
			(await rpc("query", "hub.snapshot")).reviews.some(
				(row) => row.pr.id === S.PR_ID && row.kind === "own"
			)
		);
		await js(`document.querySelector('.command-rail button[aria-label^="Reviews"]').click()`);
		await click(".command-subsections button", "My PRs");
		await click(".command-sidebar-scroll button.command-item", S.TITLE, true);
		await wait("actual original feedback", () =>
			js(
				`document.querySelector('.hub-feedback-entry')?.textContent.includes(${JSON.stringify(S.FEEDBACK)})`
			)
		);
		const preparingStart = trace.length;
		await click(".hub-feedback-entry button", "Prepare suggested fix");
		const admitted = await wait(
			"durable start RPC acknowledgement",
			() => trace.find((e) => e.path === "prFixes.start" && e.result)?.result
		);
		assert.equal(admitted.feedback.id, S.FEEDBACK_ID);
		assert.equal(admitted.feedback.body, S.FEEDBACK);
		assert.equal(admitted.pr.headSha, fixture.headSha);
		await receipt(
			{ id: admitted.id, baseSha: fixture.headSha, headSha: null, path: null },
			preparingStart
		);
		report.preparingAcknowledged = true;
		fs.writeFileSync(gate, "release provider only\n", { mode: 0o600 });
		const ready = await wait(
			"actual child and finalized candidate",
			async () => {
				const fix = (await rpc("query", "prFixes.list")).find((f) => f.id === admitted.id);
				if (["failed", "interrupted", "needs-input"].includes(fix?.phase))
					throw new Error(`Fix failed: ${fix.phase}: ${fix.error ?? fix.question}`);
				return fix?.phase === "ready" ? fix : null;
			},
			70000
		);
		assert.equal(ready.jobId, admitted.jobId);
		assert.deepEqual(ready.changedFiles, S.FILES);
		assert.ok(ready.checks.length);
		assert.ok(ready.checks.every((c) => c.exitCode === 0 && c.commitSha === ready.headSha));
		const readyStart = trace.length;
		await js(`document.querySelector('.command-rail button[aria-label^="Reviews"]').click()`);
		await click(".command-subsections button", "Fixes");
		await click(".pr-fix-list button.command-item", S.TITLE, true);
		await receipt(
			{ id: ready.id, baseSha: fixture.headSha, headSha: ready.headSha, path: S.FILES[0] },
			readyStart
		);
		const detail = await rpc("query", "prFixes.detail", { id: ready.id });
		assert.equal(detail.review.job.id, ready.jobId);
		assert.equal(detail.fix.feedback.body, S.FEEDBACK);
		for (let i = 0; i < S.FILES.length; i++) {
			const file = detail.review.files[i];
			assert.equal(file.path, S.FILES[i]);
			if (i) {
				const start = trace.length;
				await click(".pr-fix-review button", "Next file");
				await receipt(
					{ id: ready.id, baseSha: fixture.headSha, headSha: ready.headSha, path: file.path },
					start
				);
			}
			await click(".pr-fix-review button", "Before");
			await wait("exact Before source", async () => {
				const view = await readUI();
				return (
					view.current.path === file.path &&
					view.current.source?.path === file.path &&
					view.current.source.sha === fixture.headSha &&
					view.current.source.text === S.text(2)
				);
			});
			await click(".pr-fix-review button", "Proposed after");
			await wait("exact proposed source", async () => {
				const view = await readUI();
				return (
					view.current.path === file.path &&
					view.current.source?.path === file.path &&
					view.current.source.sha === ready.headSha &&
					view.current.source.text === S.text(3)
				);
			});
			await click(".pr-fix-review button", "Diff");
			const diff = await wait("actual rendered candidate diff", async () => {
				const view = await readUI();
				return view.current.rows.length ? view.current : null;
			});
			assert.equal(diff.feedback, S.FEEDBACK);
			assert.equal(diff.path, file.path);
			assert.equal(diff.base, fixture.headSha);
			assert.equal(diff.head, ready.headSha);
			assert.deepEqual(diff.rows, S.diffRows(file.patch));
			assert.equal(file.base.commitSha, fixture.headSha);
			assert.equal(file.head.commitSha, ready.headSha);
			assert.equal(file.base.content, S.text(2));
			assert.equal(file.head.content, S.text(3));
		}
		const previousStart = trace.length;
		await click(".pr-fix-review button", "Previous file");
		await receipt(
			{ id: ready.id, baseSha: fixture.headSha, headSha: ready.headSha, path: S.FILES[0] },
			previousStart
		);
		await wait("agent explanation and actual check UI", () =>
			js(
				`document.querySelector('.pr-fix-review [aria-label="Agent summary"]')?.textContent.includes('both actual exports')&&document.querySelector('.pr-fix-review [aria-label="Actual checks"]')?.textContent.includes('npm run test')&&document.querySelector('.pr-fix-files')?.textContent.includes(${JSON.stringify(S.FILES[1])})`
			)
		);
		await js(
			`document.querySelector('.pr-fix-review .hub-work-diff').scrollIntoView({block:'center'})`
		);
		await js("window.scrollTo(0,0)");
		const screenshot = join(__dirname, "../../out/pr-fix-controlled-diff.png");
		fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
		report.screenshot = {
			path: screenshot,
			content: "Actual controlled two-file candidate diff, no live content",
		};
		await click(".pr-fix-review button", "Mark fix reviewed");
		const reviewed = await wait("actual local reviewed receipt", () => {
			const entry = trace.find((e) => e.path === "prFixes.reviewed");
			if (entry?.error) throw new Error(`Local review failed: ${entry.error.message}`);
			return entry?.result?.reviewedAt ? entry : null;
		});
		assert.deepEqual(reviewed.input, { id: ready.id, headSha: ready.headSha, confirmed: true });
		assert.equal(reviewed.result.publication, "not-published");
		await wait(
			"real coding child clean exit",
			() => report.children.length === 1 && report.children[0].exited
		);
		const child = report.children[0];
		assert.equal(child.jobId, ready.jobId);
		assert.equal(child.exitCode, 0);
		assert.equal(child.result.status, "completed");
		const checkpoint = JSON.parse(fs.readFileSync(child.checkpointPath, "utf8"));
		assert.equal(checkpoint.jobId, ready.jobId);
		assert.equal(checkpoint.result.status, "completed");
		assert.equal(checkpoint.pendingTool, null);
		const calls = new Map(
			checkpoint.history.filter((e) => e.type === "function_call").map((e) => [e.call_id, e.name])
		);
		report.workerCheckpoint = {
			sha256: S.sha256(fs.readFileSync(child.checkpointPath)),
			jobId: checkpoint.jobId,
			result: checkpoint.result.status,
			pendingTool: checkpoint.pendingTool,
			toolCalls: [...calls.values()],
		};
		const check = checkpoint.history
			.filter((e) => calls.get(e.call_id) === "run_command" && e.type === "function_call_output")
			.map((e) => JSON.parse(e.output))
			.find((e) => e.exitCode === 0 && e.stdout.includes("PR_FIX_ACTUAL_CHECK_PASS"));
		assert.ok(check);
		report.workerCheck = check;
		for (const result of ready.checks) {
			const log = fs.readFileSync(
				join(profile, "work", "git", "logs", `${result.logId}.log`),
				"utf8"
			);
			assert.ok(log.includes("PR_FIX_ACTUAL_CHECK_PASS"));
		}
		assert.equal(S.git(child.worktreePath, "rev-parse", "HEAD").trim(), ready.headSha);
		for (const file of S.FILES)
			assert.equal(S.git(child.worktreePath, "show", `${ready.headSha}:${file}`), S.text(3));
		const persisted = freshStore(profile);
		assert.equal(persisted.owner, S.VIEWER);
		assert.equal(persisted.entries.length, 1);
		const entry = persisted.entries[0];
		assert.equal(entry.id, ready.id);
		assert.equal(entry.reviewedHeadSha, ready.headSha);
		assert.equal(entry.reviewedAt, reviewed.result.reviewedAt);
		assert.equal(entry.record.job.headSha, ready.headSha);
		assert.equal(entry.record.phase, "settled");
		assert.deepEqual(entry.record.job.checks, ready.checks);
		assert.equal(entry.record.job.reviewedAt, undefined);
		assert.equal(entry.record.job.publishedHeadSha, undefined);
		assert.equal(entry.record.outcome.publication, "not-published");
		report.privateStoreFreshReopen = true;
		// One actual typed foreground turn; the existing manual/child assertions remain intact.
		assert.equal(win.isFocusable(), false);
		const conversationStart = trace.length;
		await js(`document.querySelector('[data-testid="workspace-more"]').click()`);
		await wait("More menu for typing", () =>
			js(`document.querySelector('#workspace-more')?.open === true`)
		);
		await js(`document.querySelector('[data-testid="conversation-toggle"]').click()`);
		await wait("visible typed composer", () =>
			js(`document.querySelector('textarea[name="question"]')?.checkVisibility()`)
		);
		const prior = (await readUI()).current.conversation;
		await js(
			`(() => { const e=document.querySelector('textarea[name="question"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(S.WALK_QUESTION)}); e.dispatchEvent(new Event('input',{bubbles:true})); })()`
		);
		await wait("enabled typed Send", () =>
			js(`!!document.querySelector('[aria-label="Send message"]:not(:disabled)')`)
		);
		await js(`document.querySelector('textarea[name="question"]').form.requestSubmit()`);
		const walked = await wait("completed actual candidate walkthrough turn", async () => {
			const ui = (await readUI()).current;
			if (ui.conversation.phase === "error") throw new Error("Typed candidate walkthrough failed");
			return ui.conversation.turnId !== prior.turnId && ui.conversation.phase === "complete"
				? ui
				: null;
		});
		const turn = {
			sessionId: walked.conversation.sessionId,
			turnId: walked.conversation.turnId,
			generation: walked.conversation.generation,
		};
		const result = await rpc("query", "conversation.poll", {
			...turn,
			afterSequence: 0,
			limit: 100,
		});
		assert.equal(result.status, "completed");
		assert.equal(result.text, walked.conversation.answer);
		assert.equal(walked.id, ready.id);
		assert.equal(walked.path, ready.changedFiles[1]);
		assert.equal(walked.head, ready.headSha);
		assert.equal(walked.base, ready.baseSha);
		assert.equal(walked.feedback, S.FEEDBACK);
		assert.deepEqual(walked.rows, S.diffRows(detail.review.files[1].patch));
		const start = trace
			.slice(conversationStart)
			.find((entry) => entry.path === "conversation.start");
		assert.ok(start && !start.error);
		assert.equal(start.input.text, S.WALK_QUESTION);
		assert.deepEqual(
			{
				sessionId: start.input.sessionId,
				turnId: start.input.turnId,
				generation: start.input.generation,
			},
			turn
		);
		const action = result.actions.find(
			(action) =>
				action.kind === "workspace-canvas" &&
				S.primary(action.effect.snapshot)?.fixSource?.path === ready.changedFiles[1]
		);
		assert.ok(action);
		assert.deepEqual(
			{ sessionId: action.sessionId, turnId: action.turnId, generation: action.generation },
			turn
		);
		const agentReceipt = trace
			.slice(conversationStart)
			.find(
				(entry) =>
					entry.path === "workspace.applied" &&
					entry.result?.status === "accepted" &&
					entry.input.requestId === action.requestId &&
					entry.input.sessionId === turn.sessionId &&
					entry.input.turnId === turn.turnId &&
					entry.input.generation === turn.generation
			);
		assert.ok(agentReceipt);
		const expected = {
			id: ready.id,
			baseSha: ready.baseSha,
			headSha: ready.headSha,
			path: ready.changedFiles[1],
		};
		const frames = S.assertReceipt(agentReceipt, expected);
		const finalRequest = report.typedProviderRequests.at(-1);
		assert.equal(finalRequest.acceptedRequestId, action.requestId);
		assert.ok(agentReceipt.finishedAt <= finalRequest.finalTextGeneratedAt);
		assert.deepEqual(
			finalRequest.calls.map((call) => call.name),
			["inspect_suggested_fixes", "inspect_suggested_fix", "open_command_center"]
		);
		assert.equal(finalRequest.calls[1].args.id, ready.id);
		assert.equal(finalRequest.calls[1].args.path, ready.changedFiles[1]);
		assert.equal(result.text, finalRequest.text);
		assert.ok(result.text.includes(ready.changedFiles[1]) && result.text.includes(ready.headSha));
		assert.equal(report.typedProviderRequests.length, 4);
		const actionEvent = result.events.find(
			(event) => event.kind === "action" && event.action.requestId === action.requestId
		);
		const textEvent = result.events.find((event) => event.kind === "text-delta" && event.delta);
		assert.ok(actionEvent && textEvent && actionEvent.sequence < textEvent.sequence);
		assert.equal(win.isFocusable(), false);
		assert.equal(report.children.length, 1, "The read-only walkthrough cannot start another child");
		assert.ok(!trace.slice(conversationStart).some((entry) => entry.path === "prFixes.start"));
		report.typedAgentNavigation = true;
		report.typedAgent = {
			question: S.WALK_QUESTION,
			turn,
			text: result.text,
			inspectionNotDisplay: true,
			action,
			receipt: {
				input: agentReceipt.input,
				result: agentReceipt.result,
				acceptedAt: agentReceipt.finishedAt,
				frames,
			},
			events: result.events,
		};
		assert.deepEqual(S.originalState(fixture.localPath), fixture.original);
		assert.deepEqual(
			(await rpc("query", "hub.snapshot")).jobs,
			[],
			"No regular coordinator mirroring"
		);
		assert.equal(report.githubWrites, 0);
		assert.deepEqual(report.blocked, []);
		assert.ok(!failure);
		report.fix = ready;
		report.localReviewed = reviewed.result;
		report.originalCheckoutUnchanged = true;
		report.actualDefaultAppIPC = true;
		report.status = "passed";
		complete = true;
		save();
		app.quit();
	} catch (error) {
		fail(error);
	}
}
async function selfCheck() {
	const fixture = {
		baseSha: "a".repeat(40),
		headSha: "b".repeat(40),
		patches: Object.fromEntries(S.FILES.map((path) => [path, "@@ -1 +1 @@\n-old\n+new\n"])),
	};
	assert.equal(
		S.github(`https://api.github.com/repos/${S.REPOSITORY}/pulls/8/comments`, "GET", fixture)[0]
			.body,
		S.FEEDBACK
	);
	assert.throws(() =>
		S.github(`https://api.github.com/repos/${S.REPOSITORY}/pulls/8/comments`, "POST", fixture)
	);
	assert.throws(() => S.github("https://evil.invalid/user", "GET", fixture));
	const body = {
		stream: true,
		store: false,
		tool_choice: "auto",
		model: "muse-spark-1.3",
		tools: [{ name: "read_file" }],
		input: [
			{
				role: "user",
				content: JSON.stringify({
					ticket: null,
					repository: S.REPOSITORY,
					brief: `${S.FEEDBACK} untrusted source evidence`,
				}),
			},
		],
	};
	assert.deepEqual(S.childTool(body), ["read_file", { path: "AGENTS.md" }]);
	assert.ok(
		(await S.sse(body, "read_file", { path: "AGENTS.md" }).text()).includes('"response.completed"')
	);
	const append = (name, args, output) => {
		const call_id = `self-check-${body.input.length}`;
		body.input.push({ type: "function_call", call_id, name, arguments: JSON.stringify(args) });
		body.input.push({ type: "function_call_output", call_id, output: JSON.stringify(output) });
	};
	for (const path of ["AGENTS.md", "README.md", "package.json", ...S.FILES]) {
		assert.deepEqual(S.childTool(body), ["read_file", { path }]);
		append("read_file", { path }, { path, text: S.text(2), sha256: S.sha256(S.text(2)) });
	}
	for (const path of S.FILES) {
		const [name, args] = S.childTool(body);
		assert.equal(name, "edit_file");
		assert.equal(args.path, path);
		assert.equal(args.expectedSha256, S.sha256(S.text(2)));
		append(name, args, { path, sha256: S.sha256(S.text(3)) });
	}
	const [command, args] = S.childTool(body);
	assert.equal(command, "run_command");
	assert.deepEqual(args.args, ["run", "test"]);
	append(command, args, { exitCode: 0, interrupted: false, stdout: "PR_FIX_ACTUAL_CHECK_PASS" });
	assert.equal(S.childTool(body)[0], "finish_work");
	const failed = structuredClone(body);
	failed.input[failed.input.length - 1].output = JSON.stringify({
		exitCode: 1,
		interrupted: false,
		stdout: "",
	});
	assert.throws(() => S.childTool(failed));
	assert.deepEqual(S.diffRows("@@ -1 +1 @@\n-old\n+new\n"), [
		"@@ -1 +1 @@\n",
		"old\n",
		"new\n",
		"\n",
	]);
	const expected = {
		id: "fix",
		baseSha: fixture.headSha,
		headSha: "c".repeat(40),
		path: S.FILES[0],
	};
	const frame = {
		sequence: 7,
		scheduledSequence: 7,
		id: expected.id,
		base: expected.baseSha,
		head: expected.headSha,
		path: expected.path,
		visible: true,
		at: 1,
	};
	const receipt = {
		receivedAt: 3,
		input: {
			status: "applied",
			workspace: {
				sequence: 7,
				primaryId: "center",
				canvases: [{ id: "center", section: "fixes", fixSource: expected }],
			},
		},
		result: { status: "accepted" },
		ui: {
			frames: [
				{ ...frame, timestamp: 1 },
				{ ...frame, timestamp: 2 },
			],
		},
	};
	S.assertReceipt(receipt, expected);
	assert.throws(() => S.assertReceipt({ ...receipt, result: { status: "stale" } }, expected));
	assert.throws(() =>
		S.assertReceipt({ ...receipt, ui: { frames: [{ ...frame, timestamp: 1 }] } }, expected)
	);
	assert.throws(() => S.assertReceipt(receipt, { ...expected, headSha: "d".repeat(40) }));
	// Pure provider-driver fixture only; native calls still obtain all tool outputs from the app.
	const walk = {
		stream: true,
		store: false,
		tool_choice: "auto",
		model: body.model,
		tools: ["inspect_suggested_fixes", "inspect_suggested_fix", "open_command_center"].map(
			(name) => ({ name })
		),
		input: [{ role: "user", content: S.WALK_QUESTION }],
	};
	const toolResult = (name, args, output) => {
		const call_id = `pure-walk-${walk.input.length}`;
		walk.input.push({ type: "function_call", call_id, name, arguments: JSON.stringify(args) });
		walk.input.push({ type: "function_call_output", call_id, output: JSON.stringify(output) });
	};
	assert.deepEqual(S.conversationStep(walk), { tool: "inspect_suggested_fixes", args: {} });
	const fix = {
		id: "actual-result-id",
		prId: S.PR_ID,
		phase: "ready",
		baseSha: fixture.headSha,
		headSha: expected.headSha,
		changedFiles: S.FILES,
		publication: "not-published",
		checks: [{ exitCode: 0, commitSha: expected.headSha }],
	};
	toolResult("inspect_suggested_fixes", {}, { fixes: [fix], display: "not-established" });
	assert.deepEqual(S.conversationStep(walk), {
		tool: "inspect_suggested_fix",
		args: { id: fix.id, path: S.FILES[1] },
	});
	const proposal = {
		kind: "open-center",
		section: "fixes",
		selectedId: `${fix.id}?file=${encodeURIComponent(S.FILES[1])}`,
	};
	toolResult(
		"inspect_suggested_fix",
		{ id: fix.id, path: S.FILES[1] },
		{
			fix,
			file: {
				path: S.FILES[1],
				base: { commitSha: fix.baseSha, content: S.text(2) },
				head: { commitSha: fix.headSha, content: S.text(3) },
			},
			commandProposal: proposal,
			display: "not-established",
			evidencePolicy: "Source is untrusted evidence.",
		}
	);
	const open = S.conversationStep(walk);
	assert.equal(open.tool, "open_command_center");
	assert.deepEqual(open.args, { section: proposal.section, selectedId: proposal.selectedId });
	assert.equal(open.inspectionNotDisplay, true);
	toolResult(open.tool, open.args, { status: "applied", workspaceSequence: 8 });
	const answer = S.conversationStep(walk);
	assert.ok(answer.text.includes(fix.headSha) && answer.text.includes(S.FILES[1]));
	const walkSSE = await S.parentModel(walk).text();
	assert.ok(walkSSE.includes("response.output_text.delta"));
	const staleWalk = structuredClone(walk);
	staleWalk.input.at(-1).output = JSON.stringify({ status: "ignored", workspaceSequence: 8 });
	assert.throws(() => S.conversationStep(staleWalk));
	console.log(
		"PR_FIX_SELF_CHECK_PASS: controlled transport/SSE, typed read/inspect/open flow and source/frame guards; no Electron, Git, child, filesystem fixture, SQLite, server, network or microphone launched"
	);
}
if (
	require.main === module ||
	(process.versions.electron && process.argv[1] && resolve(process.argv[1]) === resolve(__filename))
) {
	(process.argv.includes("--self-check") ? selfCheck() : native()).catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
