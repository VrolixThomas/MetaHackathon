// ROOT-ONLY NATIVE RUNNER. Build the integrated app first, then launch with Electron:
// env -u ELECTRON_RUN_AS_NODE electron src/main/browser-flow-smoke.cjs [built-main] [evidence-dir]
// The authoring worker must use node --check and check-browser-flow.cjs --self-test only.
const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { fileURLToPath, pathToFileURL } = require("node:url");
const { app, BrowserWindow } = require("electron");
const {
	FLOW,
	PROMO_CODE,
	CANCEL_QUESTION,
	DRAFT_QUESTION,
	LATE_TEXT,
	createBrowserFlowProvider,
} = require("./browser-flow-provider.cjs");

assert.ok(process.versions.electron, "Run this file only in the root's native Electron acceptance");
assert.ok(!process.env.ELECTRON_RENDERER_URL, "Use the built renderer, not a dev-server override");
const builtMain = resolve(process.argv[2] ?? join(__dirname, "../../out/main/index.js"));
const evidenceDir = resolve(process.argv[3] ?? join(__dirname, "../../out/browser-flow-smoke"));
mkdirSync(evidenceDir, { recursive: true });
const reportPath = join(evidenceDir, "report.json");
rmSync(reportPath, { force: true });
const userData = mkdtempSync(join(tmpdir(), "metahackathon-browser-flow-"));
const userDataOwner = randomUUID();
writeFileSync(join(userData, ".browser-flow-owner"), userDataOwner);
app.setPath("userData", userData);
const provider = createBrowserFlowProvider({ forwardFetch: globalThis.fetch.bind(globalThis) });
globalThis.fetch = provider.fetch;
const report = {
	mode: "actual-built-electron-renderer-browser-flow",
	simulatedProvider: true,
	liveSpeech: false,
	status: "running",
	builtMain,
	builtMainSha256: createHash("sha256").update(readFileSync(builtMain)).digest("hex"),
	userData,
	userDataOwner,
	evidenceDir,
	scriptedPromoChoice: PROMO_CODE,
	steps: [],
	ports: [],
	note: "Only the Meta response provider is simulated. Browser/scenario/source results are actual local execution. No live speech or GitHub posting.",
};
const writeEvidence = (name, value) => {
	const path = join(evidenceDir, name);
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
	return path;
};
const save = () => {
	report.providerEvidence = writeEvidence("provider.json", provider.records);
	report.blockedExternalRequests = [...provider.blocked];
	writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
};
let cleanupCredentials = async () => {};
const deadline = setTimeout(() => {
	report.status = "failed";
	report.error = "Native browser acceptance hard deadline";
	save();
	app.exit(1);
}, 420_000);
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(label, predicate, timeout = 40_000) {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		const value = await predicate();
		if (value) return value;
		await pause(50);
	}
	throw new Error(`Timed out waiting for ${label}`);
}
const normalized = (text) =>
	String(text ?? "")
		.replace(/\s+/g, " ")
		.trim();
const uiScript = `(() => {
	const panel = document.querySelector('aside[aria-label="Review conversation"]');
	const host = document.querySelector('[data-browser-content="true"]');
	const rect = host?.getBoundingClientRect();
	const question = [...document.querySelectorAll('.user-words')].at(-1)?.textContent || '';
	return {
		state: panel?.dataset.conversationState, sessionId: panel?.dataset.sessionId,
		turnId: panel?.dataset.turnId, generation: Number(panel?.dataset.generation),
		requestId: panel?.dataset.requestId, question,
		answer: [...document.querySelectorAll('.conversation-answer')].at(-1)?.textContent || '',
		error: panel?.querySelector('[role="alert"]')?.textContent || '',
		surface: document.querySelector('[data-workspace-surface]')?.dataset.workspaceSurface,
		codePath: document.querySelector('.code-header .breadcrumb strong')?.textContent,
		highlighted: [...document.querySelectorAll('[data-highlighted="true"] code')].map(e => e.textContent),
		browserVisible: !!host && !!rect?.width && !!rect?.height && !host.closest('[hidden]'),
		browserBounds: rect ? {x:rect.x,y:rect.y,width:rect.width,height:rect.height} : null,
		inputEnabled: !!document.querySelector('input[name="question"]:not(:disabled)'),
		source: document.querySelector('.workspace-source')?.textContent
	};
})()`;
const pageScript = `(() => {
	const pay = document.querySelector('[data-preview-marker="pay-button"]');
	const rect = pay?.getBoundingClientRect();
	const total = [...document.querySelectorAll('p')].find(e => /^Total\\s/.test(e.textContent.trim()));
	return {url:location.href,title:document.title,viewport:{width:innerWidth,height:innerHeight},
		scroll:{x:scrollX,y:scrollY},promo:document.querySelector('input[name="promo"]')?.value,
		total:total?.textContent.trim(),text:document.body.innerText,
		pay:rect ? {text:pay.textContent,bounds:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},
			visible:rect.width>0 && rect.height>0 && rect.bottom>0 && rect.top<innerHeight} : null};
})()`;

(async () => {
	await import(pathToFileURL(builtMain).href);
	await app.whenReady();
	const win = await until("built main window", () => BrowserWindow.getAllWindows()[0]);
	// This acceptance checks a visible native surface; foreground the test window explicitly.
	win.show();
	app.focus({ steal: true });
	win.focus();
	await until("built renderer load", () => !win.webContents.isLoadingMainFrame());
	const ui = () => win.webContents.executeJavaScript(uiScript);
	const rawRpc = (type, path, input) =>
		win.webContents.executeJavaScript(
			`window.electron.trpc.request(${JSON.stringify({ type, path, input: { json: input ?? null } })})`
		);
	const rpc = async (type, path, input) => {
		const response = await rawRpc(type, path, input);
		assert.ok(!response.error, `${path}: ${JSON.stringify(response.error)}`);
		return response.result.data.json;
	};
	cleanupCredentials = async () => {
		for (const provider of ["meta", "elevenlabs"])
			await rpc("mutation", "runtime.deleteCredential", { provider });
	};
	const identity = (snapshot) => {
		assert.ok(snapshot.sessionId && snapshot.turnId && Number.isSafeInteger(snapshot.generation));
		return {
			sessionId: snapshot.sessionId,
			turnId: snapshot.turnId,
			generation: snapshot.generation,
		};
	};
	const poll = (turn) => rpc("query", "agent.poll", { ...turn, afterSequence: 0, limit: 100 });
	const observe = (sessionId) => rpc("query", "browser.observe", { sessionId });
	async function submit(text, waitForCompletion = true) {
		const previous = await ui();
		await win.webContents.executeJavaScript(`(() => {
			const input = document.querySelector('input[name="question"]');
			if (!input || input.disabled || !input.form) throw Error('Composer unavailable');
			input.value = ${JSON.stringify(text)};
			input.dispatchEvent(new Event('input', {bubbles:true}));
			input.form.requestSubmit();
		})()`);
		const started = await until("new form-submitted turn identity", async () => {
			const snapshot = await ui();
			return snapshot.turnId && snapshot.turnId !== previous.turnId && snapshot.question === text
				? snapshot
				: null;
		});
		const turn = identity(started);
		const surfaces = new Set([started.surface]);
		if (!waitForCompletion) return { turn, started };
		const finished = await until(
			`UI completion: ${text}`,
			async () => {
				const snapshot = await ui();
				assert.equal(snapshot.turnId, turn.turnId, "Another turn replaced the submitted question");
				surfaces.add(snapshot.surface);
				assert.notEqual(snapshot.state, "error", snapshot.error || "UI turn failed");
				assert.notEqual(snapshot.state, "cancelled", "Flow turn unexpectedly cancelled");
				return snapshot.state === "complete" ? snapshot : null;
			},
			60_000
		);
		const result = await poll(turn);
		assert.equal(result.status, "completed");
		assert.equal(normalized(finished.answer), normalized(result.text));
		assert.ok(result.text.length > 0, "UI completion needs a provider response, not just a click");
		for (const action of result.actions) {
			assert.equal(action.sessionId, turn.sessionId);
			assert.equal(action.turnId, turn.turnId);
			assert.equal(action.generation, turn.generation);
		}
		return { turn, ui: finished, result, surfaces: [...surfaces] };
	}
	async function visibleBrowser(sessionId, expected) {
		const observation = await observe(sessionId);
		assert.equal(observation?.provenance, "live-browser");
		assert.equal(observation.revision, expected.revision);
		assert.equal(
			observation.commitSha,
			report.pr[expected.revision === "head" ? "headSha" : "baseSha"]
		);
		const host = await until("UI browser surface", async () => {
			const snapshot = await ui();
			return snapshot.surface === "browser" && snapshot.browserVisible ? snapshot : null;
		});
		const view = await until("attached visible WebContentsView", () =>
			win.contentView.children.find(
				(child) =>
					child.webContents &&
					!child.webContents.isDestroyed() &&
					child.webContents.getURL() === observation.url &&
					child.getVisible()
			)
		);
		const page = await view.webContents.executeJavaScript(pageScript);
		assert.equal(page.url, observation.url);
		assert.equal(page.title, observation.title);
		assert.deepEqual(page.viewport, observation.viewport);
		assert.deepEqual(page.viewport, expected.viewport);
		assert.ok(Math.abs(page.scroll.y - observation.scroll.y) <= 1);
		assert.ok(Math.abs(page.scroll.x - observation.scroll.x) <= 1);
		assert.ok(!new URL(page.url).searchParams.has("pay"), "Never submit the payment button");
		assert.ok(normalized(page.total).includes(`€${expected.total.toFixed(2)}`), page.total);
		assert.ok(
			[observation.text, ...observation.elements.map((element) => element.name)]
				.join(" ")
				.includes(`€${expected.total.toFixed(2)}`),
			"Actual browser observation must expose the total or payment amount"
		);
		if (expected.applied) {
			assert.equal(page.promo, PROMO_CODE);
			assert.equal(new URL(page.url).searchParams.get("promo"), PROMO_CODE);
		}
		const nativeBounds = view.getBounds();
		assert.ok(nativeBounds.width > 0 && nativeBounds.height > 0);
		assert.ok(Math.abs(nativeBounds.x - host.browserBounds.x) <= 2);
		assert.ok(Math.abs(nativeBounds.y - host.browserBounds.y) <= 2);
		const preferences = view.webContents.getLastWebPreferences();
		assert.equal(preferences.sandbox, true);
		assert.equal(preferences.contextIsolation, true);
		assert.equal(preferences.nodeIntegration, false);
		report.ports = [...new Set([...report.ports, Number(new URL(page.url).port)])];
		return { observation, page, webContentsId: view.webContents.id, nativeBounds };
	}

	const statuses = await rpc("query", "runtime.credentialStatus");
	assert.ok(
		statuses.every((entry) => !entry.configured),
		"Use an empty temporary credential store"
	);
	const initialVoice = await rpc("query", "voice.status");
	assert.equal(initialVoice.phase, "unconfigured");
	assert.ok(initialVoice.missing.includes("meta") && initialVoice.missing.includes("elevenlabs"));
	report.voice = { initial: initialVoice, localVoiceReady: false, liveSpeech: false };
	const dummyKey = "browser-flow-simulated-provider-only-not-a-real-key";
	const configured = await rpc("mutation", "runtime.setCredential", {
		provider: "meta",
		secret: dummyKey,
	});
	assert.ok(configured.some((entry) => entry.provider === "meta" && entry.configured));
	const encryptedFile = join(userData, "credentials", "credentials.encrypted.json");
	assert.ok(!readFileSync(encryptedFile, "utf8").includes(dummyKey));
	await until("load-demo button", () =>
		win.webContents.executeJavaScript(`(() => {
			const button = [...document.querySelectorAll('button')].find(e => e.textContent.trim() === 'Load local demo');
			if (!button || button.disabled) return false;
			button.click(); return true;
		})()`)
	);
	await until("prepared repository in renderer", async () => {
		const snapshot = await ui();
		return snapshot.inputEnabled && normalized(snapshot.source) === "Pinned source";
	});
	let persistentView;
	let headBrowser;
	for (const entry of FLOW) {
		const completed = await submit(entry.text);
		const record = provider.records.find((item) => item.question === entry.text);
		assert.ok(record, "Actual renderer question did not reach model endpoint");
		report.pr ??= record.pr;
		assert.notEqual(report.pr.baseSha, report.pr.headSha);
		const evidence = { ...completed };
		if (entry.id === "walk" || entry.id === "code") {
			assert.equal(completed.ui.surface, "code");
			const action = completed.result.actions.find((item) => item.kind === "highlight-code");
			assert.ok(action);
			assert.equal(completed.ui.codePath, action.location.path);
			const source = await rpc("query", "runtime.source", {
				prId: report.pr.id,
				revision: action.location.revision,
				path: action.location.path,
			});
			assert.equal(source.commitSha, action.location.commitSha);
			const line = source.content.split("\n")[action.location.startLine - 1];
			assert.ok(completed.ui.highlighted.some((text) => normalized(text) === normalized(line)));
			evidence.code = { location: action.location, line };
		} else {
			const base = entry.id === "compare";
			const phone = ["phone", "payment", "compare"].includes(entry.id);
			evidence.browser = await visibleBrowser(completed.turn.sessionId, {
				revision: base ? "base" : "head",
				viewport: phone ? { width: 390, height: 844 } : { width: 1024, height: 768 },
				total: base ? 102 : entry.id === "checkout" ? 72 : 78,
				applied: entry.id !== "checkout",
			});
			if (!base) {
				persistentView ??= evidence.browser.webContentsId;
				assert.equal(
					evidence.browser.webContentsId,
					persistentView,
					"Replaced the visible head page"
				);
				headBrowser = evidence.browser.observation;
			}
			if (entry.id === "payment") {
				assert.ok(evidence.browser.page.pay?.visible);
				assert.ok(evidence.browser.page.scroll.y > 0, "Payment scroll must actually move the page");
			}
			if (base) {
				assert.notEqual(evidence.browser.observation.browserId, headBrowser.browserId);
				const action = completed.result.actions.find((item) => item.kind === "show-scenario");
				assert.ok(action, "Compare turn must execute and expose Scenario C");
				const trace = await rpc("query", "artifacts.getScenario", {
					id: action.scenarioId,
					prId: report.pr.id,
				});
				const results = {};
				for (const [side, run] of [
					["base", trace.before],
					["head", trace.after],
				]) {
					assert.equal(run.evidence.kind, "execution");
					assert.equal(run.commitSha, report.pr[side === "base" ? "baseSha" : "headSha"]);
					assert.equal(run.evidence.commitSha, run.commitSha);
					assert.equal(run.evidence.exitCode, 0);
					const log = JSON.parse(readFileSync(fileURLToPath(run.evidence.logUrl), "utf8"));
					const resultLine = log.stdout
						.split("\n")
						.find((line) => line.startsWith("METAHACKATHON_RESULT "));
					assert.ok(resultLine, "Actual execution log must contain its scenario result");
					results[side] = JSON.parse(resultLine.slice("METAHACKATHON_RESULT ".length));
					writeEvidence(`scenario-${side}-log.json`, log);
				}
				assert.deepEqual(
					results.base.sent.map((item) => item.total),
					[108, 72]
				);
				assert.equal(results.base.batchStopped, false);
				assert.deepEqual(results.head.sent, []);
				assert.equal(results.head.error, "PromoExpiredError");
				assert.equal(results.head.batchStopped, true);
				report.scenarioEvidence = writeEvidence("scenario-C.json", { trace, results });
			}
		}
		const path = writeEvidence(`${report.steps.length + 1}-${entry.id}.json`, evidence);
		report.steps.push({ ...entry, status: "passed", turn: completed.turn, evidencePath: path });
		save();
		console.log(`BROWSER_FLOW_STEP_PASS: ${entry.id}`);
	}

	// Exercise rejection through the real boundary without applying another browser mutation.
	const sessionId = report.steps[0].turn.sessionId;
	const beforeStale = await observe(sessionId);
	const staleTarget = beforeStale.elements.find(
		(element) => element.tag === "input" && /promo/i.test(element.name)
	);
	assert.ok(staleTarget && beforeStale.sequence > 0);
	const stale = await rawRpc("mutation", "browser.execute", {
		kind: "type",
		sessionId,
		requestId: "acceptance-stale-browser-command",
		browserId: beforeStale.browserId,
		elementId: staleTarget.id,
		observationSequence: beforeStale.sequence - 1,
		text: "MUST-NOT-BE-APPLIED",
	});
	assert.ok(stale.error, "Runtime accepted an obsolete element observation");
	const afterStale = await observe(sessionId);
	assert.equal(afterStale.url, beforeStale.url);
	assert.equal(
		afterStale.elements.find((element) => element.id === staleTarget.id)?.value,
		PROMO_CODE
	);
	report.staleObservationRejected = true;

	const draftTurn = await submit(DRAFT_QUESTION);
	const draft = draftTurn.result.actions.find((action) => action.kind === "draft-comment")?.draft;
	assert.ok(draft);
	assert.equal(draft.originalWords, DRAFT_QUESTION);
	assert.deepEqual(await rpc("query", "agent.getDraft", { draftId: draft.id }), draft);
	const confirmation = {
		requestId: "acceptance-never-post",
		draftId: draft.id,
		draftRevision: draft.revision,
		headSha: draft.headSha,
		body: draft.body,
		confirmed: false,
	};
	const unconfirmed = await rawRpc("mutation", "agent.confirmComment", confirmation);
	assert.equal(unconfirmed.error?.data.code, "BAD_REQUEST");
	const changedBody = await rawRpc("mutation", "agent.confirmComment", {
		...confirmation,
		confirmed: true,
		body: `${draft.body} unconfirmed edit`,
	});
	assert.ok(changedBody.error, "Modified draft body crossed the confirmation boundary");
	const Database = require("better-sqlite3");
	const database = new Database(join(userData, "metahackathon.db"), { readonly: true });
	try {
		assert.equal(database.prepare("SELECT COUNT(*) AS n FROM runtime_submissions").get().n, 0);
	} finally {
		database.close();
	}
	report.confirmation = { unconfirmedRejected: true, changedBodyRejected: true, githubWrites: 0 };
	writeEvidence("confirmation-gate.json", { draft, unconfirmed, changedBody });
	const beforeCancel = await observe(sessionId);
	const cancelledTurn = await submit(CANCEL_QUESTION, false);
	await until("delayed simulated provider", () => provider.pendingCount === 1);
	const cancel = await rpc("mutation", "agent.cancel", {
		...cancelledTurn.turn,
		requestId: "acceptance-cancel",
		reason: "user",
	});
	assert.equal(cancel.status, "cancelled");
	provider.releaseDelayed();
	await until("renderer cancellation", async () => (await ui()).state === "cancelled");
	await pause(100);
	const cancelled = await poll(cancelledTurn.turn);
	assert.equal(cancelled.status, "cancelled");
	assert.equal(cancelled.actions.length, 0);
	assert.ok(!cancelled.text.includes(LATE_TEXT));
	assert.ok(!(await ui()).answer.includes(LATE_TEXT));
	const afterCancel = await observe(sessionId);
	assert.equal(afterCancel.browserId, beforeCancel.browserId);
	assert.equal(afterCancel.url, beforeCancel.url);
	report.cancellation = {
		lateOutputSuppressed: true,
		lateActionsSuppressed: true,
		status: cancelled.status,
	};
	writeEvidence("cancellation.json", { cancel, cancelled, beforeCancel, afterCancel });
	if (initialVoice.missing.includes("executable") || process.env.BROWSER_FLOW_VOICE_READY === "0") {
		report.voice.skipped = initialVoice.missing.includes("executable")
			? "missing-local-executable"
			: "disabled-by-root";
	} else {
		await rpc("mutation", "runtime.setCredential", {
			provider: "elevenlabs",
			secret: "browser-flow-local-ready-only-not-a-real-key",
		});
		await rpc("mutation", "voice.configure", { voiceId: "browser-flow-public-voice-id" });
		await rpc("mutation", "voice.prepare");
		const ready = await until(
			"real local voice sidecar readiness (no offer or speech)",
			async () => {
				const state = await rpc("query", "voice.status");
				assert.notEqual(state.phase, "error", state.error || "Local voice warmup failed");
				return state.phase === "ready" ? state : null;
			},
			180_000
		);
		report.voice = {
			...report.voice,
			localVoiceReady: true,
			ready,
			offerSent: false,
			speechSent: false,
		};
	}
	await cleanupCredentials();
	assert.ok((await rpc("query", "runtime.credentialStatus")).every((entry) => !entry.configured));
	report.dummyCredentialRemoved = true;
	assert.deepEqual(provider.blocked, []);
	report.status = "passed";
	if (process.env.BROWSER_FLOW_HOLD === "1") {
		await win.webContents.executeJavaScript(`(() => {
			const button = [...document.querySelectorAll('nav[aria-label="Main workspace surfaces"] button')]
				.find(e => e.textContent.trim() === 'Browser');
			if (!button) throw Error('Browser workspace control unavailable');
			button.click();
		})()`);
		await visibleBrowser(sessionId, {
			revision: "base",
			viewport: { width: 390, height: 844 },
			total: 102,
			applied: true,
		});
		report.holdingForRootScreenshots = true;
	}
	save();
	console.log(`BROWSER_FLOW_PASS: ${reportPath}; simulatedProvider=true; liveSpeech=false`);
	app.once("will-quit", () => clearTimeout(deadline));
	if (report.holdingForRootScreenshots) {
		clearTimeout(deadline);
		process.once("SIGINT", () => app.quit());
		process.once("SIGTERM", () => app.quit());
		win.once("closed", () => app.quit());
		console.log(
			"BROWSER_FLOW_HOLD: root may capture the visible base browser; close to verify shutdown"
		);
		return;
	}
	app.quit();
})().catch(async (error) => {
	report.status = "failed";
	report.error = error instanceof Error ? error.stack : String(error);
	provider.releaseDelayed();
	await Promise.race([cleanupCredentials().catch(() => {}), pause(2000)]);
	save();
	console.error("BROWSER_FLOW_FAIL:", report.error);
	app.once("will-quit", () => {
		clearTimeout(deadline);
		app.exit(1);
	});
	app.quit();
});
