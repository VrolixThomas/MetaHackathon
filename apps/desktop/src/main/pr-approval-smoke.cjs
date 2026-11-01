// ROOT ONLY: build integration, then env -u ELECTRON_RUN_AS_NODE electron src/main/pr-approval-smoke.cjs.
// AUTHOR: node --check this-file. All HTTP providers are controlled; actual built UI/IPC/SQLite.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { createHash, randomUUID } = require("node:crypto");
const S = require("./pr-work-smoke-support.cjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wait(label, read, timeout = 45000) {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		const v = await read();
		if (v) return v;
		await sleep(50);
	}
	throw Error(`Timed out: ${label}`);
}
async function native() {
	assert.ok(
		process.versions.electron && !process.env.ELECTRON_RENDERER_URL,
		"Run built integration Electron only"
	);
	const { app, BrowserWindow, session, ipcMain } = require("electron");
	for (const key of Object.keys(process.env))
		if (
			/(?:TOKEN|SECRET|API_KEY|CLIENT_ID|VOICE_ID)/i.test(key) ||
			/^(?:SLACK_|LINEAR_|GITHUB_|GH_|META_|MODEL_|ELEVENLABS_|MUSE_)/.test(key)
		)
			delete process.env[key];
	const owned = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "met-pr-approval-")));
	const owner = randomUUID();
	fs.writeFileSync(join(owned, ".owner"), owner);
	const stat = fs.statSync(owned);
	const profile = join(owned, "profile");
	fs.mkdirSync(profile);
	app.setPath("userData", profile);
	const env = join(owned, ".env");
	fs.writeFileSync(
		env,
		"MODEL_API_KEY=controlled-approval-model\nGITHUB_TOKEN=controlled-approval-github\n",
		{ mode: 0o600 }
	);
	process.env.METAHACKATHON_ENV_FILE = env;
	const fixture = S.createRepository(owned);
	const built = resolve(process.argv[2] ?? join(__dirname, "../../out/main/index.js"));
	assert.ok(fs.existsSync(built));
	const out = join(__dirname, "../../out");
	fs.mkdirSync(out, { recursive: true });
	const reportPath = join(out, "pr-approval-smoke-report.json");
	const report = {
		status: "running",
		builtMain: built,
		builtMainSha256: createHash("sha256").update(fs.readFileSync(built)).digest("hex"),
		controlledProviders: true,
		liveGitHub: false,
		liveSpeech: false,
		fullProcessRestart: false,
		steps: [],
		posts: [],
		ipc: [],
		blocked: [],
	};
	const save = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
	const provider = { head: fixture.headSha, check: "pending", loseReceipt: false, actor: 9001 };
	const originalFetch = globalThis.fetch;
	const originalHandle = ipcMain.handle;
	let win;
	let stopping = false;
	let permitted = false;
	app.on("browser-window-created", (_, w) => {
		w.setFocusable(false);
		w.setIgnoreMouseEvents(true);
		w.webContents.on("before-input-event", (e) => e.preventDefault());
	});
	const ledger = () => {
		const Database = require("better-sqlite3");
		const db = new Database(join(profile, "metahackathon.db"), { readonly: true });
		try {
			return JSON.parse(db.prepare("SELECT data_json FROM hub_state WHERE id=1").get().data_json);
		} finally {
			db.close();
		}
	};
	ipcMain.handle = function (channel, handler) {
		if (channel !== "trpc:request") return originalHandle.call(this, channel, handler);
		return originalHandle.call(this, channel, async (event, request) => {
			const result = await handler(event, request);
			if (request.path.startsWith("prApprovals."))
				report.ipc.push({ path: request.path, input: request.input?.json, error: result?.error });
			return result;
		});
	};
	globalThis.fetch = async (input, init = {}) => {
		const url = String(typeof input === "string" ? input : (input.url ?? input));
		const method = init.method ?? "GET";
		try {
			if (url === S.modelURL) {
				assert.equal(method, "POST");
				return S.modelResponse(JSON.parse(init.body), Date.now());
			}
			assert.ok(url.startsWith("https://api.github.com/"));
			assert.equal(
				new Headers(init.headers).get("Authorization"),
				"Bearer controlled-approval-github"
			);
			const u = new URL(url);
			const path = u.pathname;
			if (method === "POST") {
				assert.equal(url, `${S.apiRoot}/pulls/7/reviews`);
				assert.ok(
					permitted,
					"Only explicit exact-policy consent enables a controlled review write"
				);
				const body = JSON.parse(init.body);
				assert.equal(body.event, "APPROVE");
				assert.equal(body.commit_id, provider.head);
				const p = ledger().approvalPolicies.find(
					(p) => p.attempt && body.body.includes(p.attempt.id)
				);
				assert.ok(p);
				assert.equal(p.status, "submitting");
				assert.ok(p.confirmedAt);
				assert.equal(p.terms.action, "approve");
				assert.equal(p.attempt.headSha, provider.head);
				assert.equal(p.evaluation.outcome, "satisfied");
				assert.equal(provider.check, "success");
				report.posts.push({ body, policyId: p.id, attemptId: p.attempt.id });
				if (provider.loseReceipt) throw new Error("Controlled lost response after accepted write");
				return Response.json({
					id: 700 + report.posts.length,
					html_url: `${S.prURL}#pullrequestreview-${700 + report.posts.length}`,
					state: "APPROVED",
					commit_id: provider.head,
					user: { id: provider.actor, login: "controlled-pr-reviewer" },
				});
			}
			assert.equal(method, "GET");
			if (path === `/repos/${S.repository}/rules/branches/main`) return Response.json([]);
			if (path === `/repos/${S.repository}/branches/main`)
				return Response.json({ protected: false });
			if (path.endsWith("/check-runs"))
				return Response.json({
					total_count: 1,
					check_runs: [
						{
							id: 1,
							name: "regression",
							head_sha: provider.head,
							status: provider.check === "pending" ? "in_progress" : "completed",
							conclusion: provider.check === "pending" ? null : provider.check,
							html_url: `${S.prURL}/checks`,
							app: { id: 42 },
						},
					],
				});
			if (path.endsWith("/statuses")) return Response.json([]);
			if (path.includes("/compare/"))
				return Response.json({
					status: "ahead",
					merge_base_commit: { sha: fixture.headSha },
					files: [{ filename: "a-logic.ts", status: "modified" }],
				});
			const result = S.githubGET(url, fixture, provider.head);
			if (path === "/user") {
				result.id = provider.actor;
				result.login = "controlled-pr-reviewer";
			}
			if (url === S.apiRoot) result.permissions = { push: true };
			if (url === `${S.apiRoot}/pulls/7`) result.user.id = 9002;
			return Response.json(result);
		} catch (e) {
			if (!String(e.message).startsWith("Controlled lost"))
				report.blocked.push({ url, method, message: e.message });
			throw e;
		}
	};
	const timeout = setTimeout(() => void stop(Error("Native approval gate deadline")), 240000);
	async function stop(error) {
		if (stopping) return;
		stopping = true;
		if (error) {
			report.status = "failed";
			report.error = error.stack;
			try {
				fs.writeFileSync(
					join(out, "pr-approval-smoke-failed.png"),
					(await win.webContents.capturePage()).toPNG()
				);
			} catch {}
		}
		save();
		app.quit();
	}
	app.on("will-quit", () => {
		clearTimeout(timeout);
		globalThis.fetch = originalFetch;
		ipcMain.handle = originalHandle;
		try {
			assert.equal(fs.realpathSync(owned), owned);
			const current = fs.statSync(owned);
			assert.equal(current.ino, stat.ino);
			assert.equal(current.dev, stat.dev);
			assert.equal(fs.readFileSync(join(owned, ".owner"), "utf8"), owner);
			fs.rmSync(owned, { recursive: true });
		} catch (e) {
			report.status = "failed";
			report.error = e.message;
		}
		save();
		console.log(`PR_APPROVAL_SMOKE_${report.status.toUpperCase()}: ${reportPath}`);
		if (report.status !== "passed") app.exit(1);
	});
	try {
		await app.whenReady();
		session.defaultSession.setPermissionRequestHandler((_, __, done) => done(false));
		session.defaultSession.setPermissionCheckHandler(() => false);
		session.defaultSession.webRequest.onBeforeRequest((details, done) => {
			const u = new URL(details.url);
			const allowed = ["file:", "data:", "blob:", "devtools:"].includes(u.protocol);
			if (!allowed) report.blocked.push({ chromium: u.origin });
			done({ cancel: !allowed });
		});
		await import(pathToFileURL(built).href);
		win = await wait("actual window", () => BrowserWindow.getAllWindows()[0]);
		await wait("renderer", () => !win.webContents.isLoadingMainFrame());
		const js = (code) => win.webContents.executeJavaScript(code);
		const rpc = async (type, path, input = {}) => {
			const response = await js(
				`window.electron.trpc.request(${JSON.stringify({ type, path, input: { json: input } })})`
			);
			assert.ok(!response.error, `${path}: ${JSON.stringify(response.error)}`);
			return response.result?.data?.json;
		};
		const click = (selector) =>
			js(
				`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Missing enabled control');e.click();})()`
			);
		const button = (text) =>
			js(
				`(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e||e.disabled)throw Error('Missing button '+${JSON.stringify(text)});e.click();})()`
			);
		const field = (selector, value) =>
			js(
				`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing field');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`
			);
		const step = async (label, work) => {
			const row = { label, status: "running" };
			report.steps.push(row);
			save();
			row.evidence = await work();
			row.status = "passed";
			save();
		};
		await step(
			"actual displayed PR and typed policy form require exact explicit confirmation",
			async () => {
				await wait("app", () =>
					js("!!document.querySelector('[data-testid=repository-selector]')")
				);
				await rpc("mutation", "reviews.connect", {
					repository: S.repository,
					localPath: fixture.localPath,
				});
				await wait("ready local preparation", async () => {
					const inbox = await rpc("query", "reviews.inbox");
					const row = inbox.items.find((i) => i.pr.id === S.prId);
					assert.notEqual(row?.status, "error", row?.error);
					return row?.status === "ready";
				});
				await click("[data-testid=repository-selector]");
				await wait("ready selector", () =>
					js(
						`!!document.querySelector('[data-pr-id="${S.prId}"] .review-inbox-select:not(:disabled)')`
					)
				);
				await click(`[data-pr-id="${S.prId}"] .review-inbox-select`);
				await wait("acknowledged actual source", () =>
					js(
						`document.querySelector('[aria-label="Prepared review"]')?.dataset.headSha===${JSON.stringify(fixture.headSha)} && document.querySelector('[aria-label="Prepared review"]')?.dataset.reviewLoading==='false'`
					)
				);
				await button("PR follow-up");
				await wait("followup dialog", () => js("document.querySelector('#pr-approvals')?.open"));
				await button("New delegation for displayed PR");
				await field("#pr-approvals fieldset input", "regression");
				await button("Review interpreted policy");
				await wait("exact server policy", () =>
					js("!!document.querySelector('[data-approval-id]')")
				);
				assert.equal(report.posts.length, 0);
				assert.equal(
					await js(
						"[...document.querySelectorAll('#pr-approvals button')].find(e=>e.textContent==='Confirm delegation').disabled"
					),
					true
				);
				await click('#pr-approvals input[type="checkbox"]');
				await button("Confirm delegation");
				await wait("monitoring saved policy", async () =>
					(await rpc("query", "prApprovals.list")).some((p) => p.status === "monitoring")
				);
				assert.equal(report.posts.length, 0);
				return { form: true, explicitConsent: true, sqlite: ledger().approvalPolicies[0].status };
			}
		);
		const sessionId = await js("document.querySelector('main[data-session-id]').dataset.sessionId");
		let first = (await rpc("query", "prApprovals.list"))[0];
		await step("editing advances revision and retires old exact consent", async () => {
			const edited = await rpc("mutation", "prApprovals.draft", {
				sessionId,
				id: first.id,
				revision: first.revision,
				terms: { ...first.terms, action: "approve" },
			});
			const old = await js(
				`window.electron.trpc.request(${JSON.stringify({ type: "mutation", path: "prApprovals.confirm", input: { json: { id: first.id, revision: first.revision, digest: first.digest, confirmed: true } } })})`
			);
			assert.ok(old.error);
			assert.equal(edited.status, "draft");
			assert.equal(edited.confirmedAt, null);
			first = edited;
			return { revision: edited.revision };
		});
		await step(
			"successful check transition produces one real review path and durable head-bound receipt",
			async () => {
				permitted = true;
				provider.check = "success";
				await rpc("mutation", "prApprovals.confirm", {
					id: first.id,
					revision: first.revision,
					digest: first.digest,
					confirmed: true,
				});
				const approved = await wait("actual approved receipt", async () =>
					(await rpc("query", "prApprovals.list")).find(
						(p) => p.id === first.id && p.status === "approved"
					)
				);
				assert.equal(report.posts.length, 1);
				assert.equal(approved.attempt.receipt.id, 701);
				assert.equal(ledger().approvalPolicies[0].attempt.receipt.id, 701);
				return approved.attempt;
			}
		);
		await step(
			"renderer reload restores durable outcome without duplicate submission",
			async () => {
				const loaded = new Promise((r) => win.webContents.once("did-finish-load", r));
				win.webContents.reload();
				await loaded;
				await wait("restored app", () =>
					js("!!document.querySelector('[data-testid=repository-selector]')")
				);
				const rows = await rpc("query", "prApprovals.list");
				assert.equal(rows[0].attempt.receipt.id, 701);
				assert.equal(report.posts.length, 1);
				return { rendererReloadOnly: true, receipt: rows[0].attempt.receipt };
			}
		);
		await click("[data-testid=repository-selector]");
		await wait("restored selector", () =>
			js(`!!document.querySelector('[data-pr-id="${S.prId}"] .review-inbox-select:not(:disabled)')`)
		);
		await click(`[data-pr-id="${S.prId}"] .review-inbox-select`);
		await wait("restored displayed source", () =>
			js(
				`document.querySelector('[aria-label="Prepared review"]')?.dataset.headSha===${JSON.stringify(fixture.headSha)} && document.querySelector('[aria-label="Prepared review"]')?.dataset.reviewLoading==='false'`
			)
		);
		const currentSession = await js(
			"document.querySelector('main[data-session-id]').dataset.sessionId"
		);
		const draft = () =>
			rpc("mutation", "prApprovals.draft", {
				sessionId: currentSession,
				terms: { ...first.terms, action: "approve" },
			});
		const confirm = (p) =>
			rpc("mutation", "prApprovals.confirm", {
				id: p.id,
				revision: p.revision,
				digest: p.digest,
				confirmed: true,
			});
		await step(
			"revocation persists before evidence changes and fences later monitoring",
			async () => {
				provider.check = "pending";
				const p = await draft();
				await confirm(p);
				await rpc("mutation", "prApprovals.revoke", { id: p.id, revision: p.revision });
				provider.check = "success";
				const revoked = (await rpc("query", "prApprovals.list")).find((r) => r.id === p.id);
				assert.equal(revoked.status, "revoked");
				assert.equal(ledger().approvalPolicies.find((r) => r.id === p.id).status, "revoked");
				assert.equal(report.posts.length, 1);
				return { id: p.id, status: revoked.status };
			}
		);
		await step("an unrelated new head returns a durable focused review decision", async () => {
			provider.check = "pending";
			const p = await draft();
			await confirm(p);
			await wait(
				"pending evaluation",
				async () =>
					(await rpc("query", "prApprovals.list")).find((r) => r.id === p.id)?.evaluation
						?.outcome === "waiting"
			);
			provider.head = fixture.movedSha;
			provider.check = "success";
			const changed = await wait("unrelated scope requires review", async () =>
				(await rpc("query", "prApprovals.list")).find(
					(r) => r.id === p.id && r.status === "needs-review"
				)
			);
			assert.equal(report.posts.length, 1);
			assert.ok(ledger().notices.some((n) => n.kind === "pr-approval" && n.jobId === p.id));
			await rpc("mutation", "prApprovals.revoke", { id: p.id, revision: p.revision });
			provider.head = fixture.headSha;
			return changed.evaluation;
		});
		await step(
			"lost approval response retains one durable attempt and does not replay",
			async () => {
				provider.check = "success";
				provider.loseReceipt = true;
				const p = await draft();
				await confirm(p);
				const uncertain = await wait("uncertain durable write", async () =>
					(await rpc("query", "prApprovals.list")).find(
						(r) => r.id === p.id && r.status === "uncertain"
					)
				);
				assert.equal(report.posts.length, 2);
				assert.equal(uncertain.attempt.receipt, null);
				assert.equal(
					ledger().approvalPolicies.find((r) => r.id === p.id).attempt.id,
					uncertain.attempt.id
				);
				const loaded = new Promise((r) => win.webContents.once("did-finish-load", r));
				win.webContents.reload();
				await loaded;
				await wait("reloaded unknown outcome", async () =>
					(await rpc("query", "prApprovals.list")).find(
						(r) => r.id === p.id && r.status === "uncertain"
					)
				);
				assert.equal(report.posts.length, 2);
				return uncertain.attempt;
			}
		);
		assert.equal(fs.readFileSync(join(fixture.localPath, "a-logic.ts"), "utf8"), fixture.dirty);
		assert.equal(S.git(fixture.localPath, "status", "--porcelain=v1"), fixture.status);
		assert.deepEqual(report.blocked, []);
		report.status = "passed";
		await stop();
	} catch (error) {
		await stop(error);
	}
}
if (require.main === module || process.versions.electron)
	native().catch((e) => {
		console.error(e.stack);
		process.exitCode = 1;
	});
