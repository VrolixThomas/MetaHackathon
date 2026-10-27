// Acceptance-only simulated model. Page observations and execution results must come
// from the real tool loop; this module emits requests, never fake runtime results.
const assert = require("node:assert/strict");

const META_ENDPOINT = "https://api.meta.ai/v1/responses";
const PROMO_CODE = "SPRING15";
const FLOW = Object.freeze([
	{ id: "walk", text: "Walk me through this PR." },
	{ id: "checkout", text: "Show me the checkout." },
	{ id: "promo", text: "Apply the promo code." },
	{ id: "phone", text: "Show it on a phone." },
	{ id: "payment", text: "Scroll to the payment button." },
	{ id: "code", text: "Show me the code responsible." },
	{ id: "compare", text: "Compare what happens before this PR." },
]);
const CANCEL_QUESTION = "Cancellation acceptance probe.";
const DRAFT_QUESTION = "Draft a comment about the expired promo regression, without posting.";
const LATE_TEXT = "LATE CANCELLED PROVIDER OUTPUT MUST NOT APPEAR";

function requestContext(body) {
	assert.ok(Array.isArray(body.input), "Model request must carry actual tool-loop history");
	let initial;
	let screen;
	const results = [];
	for (const item of body.input) {
		if (item.role === "user") {
			for (const content of item.content ?? []) {
				if (content.type !== "input_text") continue;
				let data;
				try {
					data = JSON.parse(content.text);
				} catch {
					continue;
				}
				if (data.reviewerRequest !== undefined) initial = data;
				if (data.currentScreenContext) screen = data.currentScreenContext;
			}
		}
		if (item.type === "function_call_output") results.push(JSON.parse(item.output));
	}
	assert.ok(
		initial?.preparation?.pr && screen,
		"Missing preparation/current screen in model input"
	);
	for (const result of results) {
		assert.notEqual(result.status, "error", "Tool failed; acceptance must not simulate success");
		assert.notEqual(
			result.status,
			"screen-changed",
			"Tool action was stale; rerun against current UI"
		);
	}
	return { ...initial, screen, results, round: results.length };
}

function sourceLocation(preparation, needle = "const capped") {
	const excerpt = preparation.sourceContext?.find(
		(entry) =>
			entry.location.path === "pricing/applyDiscounts.ts" &&
			entry.location.revision === "head" &&
			entry.text.split("\n").some((line) => line.trimStart().startsWith(needle))
	);
	assert.ok(excerpt, `Actual source excerpt missing ${needle}`);
	assert.equal(excerpt.location.commitSha, preparation.pr.headSha);
	const offset = excerpt.text.split("\n").findIndex((line) => line.trimStart().startsWith(needle));
	const line = excerpt.location.startLine + offset;
	assert.ok(line <= excerpt.location.endLine);
	return { ...excerpt.location, startLine: line, endLine: line };
}

function requireBrowser(context) {
	const state = context.screen.browser;
	assert.equal(
		state?.provenance,
		"live-browser",
		"No actual browser observation in current screen"
	);
	assert.equal(state.prId, context.preparation.pr.id);
	assert.equal(
		state.commitSha,
		state.revision === "base" ? context.preparation.pr.baseSha : context.preparation.pr.headSha
	);
	return state;
}

function elementArgs(state, predicate, allowOffscreen = false) {
	const element = state.elements.find(predicate);
	assert.ok(element, "Required control is missing from the actual observation");
	assert.ok(element.enabled && (allowOffscreen || element.visible), "Control cannot be used");
	return {
		browserId: state.browserId,
		elementId: element.id,
		observationSequence: state.sequence,
	};
}
const promoInput = (element) => element.tag === "input" && /promo/i.test(element.name);
const applyButton = (element) => element.role === "button" && /^apply\b/i.test(element.name);
const paymentButton = (element) =>
	element.role === "button" && /^pay(?:ment|\b)/i.test(element.name);

function chooseReply(body) {
	const context = requestContext(body);
	const { reviewerRequest: question, preparation, round, results } = context;
	const step = FLOW.find((entry) => entry.text === question)?.id;
	const tool = (name, args) => {
		assert.ok(
			body.tools?.some((entry) => entry.name === name),
			`Main did not expose ${name}`
		);
		return { context, tool: { name, arguments: args } };
	};
	const answer = (text) => ({ context, text });
	if (question === CANCEL_QUESTION)
		return { ...tool("browser_open", { revision: "head" }), delayed: true, text: LATE_TEXT };
	if (question === DRAFT_QUESTION) {
		if (round === 0)
			return tool("draft_comment", {
				body: "Could we keep expired promo codes from stopping the later nightly reminders?",
				location: sourceLocation(preparation, "throw new PromoExpiredError"),
			});
		assert.ok(results[0]?.draft, "Draft tool returned no draft");
		return answer("Draft prepared for review. Nothing has been posted.");
	}
	assert.ok(step, `Unexpected acceptance utterance: ${question}`);
	if (step === "walk" || step === "code") {
		const location = sourceLocation(preparation);
		if (round === 0)
			return tool("highlight_code", {
				location,
				note: "Pinned source: combined discount cap. UI linkage is inferred from source.",
			});
		return answer(
			`The pinned source at ${location.path}:${location.startLine} caps the combined discount. The checkout relationship is inferred from source; the browser is a separate observation.`
		);
	}
	if (step === "checkout" && round === 0) return tool("browser_open", { revision: "head" });
	if (step === "compare" && round === 0) return tool("run_scenario", {});
	if (step === "compare" && round === 1) return tool("browser_open", { revision: "base" });
	const browser = requireBrowser(context);
	if ((step === "promo" && round === 0) || (step === "compare" && round === 2))
		return tool("browser_type", { ...elementArgs(browser, promoInput), text: PROMO_CODE });
	if ((step === "promo" && round === 1) || (step === "compare" && round === 3))
		return tool("browser_click", elementArgs(browser, applyButton));
	if ((step === "phone" && round === 0) || (step === "compare" && round === 4))
		return tool("browser_viewport", {
			browserId: browser.browserId,
			viewport: { width: 390, height: 844 },
		});
	if (step === "payment" && round === 0)
		return tool("browser_scroll", elementArgs(browser, paymentButton, true));
	if (step === "compare") {
		const trace = results.find((result) => result.trace)?.trace;
		assert.equal(trace?.before.evidence.kind, "execution", "No actual base execution returned");
		assert.equal(trace?.after.evidence.kind, "execution", "No actual head execution returned");
		assert.equal(browser.revision, "base");
		return answer(
			`Runtime returned ${trace.title}: base ${trace.before.status}, head ${trace.after.status}. ` +
				`The visible base page now reports: ${browser.text.slice(0, 600)}`
		);
	}
	return answer(
		`Observed ${browser.revision} page, ${browser.viewport.width} × ${browser.viewport.height}, ` +
			`scroll ${browser.scroll.y}: ${browser.text.slice(0, 600)}`
	);
}

function sseResponse(body, reply, sequence) {
	const id = `simulated-browser-flow-${sequence}`;
	const output = reply.tool
		? [
				{
					type: "function_call",
					call_id: `flow-call-${sequence}`,
					name: reply.tool.name,
					arguments: JSON.stringify(reply.tool.arguments),
					status: "completed",
				},
			]
		: [
				{
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: reply.text }],
				},
			];
	const events = [
		{ type: "response.created", response: { id, model: body.model } },
		...(reply.text ? [{ type: "response.output_text.delta", delta: reply.text }] : []),
		{
			type: "response.completed",
			response: { id, model: body.model, status: "completed", output, usage: null },
		},
	];
	const bytes = new TextEncoder().encode(
		events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("")
	);
	let offset = 0;
	return new Response(
		new ReadableStream({
			pull(controller) {
				if (offset === bytes.length) return controller.close();
				const end = Math.min(offset + 17, bytes.length);
				controller.enqueue(bytes.slice(offset, end));
				offset = end;
			},
		}),
		{ headers: { "content-type": "text/event-stream" } }
	);
}

function createBrowserFlowProvider({ forwardFetch } = {}) {
	const records = [];
	const blocked = [];
	const delayed = [];
	return {
		records,
		blocked,
		get pendingCount() {
			return delayed.length;
		},
		releaseDelayed() {
			for (const release of delayed.splice(0)) release();
		},
		async fetch(input, options = {}) {
			const rawURL = typeof input === "string" || input instanceof URL ? String(input) : input.url;
			const url = new URL(rawURL);
			if (rawURL !== META_ENDPOINT) {
				if (
					url.protocol === "http:" &&
					!url.username &&
					!url.password &&
					["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
				) {
					assert.ok(forwardFetch, "Loopback forwarding unavailable");
					return forwardFetch(input, { ...options, redirect: "error" });
				}
				blocked.push(`${url.origin}${url.pathname}`);
				throw new Error("Browser acceptance forbids this external URL");
			}
			assert.equal(options.method, "POST");
			const body = JSON.parse(String(options.body));
			assert.equal(body.stream, true);
			assert.equal(body.store, false);
			let reply;
			try {
				reply = chooseReply(body);
			} catch (error) {
				console.error(
					"SCRIPTED_PROVIDER_REJECTED",
					error.message,
					body.input.filter((item) => item.type === "function_call_output").at(-1)
				);
				throw error;
			}
			const sequence = records.length + 1;
			records.push({
				sequence,
				question: reply.context.reviewerRequest,
				round: reply.context.round,
				pr: reply.context.preparation.pr,
				browser: reply.context.screen.browser ?? null,
				tool: reply.tool ?? null,
				delayed: reply.delayed === true,
			});
			// Intentionally ignore abort only for this explicit late-provider probe.
			if (reply.delayed)
				return new Promise((resolve) =>
					delayed.push(() => resolve(sseResponse(body, reply, sequence)))
				);
			return sseResponse(body, reply, sequence);
		},
	};
}

module.exports = {
	META_ENDPOINT,
	PROMO_CODE,
	FLOW,
	CANCEL_QUESTION,
	DRAFT_QUESTION,
	LATE_TEXT,
	requestContext,
	sourceLocation,
	chooseReply,
	createBrowserFlowProvider,
};
