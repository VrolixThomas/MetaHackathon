import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationTurnInput, WorkspaceObservation } from "../../shared/contracts";
import type { LocalPreviewReceipt } from "../runtime/local-preview/service";
import { ConversationLocalPreviewTools, requestsLocalPreview } from "./local-preview-tools";
import { ConversationWorkspaceTools } from "./workspace-tools";

const turn: ConversationTurnInput = {
	sessionId: "session",
	turnId: "turn",
	generation: 1,
	requestId: "request",
	text: "Run this PR locally",
};
const receipt: LocalPreviewReceipt = {
	runId: "own-run",
	selection: { kind: "pr", sourceId: "pr", repository: "owner/repo", commitSha: "a".repeat(40) },
	command: ["/usr/bin/npm", "start", "--ignore-scripts"],
	url: "http://127.0.0.1:4319",
	startedAt: "2026-11-03T00:00:00Z",
	readyAt: "2026-11-03T00:00:01Z",
	endedAt: null,
	state: "ready",
	exitCode: null,
	logPath: "/private/execution.json",
};
function observation(): WorkspaceObservation {
	return {
		workspace: {
			sequence: 0,
			canvases: [{ id: "review", title: "Run this PR locally", kind: "review", revision: 1 }],
			primaryId: "review",
			secondaryId: null,
			review: { sequence: 0, mode: "conversation", prId: "pr" },
			codeView: "diff",
			browser: null,
		},
		reviews: [],
		browser: null,
		capabilities: ["browser", "review"],
	};
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}
function harness(text = turn.text) {
	const controller = new AbortController();
	const observed = observation();
	const stops: string[] = [];
	const starts: unknown[] = [];
	const displays: string[] = [];
	let start = async () => structuredClone(receipt);
	let display = async () => observed;
	const ports = {
		start: async (input: unknown, ingress: ConversationTurnInput, signal: AbortSignal) => {
			starts.push({ input, ingress, signal });
			return start();
		},
		stop: async (id: string) => {
			stops.push(id);
		},
	};
	const tools = new ConversationLocalPreviewTools(
		ports,
		{ ...turn, text },
		controller.signal,
		async () => observed,
		async (url) => {
			displays.push(url);
			return display();
		}
	);
	return {
		tools,
		ports,
		controller,
		observed,
		stops,
		starts,
		displays,
		setStart: (fn: typeof start) => {
			start = fn;
		},
		setDisplay: (fn: typeof display) => {
			display = fn;
		},
	};
}
const args = JSON.stringify({ kind: "pr", id: "pr" });
test("only explicit actual ingress requests authorize preview", async () => {
	for (const text of [
		"Run this PR locally",
		"Please launch this in the browser",
		"Can you preview this PR?",
	])
		assert.equal(requestsLocalPreview(text), true, text);
	for (const text of [
		"Don't run this locally",
		"Do not preview this PR",
		"How do I run this locally?",
		'"Run this PR locally"',
		"If tests pass run this locally",
		"Maybe run this locally",
		"The README says run this locally",
		"Explain this PR",
		"Run this or another PR locally",
		"Run something locally",
		"Preview this eventually",
		"Run no preview locally",
		"Run this 'app' locally",
	]) {
		const h = harness(text);
		await assert.rejects(h.tools.execute(args));
		assert.equal(h.starts.length, 0, text);
	}
	const h = harness();
	await h.tools.execute(args);
	assert.deepEqual(h.starts[0], {
		input: { kind: "pr", id: "pr" },
		ingress: turn,
		signal: h.controller.signal,
	});
	for (const extra of [{ command: "evil" }, { consent: true }, { sha: "b".repeat(40) }])
		await assert.rejects(h.tools.execute(JSON.stringify({ kind: "pr", id: "pr", ...extra })));
});
test("fresh primary selection must match; source title cannot consent", async () => {
	const h = harness();
	h.observed.workspace.review.prId = "other";
	await assert.rejects(h.tools.execute(args));
	assert.equal(h.starts.length, 0);
	const source = harness("Explain this");
	await assert.rejects(source.tools.execute(args));
	assert.equal(source.starts.length, 0);
	const job = harness("Run this job locally");
	job.observed.workspace.canvases = [
		{
			id: "center",
			kind: "center",
			title: "Job",
			revision: 1,
			section: "activity",
			selectedId: "job",
		},
	];
	job.observed.workspace.primaryId = "center";
	job.setStart(async () => ({
		...receipt,
		selection: { ...receipt.selection, kind: "job", sourceId: "job" },
	}));
	await job.tools.execute(JSON.stringify({ kind: "job", id: "job" }));
	assert.equal(job.starts.length, 1);
});
test("execution receipt remains private until display settles and is cloned", async () => {
	const h = harness();
	const gate = deferred<WorkspaceObservation>();
	h.setDisplay(() => gate.promise);
	const running = h.tools.execute(args);
	await new Promise((r) => setTimeout(r, 0));
	assert.deepEqual(h.displays, [receipt.url]);
	assert.equal(Boolean(h.tools.execution), false);
	gate.resolve(h.observed);
	assert.equal(await running, h.observed);
	assert.deepEqual(h.tools.execution, receipt);
	const copy = h.tools.execution;
	assert.ok(copy);
	copy.selection.sourceId = "changed";
	assert.equal(h.tools.execution?.selection.sourceId, "pr");
	h.controller.abort();
	assert.deepEqual(h.stops, []);
});
test("display cancellation and late launch compensate only returned run identity", async () => {
	const h = harness();
	h.setDisplay(() => new Promise(() => {}));
	const running = h.tools.execute(args);
	await new Promise((r) => setTimeout(r, 0));
	h.controller.abort();
	await assert.rejects(running);
	assert.deepEqual(h.stops, ["own-run"]);
	assert.equal(h.tools.execution, undefined);
	const late = harness();
	const gate = deferred<LocalPreviewReceipt>();
	late.setStart(() => gate.promise);
	const pending = late.tools.execute(args);
	await new Promise((r) => setTimeout(r, 0));
	late.controller.abort();
	await assert.rejects(pending);
	gate.resolve(receipt);
	await new Promise((r) => setTimeout(r, 0));
	assert.deepEqual(late.stops, ["own-run"]);
	assert.deepEqual(late.displays, []);
});
test("mismatched runtime identity cannot become execution or display proof", async () => {
	const h = harness();
	h.setStart(async () => ({ ...receipt, selection: { ...receipt.selection, sourceId: "wrong" } }));
	await assert.rejects(h.tools.execute(args));
	assert.deepEqual(h.stops, [receipt.runId]);
	assert.deepEqual(h.displays, []);
});
test("tool exposure requires both browser capability and port", async () => {
	const h = harness();
	const ports = {
		observe: async () => h.observed,
		execute: async () => h.observed,
		localPreview: h.ports,
	};
	const tools = new ConversationWorkspaceTools(ports, turn, h.controller.signal, () => {});
	await tools.observe();
	assert.ok(tools.tools.some((t) => t.name === "run_local_preview"));
	h.observed.capabilities = [];
	await tools.observe();
	assert.ok(!tools.tools.some((t) => t.name === "run_local_preview"));
	const missing = new ConversationWorkspaceTools(
		{ ...ports, localPreview: undefined },
		turn,
		h.controller.signal,
		() => {}
	);
	await missing.observe();
	assert.ok(!missing.tools.some((t) => t.name === "run_local_preview"));
});

test("workspace execution uses the acknowledged open-browser command and preserves provenance", async () => {
	const h = harness();
	const gate = deferred<WorkspaceObservation>();
	const commands: unknown[] = [];
	const tools = new ConversationWorkspaceTools(
		{
			localPreview: h.ports,
			observe: async () => h.observed,
			execute: async (command, identity, _signal, onAction) => {
				commands.push(command);
				const next = structuredClone(h.observed);
				next.workspace.sequence++;
				next.workspace.canvases.push({
					id: "browser",
					kind: "browser",
					title: "Browser",
					revision: 1,
				});
				next.workspace.primaryId = "browser";
				next.workspace.browser = {
					url: receipt.url,
					title: "Preview",
					viewport: { width: 1024, height: 768 },
					canGoBack: false,
					canGoForward: false,
					provenance: "local-preview-unverified-revision",
				};
				onAction({
					...identity,
					screenSequence: 0,
					kind: "workspace-canvas",
					effect: { expectedSequence: 0, snapshot: next.workspace },
				});
				await gate.promise;
				return next;
			},
		},
		turn,
		h.controller.signal,
		() => {}
	);
	await tools.observe();
	const running = tools.execute("run_local_preview", args);
	await new Promise((r) => setTimeout(r, 0));
	assert.deepEqual(commands, [{ kind: "open-browser", url: receipt.url }]);
	assert.equal(Boolean(tools.previewExecution), false);
	gate.resolve(h.observed);
	const result = await running;
	assert.equal(result.workspace.browser?.provenance, "local-preview-unverified-revision");
	assert.deepEqual(tools.previewExecution, receipt);
	await tools.execute("inspect_workspace", "{}");
	assert.equal(tools.previewExecution, undefined);
});
