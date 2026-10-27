// Node-only checks. --self-test never imports Electron or launches any child process.
// After root runs the native smoke: node src/main/check-browser-flow.cjs [report.json]
const assert = require("node:assert/strict");
const { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } = require("node:fs");
const net = require("node:net");
const { basename, dirname, join, resolve } = require("node:path");
const {
	META_ENDPOINT,
	FLOW,
	PROMO_CODE,
	CANCEL_QUESTION,
	DRAFT_QUESTION,
	chooseReply,
	createBrowserFlowProvider,
	sourceLocation,
} = require("./browser-flow-provider.cjs");

function assertReport(report) {
	assert.equal(report.mode, "actual-built-electron-renderer-browser-flow");
	assert.equal(report.simulatedProvider, true, "Never label simulated provider as live acceptance");
	assert.equal(report.liveSpeech, false);
	assert.equal(report.status, "passed", report.error);
	assert.match(report.builtMainSha256, /^[a-f0-9]{64}$/);
	assert.equal(report.scriptedPromoChoice, PROMO_CODE);
	assert.equal(report.steps.length, FLOW.length);
	for (const [index, expected] of FLOW.entries()) {
		const step = report.steps[index];
		assert.equal(step.id, expected.id);
		assert.equal(step.text, expected.text);
		assert.equal(step.status, "passed");
		assert.ok(step.turn.sessionId && step.turn.turnId);
		assert.equal(step.turn.sessionId, report.steps[0].turn.sessionId);
		if (index > 0) assert.ok(step.turn.generation > report.steps[index - 1].turn.generation);
	}
	assert.equal(report.staleObservationRejected, true);
	assert.equal(report.confirmation.unconfirmedRejected, true);
	assert.equal(report.confirmation.changedBodyRejected, true);
	assert.equal(report.confirmation.githubWrites, 0);
	assert.equal(report.cancellation.status, "cancelled");
	assert.equal(report.cancellation.lateOutputSuppressed, true);
	assert.equal(report.cancellation.lateActionsSuppressed, true);
	assert.equal(report.dummyCredentialRemoved, true);
	assert.deepEqual(report.blockedExternalRequests, []);
	assert.ok(report.voice.localVoiceReady === true || report.voice.skipped);
	assert.equal(report.voice.liveSpeech, false);
}

function closedPort(port) {
	assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
	return new Promise((done, reject) => {
		const socket = net.createConnection({ host: "127.0.0.1", port });
		socket.setTimeout(1000);
		socket.once("connect", () => {
			socket.destroy();
			reject(new Error(`Owned preview port ${port} survived native shutdown`));
		});
		socket.once("timeout", () => {
			socket.destroy();
			reject(new Error(`Cannot verify shutdown of port ${port}`));
		});
		socket.once("error", (error) => {
			if (error.code === "ECONNREFUSED") done();
			else reject(error);
		});
	});
}

async function checkNativeReport(path) {
	const report = JSON.parse(readFileSync(path, "utf8"));
	assertReport(report);
	const evidence = (file) => {
		assert.equal(dirname(resolve(file)), resolve(report.evidenceDir));
		return JSON.parse(readFileSync(file, "utf8"));
	};
	for (const step of report.steps) {
		const actual = evidence(step.evidencePath);
		assert.equal(actual.result.status, "completed");
		assert.equal(actual.ui.state, "complete");
		assert.equal(actual.ui.question, step.text);
		if (actual.browser) {
			assert.equal(actual.browser.observation.provenance, "live-browser");
			assert.equal(actual.browser.observation.url, actual.browser.page.url);
			assert.ok(actual.browser.webContentsId > 0);
		}
	}
	const scenario = evidence(report.scenarioEvidence);
	assert.deepEqual(
		scenario.results.base.sent.map((item) => item.total),
		[108, 72]
	);
	assert.equal(scenario.results.base.batchStopped, false);
	assert.deepEqual(scenario.results.head.sent, []);
	assert.equal(scenario.results.head.error, "PromoExpiredError");
	assert.equal(scenario.results.head.batchStopped, true);
	for (const [side, run] of [
		["base", scenario.trace.before],
		["head", scenario.trace.after],
	]) {
		assert.equal(run.evidence.kind, "execution");
		assert.equal(run.evidence.commitSha, report.pr[side === "base" ? "baseSha" : "headSha"]);
		const log = evidence(join(report.evidenceDir, `scenario-${side}-log.json`));
		assert.equal(log.runId, run.evidence.runId);
		assert.equal(log.commitSha, run.evidence.commitSha);
		assert.equal(log.exitCode, 0);
	}
	const calls = evidence(report.providerEvidence);
	for (const entry of FLOW) assert.ok(calls.some((call) => call.question === entry.text));
	assert.ok(calls.some((call) => call.tool?.name === "run_scenario"));
	assert.ok(!calls.some((call) => /post|confirm/.test(call.tool?.name ?? "")));
	await Promise.all(report.ports.map(closedPort));
	if (existsSync(report.userData)) {
		assert.ok(basename(report.userData).startsWith("metahackathon-browser-flow-"));
		assert.equal(
			readFileSync(join(report.userData, ".browser-flow-owner"), "utf8"),
			report.userDataOwner
		);
		const demo = join(report.userData, "runtime", "demo");
		if (existsSync(demo))
			assert.deepEqual(readdirSync(demo), [], "Owned seed repositories survived shutdown");
		const credentials = join(report.userData, "credentials", "credentials.encrypted.json");
		assert.deepEqual(JSON.parse(readFileSync(credentials, "utf8")), {});
		// Only remove the exact temporary directory carrying this run's ownership token.
		rmSync(report.userData, { recursive: true });
	} else assert.equal(report.shutdown?.tempUserDataRemoved, true);
	report.shutdown = { portsClosed: true, seedsRemoved: true, tempUserDataRemoved: true };
	writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
	console.log(
		"BROWSER_FLOW_CHECK_PASS: seven rendered turns, native observations, execution evidence and shutdown; provider simulated, speech not tested"
	);
}

function selfTests() {
	const { test } = require("node:test");
	// Protocol fixtures only. These doubles never enter a native acceptance report.
	const pr = {
		id: "test-pr",
		repository: "test/shop",
		baseSha: "a".repeat(40),
		headSha: "b".repeat(40),
	};
	const preparation = {
		pr,
		sourceContext: [
			{
				location: {
					repository: pr.repository,
					revision: "head",
					commitSha: pr.headSha,
					path: "pricing/applyDiscounts.ts",
					startLine: 40,
					endLine: 43,
				},
				text: 'trace("throw new PromoExpiredError");\nthrow new PromoExpiredError(code);\nconst capped = Math.min(combined, MAX_DISCOUNT_PCT);\nreturn price(cart, capped);',
			},
		],
	};
	const browser = (sequence = 1, prefix = "old", revision = "head") => ({
		browserId: `helper-${revision}`,
		sessionId: "helper-session",
		prId: pr.id,
		repository: pr.repository,
		revision,
		commitSha: revision === "head" ? pr.headSha : pr.baseSha,
		provenance: "live-browser",
		url: "http://127.0.0.1:43210/checkout",
		title: "HELPER DOUBLE",
		viewport: { width: 1024, height: 768 },
		sequence,
		text: "HELPER DOUBLE ONLY",
		scroll: { x: 0, y: 0 },
		elements: [
			{
				id: `${prefix}-promo`,
				name: "Promo code",
				role: "textbox",
				tag: "input",
				visible: true,
				enabled: true,
			},
			{
				id: `${prefix}-apply`,
				name: "Apply",
				role: "button",
				tag: "button",
				visible: true,
				enabled: true,
			},
			{
				id: `${prefix}-pay`,
				name: "Pay €78.00",
				role: "button",
				tag: "button",
				visible: false,
				enabled: true,
			},
		],
	});
	const toolNames = [
		"highlight_code",
		"draft_comment",
		"run_scenario",
		"browser_open",
		"browser_type",
		"browser_click",
		"browser_scroll",
		"browser_viewport",
	];
	const request = (question, state, results = []) => ({
		model: "muse-spark-1.3",
		stream: true,
		store: false,
		tools: toolNames.map((name) => ({ name })),
		input: [
			{
				role: "user",
				content: [
					{ type: "input_text", text: JSON.stringify({ reviewerRequest: question, preparation }) },
				],
			},
			...results.map((output) => ({
				type: "function_call_output",
				output: JSON.stringify(output),
			})),
			{
				role: "user",
				content: [
					{
						type: "input_text",
						text: JSON.stringify({ currentScreenContext: { browser: state } }),
					},
				],
			},
		],
	});
	const sent = { status: "observed" };
	test("seven exact utterances and source-derived inclusive line selection", () => {
		assert.equal(FLOW.length, 7);
		assert.equal(sourceLocation(preparation).startLine, 42);
		assert.equal(sourceLocation(preparation, "throw new PromoExpiredError").startLine, 41);
		const selected = chooseReply(request(FLOW[0].text)).tool;
		assert.equal(selected.name, "highlight_code");
		assert.equal(selected.arguments.location.commitSha, pr.headSha);
		assert.throws(() => chooseReply(request("Walk me through this PR")), /Unexpected/);
	});
	test("checkout opens head without inventing a URL or browser identity", () => {
		assert.deepEqual(chooseReply(request(FLOW[1].text)).tool, {
			name: "browser_open",
			arguments: { revision: "head" },
		});
		assert.throws(() => chooseReply(request(FLOW[1].text, undefined, [sent])), /actual browser/);
	});
	test("promo type and click use fresh observed refs and sequence in separate rounds", () => {
		const typed = chooseReply(request(FLOW[2].text, browser())).tool;
		assert.equal(typed.arguments.text, PROMO_CODE);
		assert.equal(typed.arguments.elementId, "old-promo");
		const clicked = chooseReply(request(FLOW[2].text, browser(7, "new"), [sent])).tool;
		assert.equal(clicked.name, "browser_click");
		assert.equal(clicked.arguments.elementId, "new-apply");
		assert.equal(clicked.arguments.observationSequence, 7);
	});
	test("phone viewport and payment scroll never click payment", () => {
		assert.deepEqual(chooseReply(request(FLOW[3].text, browser())).tool.arguments.viewport, {
			width: 390,
			height: 844,
		});
		const scroll = chooseReply(request(FLOW[4].text, browser())).tool;
		assert.equal(scroll.name, "browser_scroll");
		assert.equal(scroll.arguments.elementId, "old-pay");
	});
	test("responsible-code request uses pinned source rather than DOM geometry", () => {
		assert.equal(
			chooseReply(request(FLOW[5].text, browser())).tool.arguments.location.startLine,
			42
		);
		const wrong = structuredClone(preparation);
		wrong.sourceContext[0].location.commitSha = pr.baseSha;
		assert.throws(() => sourceLocation(wrong));
	});
	test("compare consumes base identity and requires actual trace output before answering", () => {
		const choose = (round, results = Array.from({ length: round }, () => sent)) =>
			chooseReply(request(FLOW[6].text, browser(round + 1, "base", "base"), results));
		assert.equal(choose(0).tool.name, "run_scenario");
		assert.deepEqual(choose(1).tool.arguments, { revision: "base" });
		assert.equal(choose(2).tool.arguments.browserId, "helper-base");
		assert.equal(choose(3).tool.name, "browser_click");
		assert.equal(choose(4).tool.name, "browser_viewport");
		assert.throws(() => choose(5), /actual base execution/);
	});
	test("failed or stale tool outcomes cannot be converted to success", () => {
		for (const status of ["error", "screen-changed"])
			assert.throws(() => chooseReply(request(FLOW[2].text, browser(), [{ status }])));
		const unavailable = request(FLOW[1].text);
		unavailable.tools = [];
		assert.throws(() => chooseReply(unavailable), /did not expose/);
	});
	test("draft probe has no confirmation/posting tool and preserves actual source citation", () => {
		const draft = chooseReply(request(DRAFT_QUESTION)).tool;
		assert.equal(draft.name, "draft_comment");
		assert.equal(draft.arguments.location.startLine, 41);
		assert.throws(() => chooseReply(request(DRAFT_QUESTION, undefined, [sent])), /no draft/);
	});
	test("fetch mocks only exact endpoint and rejects external redirects/near matches", async () => {
		const forwarded = [];
		const provider = createBrowserFlowProvider({
			forwardFetch: async (...args) => {
				forwarded.push(args);
				return new Response("loopback double");
			},
		});
		for (const url of [
			`${META_ENDPOINT}?unexpected=1`,
			"https://api.github.com/repos/x/y/comments",
			"https://api.meta.ai.evil.invalid/v1/responses",
		])
			await assert.rejects(provider.fetch(url));
		assert.equal(forwarded.length, 0);
		await provider.fetch("http://127.0.0.1:43210/health", { redirect: "follow" });
		assert.equal(forwarded[0][1].redirect, "error");
	});
	test("SSE response contains tool request and null usage, never a runtime result", async () => {
		const provider = createBrowserFlowProvider();
		const response = await provider.fetch(META_ENDPOINT, {
			method: "POST",
			body: JSON.stringify(request(FLOW[1].text)),
		});
		assert.equal(response.headers.get("content-type"), "text/event-stream");
		const events = (await response.text())
			.trim()
			.split("\r\n\r\n")
			.map((line) => JSON.parse(line.slice(6)));
		const completion = events.at(-1).response;
		assert.equal(completion.usage, null);
		assert.equal(completion.output[0].name, "browser_open");
		assert.ok(!completion.output.some((item) => item.type === "function_call_output"));
	});
	test("delayed provider can be released after abort to probe native late-result suppression", async () => {
		const provider = createBrowserFlowProvider();
		const controller = new AbortController();
		const pending = provider.fetch(META_ENDPOINT, {
			method: "POST",
			signal: controller.signal,
			body: JSON.stringify(request(CANCEL_QUESTION)),
		});
		assert.equal(provider.pendingCount, 1);
		controller.abort();
		provider.releaseDelayed();
		assert.ok((await (await pending).text()).includes("LATE CANCELLED"));
		assert.equal(provider.pendingCount, 0);
	});
	test("checker rejects non-native or falsely live acceptance reports", () => {
		assert.throws(() => assertReport({ mode: "fixture" }));
		assert.throws(() =>
			assertReport({
				mode: "actual-built-electron-renderer-browser-flow",
				simulatedProvider: false,
			})
		);
	});
}

module.exports = { assertReport, checkNativeReport };
if (require.main === module) {
	if (process.argv.includes("--self-test")) selfTests();
	else
		checkNativeReport(
			resolve(process.argv[2] ?? join(__dirname, "../../out/browser-flow-smoke/report.json"))
		).catch((error) => {
			console.error("BROWSER_FLOW_CHECK_FAIL:", error);
			process.exitCode = 1;
		});
}
