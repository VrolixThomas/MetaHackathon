const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const net = require("node:net");
const { app, BrowserWindow } = require("electron");
const reportPath = join(__dirname, "../../out/integration-smoke-report.json");
rmSync(reportPath, { force: true });
const externalRequests = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
	const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
	if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
		externalRequests.push(url.origin);
		return Promise.reject(new Error("Integration smoke forbids external provider requests"));
	}
	return originalFetch(input, options);
};
const userData = mkdtempSync(join(tmpdir(), "metahackathon-integrated-"));
app.setPath("userData", userData);
const hardDeadline = setTimeout(() => {
	console.error("INTEGRATED_SMOKE_FAIL: hard deadline");
	app.exit(1);
}, 60000);
const portOpen = (port) =>
	new Promise((resolve) => {
		const socket = net.createConnection({ host: "127.0.0.1", port });
		socket.setTimeout(700);
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => {
			socket.destroy();
			resolve(false);
		});
		socket.once("timeout", () => {
			socket.destroy();
			resolve(false);
		});
	});
(async () => {
	await import(pathToFileURL(process.argv[2] ?? join(__dirname, "../../out/main/index.js")).href);
	await app.whenReady();
	const win = BrowserWindow.getAllWindows()[0];
	assert.ok(win, "Main window created");
	if (win.webContents.isLoadingMainFrame())
		await new Promise((resolve, reject) => {
			win.webContents.once("did-finish-load", resolve);
			win.webContents.once("did-fail-load", (_event, code, detail) =>
				reject(new Error(`${code}: ${detail}`))
			);
		});
	const rpc = (type, path, input) =>
		win.webContents.executeJavaScript(
			`window.electron.trpc.request(${JSON.stringify({ type, path, input: { json: input ?? null } })})`
		);
	const value = (response) => {
		if (response.error) throw new Error(JSON.stringify(response.error));
		return response.result.data.json;
	};
	const prs = value(await rpc("mutation", "runtime.prepareDemo"));
	const pr = prs.find((item) => item.repository === "demo/shop-web");
	assert.ok(pr);
	assert.notEqual(pr.headSha, "2".repeat(40));
	assert.notEqual(pr.baseSha, pr.headSha);
	const source = value(
		await rpc("query", "runtime.source", {
			prId: pr.id,
			revision: "head",
			path: "pricing/applyDiscounts.ts",
		})
	);
	assert.equal(source.prId, pr.id);
	assert.equal(source.commitSha, pr.headSha);
	assert.ok(source.content.includes("throw new PromoExpiredError"));
	const screenContext = {
		prId: pr.id,
		sequence: 1,
		panel: "diff",
		focusedLocation: {
			repository: pr.repository,
			revision: "head",
			commitSha: pr.headSha,
			path: source.path,
			startLine: 1,
			endLine: 1,
		},
	};
	const screenInput = { sessionId: "integrated-screen", screenContext };
	assert.equal(value(await rpc("mutation", "screen.update", screenInput)).sequence, 1);
	assert.equal(
		value(
			await rpc("mutation", "screen.update", {
				...screenInput,
				screenContext: { ...screenContext, sequence: 2, panel: "why" },
			})
		).sequence,
		2
	);
	assert.equal(value(await rpc("mutation", "screen.update", screenInput)).sequence, 2);
	value(await rpc("mutation", "screen.release", { sessionId: screenInput.sessionId }));
	assert.equal(value(await rpc("mutation", "screen.update", screenInput)).sequence, 1);
	const absent = value(
		await rpc("query", "runtime.source", {
			prId: pr.id,
			revision: "base",
			path: "promo/PromoCache.ts",
		})
	);
	assert.equal(absent.content, null);
	const bad = await rpc("query", "runtime.source", {
		prId: pr.id,
		revision: "head",
		path: "../outside",
	});
	assert.equal(bad.error.data.code, "BAD_REQUEST");
	const hidden = await rpc("query", "runtime.credentials.get", { provider: "meta" });
	assert.equal(hidden.error.data.code, "NOT_FOUND");
	const statuses = value(await rpc("query", "runtime.credentialStatus"));
	assert.ok(Array.isArray(statuses));
	assert.equal(statuses.length, 3);
	assert.ok(statuses.every((row) => row.configured === false && !("secret" in row)));
	const preparation = value(await rpc("mutation", "review.prepare", { prId: pr.id }));
	assert.ok(
		preparation.sourceContext.some(
			(entry) =>
				entry.location.path === source.path &&
				entry.location.revision === "head" &&
				entry.location.commitSha === pr.headSha &&
				entry.text.includes("throw new PromoExpiredError")
		)
	);
	const turn = {
		requestId: "integrated-no-key",
		sessionId: "integrated-agent",
		turnId: "turn-1",
		generation: 1,
		text: "What changed?",
		screenContext,
	};
	value(await rpc("mutation", "agent.start", turn));
	let polled;
	for (let attempt = 0; attempt < 100; attempt++) {
		polled = value(
			await rpc("query", "agent.poll", {
				sessionId: turn.sessionId,
				turnId: turn.turnId,
				generation: turn.generation,
				afterSequence: 0,
				limit: 100,
			})
		);
		if (polled.status !== "running") break;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.equal(polled.status, "error");
	assert.ok(polled.events.some((event) => event.kind === "acknowledgement"));
	assert.ok(
		polled.events.some((event) => event.kind === "error" && event.message.includes("credential"))
	);
	value(await rpc("mutation", "agent.release", { sessionId: turn.sessionId }));
	const scenario = value(
		await rpc("mutation", "runtime.runScenario", {
			requestId: "integrated-scenario-c",
			prId: pr.id,
			scenarioId: "C",
		})
	);
	assert.equal(scenario.trace.before.evidence.kind, "execution");
	assert.equal(scenario.trace.after.evidence.kind, "execution");
	assert.equal(scenario.trace.before.commitSha, pr.baseSha);
	assert.equal(scenario.trace.after.commitSha, pr.headSha);
	const catalogTrace = value(
		await rpc("query", "artifacts.getScenario", { id: scenario.trace.id, prId: pr.id })
	);
	assert.deepEqual(catalogTrace, scenario.trace);
	const thrown = scenario.trace.after.steps.find((step) => step.outcome === "throw");
	assert.ok(thrown);
	const throwSource = value(
		await rpc("query", "runtime.source", {
			prId: pr.id,
			revision: "head",
			path: thrown.location.path,
		})
	);
	assert.ok(
		throwSource.content
			.split("\n")
			[thrown.location.startLine - 1].includes("throw new PromoExpiredError")
	);
	const phone = value(
		await rpc("mutation", "runtime.startPreview", {
			requestId: "integrated-phone",
			prId: pr.id,
			mode: "phone",
		})
	);
	const desktop = value(
		await rpc("mutation", "runtime.startPreview", {
			requestId: "integrated-desktop",
			prId: pr.id,
			mode: "desktop",
		})
	);
	assert.equal(phone.evidence.kind, "execution");
	assert.equal(desktop.evidence.kind, "execution");
	assert.deepEqual(
		value(await rpc("query", "artifacts.getPreview", { id: phone.id, prId: pr.id })),
		phone
	);
	assert.equal(phone.viewport.width, 390);
	assert.equal(desktop.viewport.width, 1024);
	assert.notEqual(phone.url, desktop.url);
	assert.ok(phone.markers.some((marker) => marker.bounds.y > phone.viewport.height));
	const ports = [phone, desktop].map((preview) => Number(new URL(preview.url).port));
	for (const port of ports) assert.equal(await portOpen(port), true);
	for (const preview of [phone, desktop])
		value(await rpc("mutation", "runtime.stopPreview", { id: preview.id }));
	for (const port of ports) assert.equal(await portOpen(port), false);
	const shutdownPreview = value(
		await rpc("mutation", "runtime.startPreview", {
			requestId: "integrated-shutdown-preview",
			prId: pr.id,
			mode: "phone",
		})
	);
	const shutdownPort = Number(new URL(shutdownPreview.url).port);
	assert.equal(await portOpen(shutdownPort), true);
	const prefs = win.webContents.getLastWebPreferences();
	assert.equal(prefs.contextIsolation, true);
	assert.equal(prefs.sandbox, true);
	assert.equal(prefs.nodeIntegration, false);
	const report = {
		mode: "actual-built-electron-preload-ipc",
		agent: {
			missingKeyRejected: polled.status === "error",
			sourceExcerpts: preparation.sourceContext.length,
			catalogRetrieval: true,
		},
		userData,
		pr,
		sourceLines: source.content.split("\n").length,
		scenario: {
			base: scenario.results.base,
			head: scenario.results.head,
			throwLocation: thrown.location,
		},
		preview: { phone, desktop, portsClosed: true, shutdownPort },
		credentials: "empty temporary store, no secret getter",
		note: "Executed against local seeded repositories; no live model, voice, or GitHub comment calls",
	};
	assert.deepEqual(externalRequests, []);
	writeFileSync(reportPath, JSON.stringify(report, null, 2));
	console.log(
		"INTEGRATED_SMOKE_PASS: real seeded PR/source/scenario C/phone+desktop DOM previews/closed ports over sandboxed Electron IPC"
	);
	app.once("will-quit", () => clearTimeout(hardDeadline));
	app.quit();
})().catch((error) => {
	console.error("INTEGRATED_SMOKE_FAIL:", error);
	app.once("will-quit", () => {
		clearTimeout(hardDeadline);
		app.exit(1);
	});
	app.quit();
});
