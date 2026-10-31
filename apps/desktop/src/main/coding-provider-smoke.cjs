// ROOT ONLY after building integration:
// env -u ELECTRON_RUN_AS_NODE electron src/main/coding-provider-smoke.cjs [built-main]
// AUTHOR: node --check this-file; node this-file --self-check. No native/CLI/model execution.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const cp = require("node:child_process");
const { randomUUID, createHash } = require("node:crypto");
const { syncBuiltinESMExports } = require("node:module");
const { tmpdir } = require("node:os");
const { dirname, basename, join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const fixtures = require("./coding-provider-smoke/fixtures.cjs");
const control = require("./coding-provider-smoke/control.cjs");
const fakeCLI = require("./coding-provider-smoke/fake-cli.cjs");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function wait(label, read, timeout = 30_000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const value = await read();
		if (value) return value;
		await sleep(50);
	}
	throw new Error(`Timed out waiting for ${label}`);
}
async function native() {
	assert.ok(
		process.versions.electron && !process.env.ELECTRON_RENDERER_URL,
		"Root must launch the built app; author checks use --self-check"
	);
	const { app, BrowserWindow, ipcMain, session } = require("electron");
	for (const key of Object.keys(process.env)) {
		if (
			/TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL/.test(key) ||
			/^(?:GITHUB_|GH_|LINEAR_|SLACK_|META_|MODEL_|ELEVENLABS_)/.test(key) ||
			["NODE_OPTIONS", "NODE_PATH", "MUSE_CODE_PATH", "CODING_PROVIDER"].includes(key)
		)
			delete process.env[key];
	}
	const builtMain = resolve(process.argv[2] ?? join(__dirname, "../../out/main/index.js"));
	assert.ok(fs.existsSync(builtMain), "Root must build the composed app first");
	const owned = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "met-coding-provider-smoke-")));
	const owner = randomUUID();
	fs.writeFileSync(join(owned, ".owner"), owner, { mode: 0o600 });
	const profile = join(owned, "profile");
	fs.mkdirSync(profile, { mode: 0o700 });
	app.setPath("userData", profile);
	const envPath = join(owned, "isolated.env");
	fs.writeFileSync(
		envPath,
		"MODEL_API_KEY=controlled-coding-model-only\nGITHUB_TOKEN=controlled-coding-github-only\nLINEAR_API_KEY=controlled-coding-linear-only\n",
		{ mode: 0o600 }
	);
	process.env.METAHACKATHON_ENV_FILE = envPath;
	const out = join(__dirname, "../../out");
	fs.mkdirSync(out, { recursive: true });
	const reportPath = join(out, "coding-provider-smoke-report.json");
	const audit = join(owned, "audit.jsonl");
	fs.writeFileSync(audit, "", { mode: 0o600 });
	const fakeBin = join(owned, "muse");
	const missingBin = join(owned, "missing-muse");
	fs.writeFileSync(
		fakeBin,
		`#!/usr/bin/env node\nrequire(${JSON.stringify(join(__dirname, "coding-provider-smoke/fake-cli.cjs"))}).main(${JSON.stringify(audit)});\n`,
		{ mode: 0o700 }
	);
	const allowed = [fakeBin, missingBin];
	const hook = join(owned, "controlled-child.mjs");
	fs.writeFileSync(
		hook,
		`import {createRequire} from 'node:module';const require=createRequire(import.meta.url);require(${JSON.stringify(join(__dirname, "coding-provider-smoke/control.cjs"))}).installChild(${JSON.stringify(audit)},${JSON.stringify(allowed)},${JSON.stringify(join(__dirname, "executive-smoke.cjs"))});\n`,
		{ mode: 0o600 }
	);
	const report = {
		status: "running",
		controlledOnly: true,
		nativeAuthorExecuted: false,
		liveProviders: false,
		realMuseHost: false,
		physicalMicrophone: false,
		fullProcessRestart: false,
		builtMainSha256: createHash("sha256").update(fs.readFileSync(builtMain)).digest("hex"),
		steps: [],
		children: [],
		ipc: [],
		providerReads: [],
		blocked: [],
		audit: [],
	};
	const save = (readAudit = true) => {
		if (readAudit) report.audit = control.rows(audit);
		fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
		fs.writeFileSync(
			join(out, "coding-provider-smoke-report.md"),
			[
				"# Controlled coding-provider acceptance",
				"",
				`Status: ${report.status}`,
				"",
				...report.steps.map((step) => `- ${step.status.toUpperCase()}: ${step.label}`),
				"",
				"Actual built Settings/IPC/child entry/Git worktree; fake provider transports and deliberately unsupported CLI only.",
				"No real vendor CLI/account/model host, live provider, microphone, or full process restart evidence.",
				...(report.error ? ["", `Failure: ${report.error}`] : []),
				"",
			].join("\n")
		);
	};
	save();
	const restoreCLI = control.installCLIControl(audit, allowed);
	const originalFork = cp.fork;
	const originalFetch = globalThis.fetch;
	const originalHandle = ipcMain.handle;
	const children = [];
	const linearState = { type: "unstarted", updates: [] };
	let stopping = false;
	let win;
	const stop = async (error) => {
		if (stopping) return;
		stopping = true;
		if (error) {
			report.status = "failed";
			report.error = error.stack ?? String(error);
			if (win && !win.isDestroyed()) {
				try {
					fs.writeFileSync(
						join(out, "coding-provider-smoke-failure.png"),
						(await win.webContents.capturePage()).toPNG()
					);
				} catch {}
			}
		}
		for (const child of children)
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
		save();
		app.quit();
	};
	const deadline = setTimeout(
		() => void stop(new Error("Coding-provider smoke hard deadline")),
		180_000
	);
	ipcMain.handle = function (channel, handler) {
		if (channel !== "trpc:request") return originalHandle.call(this, channel, handler);
		return originalHandle.call(this, channel, async (event, input) => {
			const audited = input?.path?.startsWith("codingProvider.") || input?.path === "hub.operate";
			const row = audited ? { path: input.path, input: structuredClone(input.input?.json) } : null;
			if (row) report.ipc.push(row);
			const result = await handler(event, input);
			if (row) row.result = structuredClone(result);
			return result;
		});
	};
	cp.fork = function (modulePath, args, options) {
		if (basename(modulePath) !== "coding-worker.js")
			return originalFork.call(this, modulePath, args, options);
		assert.equal(options.env.ELECTRON_RUN_AS_NODE, "1");
		assert.ok(
			!Object.keys(options.env).some((key) => /TOKEN|SECRET|API_KEY|NODE_OPTIONS/.test(key))
		);
		const child = originalFork(modulePath, args, {
			...options,
			execArgv: ["--import", pathToFileURL(hook).href, ...(options.execArgv ?? [])],
		});
		children.push(child);
		const row = { pid: child.pid, entry: basename(modulePath), events: [], exited: false };
		report.children.push(row);
		child.on("message", (message) => {
			if (["log", "result", "failed"].includes(message?.kind))
				row.events.push(structuredClone(message));
		});
		child.on("exit", (code, signal) => {
			row.exited = true;
			row.code = code;
			row.signal = signal;
		});
		return child;
	};
	syncBuiltinESMExports();
	globalThis.fetch = async (input, options = {}) => {
		const address = String(input.url ?? input);
		try {
			if (new URL(address).origin === "https://api.github.com") {
				report.providerReads.push({ provider: "github", path: new URL(address).pathname });
				return Response.json(fixtures.github(address, options.method ?? "GET"));
			}
			if (address === fixtures.LINEAR) {
				assert.equal(options.method, "POST");
				return Response.json(fixtures.linear(JSON.parse(options.body), linearState));
			}
			throw new Error("Unexpected main-process provider request");
		} catch (error) {
			report.blocked.push(error.message);
			throw error;
		}
	};
	app.on("will-quit", () => {
		clearTimeout(deadline);
		globalThis.fetch = originalFetch;
		cp.fork = originalFork;
		ipcMain.handle = originalHandle;
		restoreCLI();
		syncBuiltinESMExports();
		try {
			assert.ok(
				children.every((child) => child.exitCode !== null || child.signalCode !== null),
				"Owned child survived shutdown"
			);
			assert.equal(fs.readFileSync(join(owned, ".owner"), "utf8"), owner);
			save();
			fs.rmSync(owned, { recursive: true });
			report.cleanup = { ownedTempRemoved: !fs.existsSync(owned), childrenExited: true };
		} catch (error) {
			report.status = "failed";
			report.error = error.message;
		}
		// Audit bytes are already captured; owned temporary log has now been removed.
		save(false);
		console.log(`CODING_PROVIDER_SMOKE_${report.status.toUpperCase()}: ${reportPath}`);
		if (report.status !== "passed") app.exit(1);
	});
	try {
		const fixture = fixtures.create(owned);
		await app.whenReady();
		session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
			callback(false)
		);
		session.defaultSession.setPermissionCheckHandler(() => false);
		session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
			const url = new URL(details.url);
			const allow = ["file:", "devtools:", "data:", "blob:"].includes(url.protocol);
			if (!allow) report.blocked.push(`Chromium external request: ${url.origin}`);
			callback({ cancel: !allow });
		});
		await import(pathToFileURL(builtMain).href);
		win = await wait("main window", () => BrowserWindow.getAllWindows()[0]);
		await wait("built renderer", () => !win.webContents.isLoadingMainFrame());
		const js = (code) => win.webContents.executeJavaScript(code);
		const rpc = async (type, path, input = {}) => {
			const result = await js(
				`window.electron.trpc.request(${JSON.stringify({ type, path, input: { json: input } })})`
			);
			assert.ok(!result.error, `${path}: ${JSON.stringify(result.error)}`);
			return result.result.data.json;
		};
		const operate = (operation) =>
			rpc("mutation", "hub.operate", { requestId: randomUUID(), operation });
		const snapshot = () => rpc("query", "hub.snapshot");
		const phase = async (label, work) => {
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
		const frames = () => js("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
		const click = async (selector, text) => {
			await wait(`enabled ${text}`, () =>
				js(
					`[...document.querySelectorAll(${JSON.stringify(selector)})].some(e=>e.textContent.trim()===${JSON.stringify(text)}&&!e.disabled)`
				)
			);
			await js(
				`[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(text)}&&!e.disabled).click()`
			);
		};
		const field = (selector, value) =>
			js(`(() => {const e=document.querySelector(${JSON.stringify(selector)});
			Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});
			e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`);
		const openSettings = async () => {
			await js("document.querySelector('.command-rail button[aria-label=Settings]').click()");
			await wait("actual Settings card", () =>
				js(
					"document.querySelector('#configuration')?.open&&['meta-api','muse-code'].includes(document.querySelector('.coding-provider-card')?.dataset.codingProvider)&&document.querySelector('.coding-provider-card')?.dataset.codingPending==='none'&&!document.querySelector('.coding-provider-card fieldset')?.disabled"
				)
			);
		};
		const closeSettings = async () => {
			await js("document.querySelector('#configuration .workspace-dialog-heading button').click()");
			await wait("Settings closed", () => js("!document.querySelector('#configuration')"));
		};
		const cliAttempts = () => control.rows(audit).filter((row) => row.type === "cli-attempt");
		const configure = async (provider, path) => {
			await js(
				`document.querySelector('.coding-provider-card input[type=radio][value="${provider}"]').click();document.querySelector('.coding-provider-advanced').open=true`
			);
			await field(".coding-provider-advanced input[type=text]", path ?? "");
			await frames();
			await click(".coding-provider-card button", "Save coding provider");
			return wait("exact persisted selection", async () => {
				const status = await rpc("query", "codingProvider.status");
				const ui = await js(
					"({provider:document.querySelector('.coding-provider-card').dataset.codingProvider,pending:document.querySelector('.coding-provider-card').dataset.codingPending})"
				);
				return status.settings.provider === provider &&
					status.settings.musePath === path &&
					ui.pending === "none" &&
					ui.provider === provider
					? status
					: null;
			});
		};
		const selectTicket = async () => {
			await js(
				"document.querySelector('.command-rail button[aria-label^=\"My tickets\"]').click()"
			);
			await wait("controlled ticket in sidebar", () =>
				js(
					`[...document.querySelectorAll('.command-sidebar-scroll button')].some(e=>e.textContent.includes(${JSON.stringify(fixtures.TICKET)}))`
				)
			);
			await js(
				`[...document.querySelectorAll('.command-sidebar-scroll button')].find(e=>e.textContent.includes(${JSON.stringify(fixtures.TICKET)})).click()`
			);
			await wait("actual ticket start form", () =>
				js("!!document.querySelector('form.hub-start-work select')")
			);
		};
		const fillTicket = async (repositoryId) => {
			await field("form.hub-start-work select", repositoryId);
			await field("form.hub-start-work textarea", fixtures.BRIEF);
			await frames();
		};
		const failedJob = async (repositoryId, expectedPath) => {
			const value = await operate({
				kind: "start-work",
				ticketId: fixtures.TICKET_ID,
				repositoryId,
				brief: fixtures.BRIEF,
			});
			assert.ok(value.jobId);
			const job = await wait(
				"actual child fails selected Muse job",
				async () => {
					const job = await rpc("query", "hub.job", { id: value.jobId });
					assert.ok(
						!["ready", "needs-input"].includes(job.state),
						"Missing/unsupported CLI must not produce a success/decision result"
					);
					return job.state === "failed" ? job : null;
				},
				45_000
			);
			const pin = control.childPin(audit, job.id);
			assert.deepEqual(pin.value.settings, { provider: "muse-code", musePath: expectedPath });
			assert.equal(job.checks.length, 0);
			assert.equal(
				control.rows(audit).filter((row) => row.type === "child-meta-http" && row.jobId === job.id)
					.length,
				0,
				"No API fallback"
			);
			return { jobId: job.id, state: job.state, pin: pin.value, actualChecks: job.checks };
		};
		await phase("API default Settings status starts no CLI or coding child", async () => {
			await wait("default Home", () =>
				js("document.querySelector('.hub-center')?.dataset.centerSection==='home'")
			);
			await openSettings();
			const status = await rpc("query", "codingProvider.status");
			assert.deepEqual(status.settings, { provider: "meta-api", musePath: null });
			assert.equal(status.ready, true);
			assert.equal(
				await js("document.querySelector('.coding-provider-card input[value=meta-api]').checked"),
				true
			);
			assert.equal(cliAttempts().length, 0);
			assert.equal(children.length, 0);
			await js("document.querySelector('.coding-provider-card input[value=muse-code]').click()");
			await frames();
			assert.equal((await rpc("query", "codingProvider.status")).settings.provider, "meta-api");
			assert.equal(cliAttempts().length, 0, "Unsaved radio change must not probe CLI");
			return { status, cliStarts: 0, unsavedSelectionIsLocal: true };
		});
		await phase("Explicit missing CLI selection persists and remains not ready", async () => {
			const status = await configure("muse-code", missingBin);
			assert.equal(status.ready, false);
			assert.equal(status.museCode.error, "not-installed");
			assert.equal(
				await js("document.querySelector('.coding-provider-card').dataset.codingReady"),
				"false"
			);
			assert.ok(fs.readFileSync(envPath, "utf8").includes("CODING_PROVIDER="));
			assert.ok(fs.readFileSync(envPath, "utf8").includes(missingBin));
			assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
			await closeSettings();
			await openSettings();
			assert.equal(
				await js("document.querySelector('.coding-provider-advanced input').value"),
				missingBin
			);
			const screenshot = join(out, "coding-provider-smoke-settings.png");
			fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
			report.settingsScreenshot = screenshot;
			await closeSettings();
			return { status, reopenedCard: true, savedEnv: true, screenshot };
		});
		let repositoryId;
		await phase(
			"Missing CLI disables ticket UI and actual selected child fails without API fallback",
			async () => {
				await operate({
					kind: "add-repository",
					repository: fixtures.REPO,
					localPath: fixture.localPath,
				});
				const state = await wait("controlled ticket/repository", async () => {
					const value = await snapshot();
					return value.tickets.some((ticket) => ticket.id === fixtures.TICKET_ID) &&
						value.repositories.length
						? value
						: null;
				});
				repositoryId = state.repositories[0].id;
				await selectTicket();
				await fillTicket(repositoryId);
				assert.equal((await snapshot()).connections.coding, false);
				await wait("provider readiness disables new coding button", () =>
					js("document.querySelector('form.hub-start-work button[type=submit]').disabled")
				);
				const evidence = await failedJob(repositoryId, missingBin);
				return { ...evidence, actualStartButtonDisabled: true };
			}
		);
		await phase("Unsupported controlled CLI cannot enable coding or fall back to API", async () => {
			await openSettings();
			const status = await configure("muse-code", fakeBin);
			assert.equal(status.ready, false);
			assert.equal(status.museCode.ready, false);
			assert.ok(
				["unsupported-cli", "unavailable"].includes(status.museCode.error),
				"Fake deliberately lacks required account/permission protocol"
			);
			assert.ok(cliAttempts().length > 0);
			await click(".coding-provider-card button", "Refresh status");
			await wait("explicit refresh settled", () =>
				js("document.querySelector('.coding-provider-card').dataset.codingPending==='none'")
			);
			await closeSettings();
			const evidence = await failedJob(repositoryId, fakeBin);
			assert.ok(
				control
					.rows(audit)
					.filter((row) => row.type === "fake-cli")
					.every((row) => row.leakedKeys.length === 0)
			);
			assert.ok(
				!control
					.rows(audit)
					.some(
						(row) =>
							row.type === "fake-cli-method" &&
							/(?:session|turn)\/(?:start|create)/.test(row.method ?? "")
					),
				"Unsupported metadata must never start a model turn"
			);
			return { status, ...evidence };
		});
		let metaJob;
		await phase(
			"Explicit API choice starts actual Meta child work and persists its provider pin",
			async () => {
				await openSettings();
				const before = cliAttempts().length;
				const status = await configure("meta-api", fakeBin);
				assert.equal(status.ready, true);
				assert.equal(cliAttempts().length, before, "API configure must not probe CLI");
				await closeSettings();
				await selectTicket();
				await fillTicket(repositoryId);
				await click("form.hub-start-work button[type=submit]", "Start work");
				metaJob = await wait(
					"actual Meta decision result",
					async () => {
						const state = await snapshot();
						const candidate = state.jobs.find((job) => job.state === "needs-input");
						if (!candidate) return null;
						return rpc("query", "hub.job", { id: candidate.id });
					},
					60_000
				);
				assert.equal(metaJob.decisions[0].question, fixtures.QUESTION);
				const pin = control.childPin(audit, metaJob.id);
				assert.equal(pin.value.settings.provider, "meta-api");
				assert.ok(
					control
						.rows(audit)
						.some((row) => row.type === "child-meta-http" && row.jobId === metaJob.id)
				);
				const checkpoint = JSON.parse(fs.readFileSync(pin.run.checkpointPath, "utf8"));
				assert.equal(checkpoint.result.status, "needs-input");
				assert.equal(
					fs.readFileSync(join(metaJob.worktreePath, fixtures.SOURCE), "utf8"),
					fixtures.BASE
				);
				return { jobId: metaJob.id, pin: pin.value, actualDecision: metaJob.decisions[0].question };
			}
		);
		await phase(
			"Existing Meta child resumes after new-job preference changes and executes real checks",
			async () => {
				await openSettings();
				await configure("muse-code", missingBin);
				await closeSettings();
				await wait("actual pending decision form", () =>
					js(
						`document.querySelector('form.hub-decision h2')?.textContent===${JSON.stringify(fixtures.QUESTION)}`
					)
				);
				await field("form.hub-decision textarea", fixtures.ANSWER);
				await click("form.hub-decision button[type=submit]", "Send decision");
				const job = await wait(
					"real Meta worker commit and checks",
					async () => {
						const value = await rpc("query", "hub.job", { id: metaJob.id });
						assert.notEqual(value.state, "failed", value.error);
						return value.state === "ready" ? value : null;
					},
					60_000
				);
				assert.equal(control.childPin(audit, job.id).value.settings.provider, "meta-api");
				assert.equal((await rpc("query", "codingProvider.status")).settings.provider, "muse-code");
				assert.ok(job.checks.length > 0);
				for (const check of job.checks) {
					assert.equal(check.exitCode, 0);
					assert.equal(check.commitSha, job.headSha);
					assert.deepEqual([check.command, ...check.args], ["npm", "run", "test"]);
				}
				assert.equal(
					fixtures.git(job.worktreePath, "show", `${job.headSha}:${fixtures.SOURCE}`),
					fixtures.FINAL
				);
				assert.equal(fixtures.git(job.worktreePath, "status", "--porcelain=v1"), "");
				assert.equal(job.pullRequest, null);
				assert.equal(job.reviewedAt, null);
				return {
					jobId: job.id,
					provider: "meta-api",
					currentPreference: "muse-code",
					headSha: job.headSha,
					checks: job.checks,
				};
			}
		);
		await wait("all real coding children exited", () =>
			report.children.every((child) => child.exited)
		);
		assert.equal(
			report.children.length,
			4,
			"Two failed Muse children plus one Meta decision/resume pair"
		);
		assert.equal(fs.readFileSync(join(fixture.localPath, fixtures.SOURCE), "utf8"), fixture.dirty);
		assert.equal(fixtures.git(fixture.localPath, "status", "--porcelain=v1"), fixture.status);
		assert.deepEqual(report.blocked, []);
		assert.ok(
			control
				.rows(audit)
				.filter((row) => row.type === "cli-attempt")
				.every((row) => row.permitted)
		);
		report.originalPreserved = true;
		report.status = "passed";
		await stop();
	} catch (error) {
		await stop(error);
	}
}
function selfCheck() {
	assert.equal(control.isCLI("/controlled/muse", ["--version"]), true);
	assert.equal(control.isCLI("git", ["status"]), false);
	const initialized = fakeCLI.frame({ id: 1, method: "initialize" });
	assert.deepEqual(initialized.result.capabilities, {});
	assert.equal(fakeCLI.frame({ id: 2, method: "account/read" }).error.code, -32601);
	assert.equal(fakeCLI.frame({ method: "initialized" }), null);
	assert.throws(() => fixtures.github("https://attacker.test/user", "GET"));
	assert.throws(() => fixtures.github(`https://api.github.com/repos/${fixtures.REPO}`, "POST"));
	assert.equal(fixtures.github("https://api.github.com/user", "GET").login, "executive-reviewer");
	assert.equal(
		fixtures.linear({ query: "query HubViewer {}" }, { type: "unstarted" }).data.viewer.id,
		"controlled-viewer"
	);
	console.log(
		"CODING_PROVIDER_SELF_CHECK_PASS: pure fake-protocol/endpoint guards only; NO app/Electron/Git/SDK/CLI/child/server/model/network/microphone launched"
	);
}
if (
	require.main === module ||
	(process.versions.electron && process.argv[1] && resolve(process.argv[1]) === resolve(__filename))
) {
	Promise.resolve()
		.then(() => (process.argv.includes("--self-check") ? selfCheck() : native()))
		.catch((error) => {
			console.error(error.stack ?? error.message);
			process.exitCode = 1;
		});
}
