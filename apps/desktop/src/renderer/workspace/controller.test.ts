import assert from "node:assert/strict";
import { it } from "node:test";
import type {
	AgentAction,
	WorkspaceActionReceipt,
	WorkspaceSnapshot,
} from "../../shared/contracts";
import { WORKSPACE_GITHUB_REQUIRED } from "../../shared/contracts";
import { createPreparedApi } from "../prepared/api";
import { createPreparedController } from "../prepared/controller";
import { createWorkspaceController } from "./controller";
import { createLocalBrowserController } from "./local-browser";

const initial: WorkspaceSnapshot = {
	sequence: 0,
	canvases: [{ kind: "review", id: "review", title: "Code", revision: 1 }],
	primaryId: "review",
	secondaryId: null,
	review: { mode: "conversation", prId: null, sequence: 0 },
	codeView: "diff",
	browser: null,
};
const document: WorkspaceSnapshot = {
	...initial,
	sequence: 1,
	primaryId: "doc-1",
	canvases: [
		...initial.canvases,
		{
			kind: "document",
			id: "doc-1",
			title: "Explanation",
			revision: 1,
			markdown: "Actual content",
			references: [],
			provenance: "agent-draft",
		},
	],
};
function action(
	snapshot = document,
	requestId = "effect-1"
): Extract<AgentAction, { kind: "workspace-canvas" }> {
	return {
		kind: "workspace-canvas",
		sessionId: "session",
		turnId: "turn",
		generation: 1,
		requestId,
		screenSequence: snapshot.sequence - 1,
		effect: { expectedSequence: snapshot.sequence - 1, snapshot },
	};
}
async function until(predicate: () => boolean) {
	for (let step = 0; step < 30 && !predicate(); step++)
		await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(predicate(), true, "Expected asynchronous state to settle");
}
function harness(
	options: {
		timeout?: number;
		prepare?: (input: unknown) => Promise<AgentAction>;
		present?: (input: unknown) => Promise<unknown>;
		observe?: (workspace: WorkspaceSnapshot, count: number) => Promise<WorkspaceSnapshot>;
	} = {}
) {
	const receipts: WorkspaceActionReceipt[] = [];
	const paths: string[] = [];
	let interruptions = 0;
	let canonical = initial;
	let observations = 0;
	const call = async (_type: "query" | "mutation", path: string, input?: unknown) => {
		paths.push(path);
		if (path === "workspace.observe") {
			const workspace = options.observe
				? await options.observe(canonical, ++observations)
				: canonical;
			return {
				workspace,
				browser: null,
				reviews: [],
				capabilities: ["documents", "visuals", "browser", "review"],
			};
		}
		if (path === "workspace.prepare") return options.prepare ? options.prepare(input) : action();
		if (path === "workspace.applied") {
			receipts.push(input as WorkspaceActionReceipt);
			if ((input as WorkspaceActionReceipt).status === "applied")
				canonical = (input as WorkspaceActionReceipt).workspace;
			return { status: "accepted" };
		}
		if (path === "localBrowser.present") return options.present?.(input);
		if (path === "localBrowser.close") return null;
		throw new Error(`Unexpected RPC ${path}`);
	};
	const reviews = createPreparedController(createPreparedApi(call), "session");
	const browser = createLocalBrowserController(call);
	const controller = createWorkspaceController(call, reviews, browser, "session", {
		onManualChange: () => {
			interruptions++;
		},
		renderTimeoutMs: options.timeout ?? 500,
	});
	return {
		controller,
		browser,
		reviews,
		receipts,
		paths,
		interruptions: () => interruptions,
		dispose: () => {
			controller.dispose();
			reviews.dispose();
			browser.dispose();
		},
	};
}

it("waits for both committed content and native hide, deduplicating the exact effect receipt", async () => {
	const h = harness();
	try {
		await h.controller.start();
		const pending = h.controller.applyAction(action(), () => true);
		assert.equal(
			h.controller.applyAction(action(), () => true),
			pending
		);
		await until(() => h.controller.store.getState().workspace?.sequence === 1);
		assert.equal(h.receipts.length, 0);
		h.controller.rendered(1);
		await Promise.resolve();
		assert.equal(h.receipts.length, 0);
		h.controller.presented(0, null);
		assert.equal(h.receipts.length, 0);
		h.controller.presented(1, null);
		assert.equal(await pending, "applied");
		assert.equal(h.receipts.length, 1);
		assert.equal(h.receipts[0]?.workspace.primaryId, "doc-1");
		assert.equal(h.interruptions(), 0);
	} finally {
		h.dispose();
	}
});

it("requires positive native browser bounds and preserves the same browser through a canvas switch", async () => {
	const h = harness();
	try {
		await h.controller.start();
		const page = {
			url: "https://example.com/actual",
			title: "Real page",
			viewport: { width: 1024, height: 768 },
			canGoBack: true,
			canGoForward: false,
			provenance: "website-unverified-revision" as const,
		};
		const snapshot = {
			...initial,
			sequence: 1,
			primaryId: "browser",
			browser: page,
			canvases: [
				...initial.canvases,
				{ kind: "browser" as const, id: "browser", title: "Website", revision: 1 },
			],
		};
		const pending = h.controller.applyAction(action(snapshot), () => true);
		await until(() => h.controller.store.getState().workspace?.sequence === 1);
		h.controller.rendered(1);
		assert.equal(h.receipts.length, 0);
		h.controller.presented(1, { x: 10, y: 80, width: 800, height: 500 });
		assert.equal(await pending, "applied");
		assert.equal(h.browser.store.getState().page?.url, page.url);
		const switched = h.controller.applyAction(
			action({ ...snapshot, sequence: 2, primaryId: "review" }, "switch"),
			() => true
		);
		await until(() => h.controller.store.getState().workspace?.sequence === 2);
		h.controller.rendered(2);
		h.controller.presented(2, null);
		assert.equal(await switched, "applied");
		assert.deepEqual(h.browser.store.getState().page, page);
		assert.ok(!h.paths.includes("localBrowser.open") && !h.paths.includes("localBrowser.close"));
	} finally {
		h.dispose();
	}
});

it("rejects a second browser canvas before mounting competing native hosts", async () => {
	const h = harness();
	try {
		await h.controller.start();
		const snapshot: WorkspaceSnapshot = {
			...initial,
			sequence: 1,
			primaryId: "browser-a",
			secondaryId: "browser-b",
			canvases: [
				{ kind: "browser", id: "browser-a", title: "A", revision: 1 },
				{ kind: "browser", id: "browser-b", title: "B", revision: 1 },
			],
		};
		assert.equal(await h.controller.applyAction(action(snapshot), () => true), "ignored");
		assert.equal(h.controller.getContext()?.sequence, 0);
		assert.equal(h.receipts[0]?.status, "ignored");
	} finally {
		h.dispose();
	}
});

it("manual commands interrupt once and use the same apply/receipt path", async () => {
	const h = harness();
	try {
		await h.controller.start();
		const pending = h.controller.command({ kind: "focus-canvas", id: "doc-1" });
		await until(() => h.controller.store.getState().workspace?.sequence === 1);
		h.controller.rendered(1);
		h.controller.presented(1, null);
		assert.equal(await pending, "applied");
		assert.equal(h.interruptions(), 1);
		assert.equal(h.paths.filter((path) => path === "workspace.prepare").length, 1);
		assert.equal(h.receipts[0]?.requestId, "effect-1");
		await h.controller.command({ kind: "open-browser", url: "javascript:attack" });
		assert.equal(h.interruptions(), 1);
	} finally {
		h.dispose();
	}
});

it("ignores stale/cancelled/obscured effects and retires render waits promptly", async () => {
	const h = harness();
	try {
		await h.controller.start();
		await h.controller.applyAction({ ...action(), screenSequence: 7 }, () => true);
		assert.equal(h.controller.getContext()?.sequence, 0);
		const abort = new AbortController();
		const pending = h.controller.applyAction(action(document, "cancel"), () => true, abort.signal);
		await until(() => h.controller.getContext()?.sequence === 1);
		abort.abort();
		assert.equal(await pending, "ignored");
		h.controller.rendered(1);
		h.controller.presented(1, null);
		assert.equal(h.receipts.at(-1)?.status, "ignored");
		h.controller.setObscured(true);
		await h.controller.applyAction(action({ ...document, sequence: 2 }, "overlay"), () => true);
		assert.equal(h.receipts.at(-1)?.status, "ignored");
		assert.equal(h.controller.getContext()?.sequence, 0);
	} finally {
		h.dispose();
	}
});

it("does not report a failed native presentation or missing render as applied", async () => {
	const h = harness({ timeout: 10 });
	try {
		await h.controller.start();
		const pending = h.controller.applyAction(action(), () => true);
		await until(() => h.controller.getContext()?.sequence === 1);
		h.controller.presentationFailed(1);
		assert.equal(await pending, "ignored");
		assert.ok(h.controller.store.getState().error);
		assert.equal(
			await h.controller.applyAction(action(document, "timeout"), () => true),
			"ignored"
		);
		assert.ok(h.receipts.every((receipt) => receipt.status === "ignored"));
	} finally {
		h.dispose();
	}
});

it("a late manual prepare cannot replace a newer intent", async () => {
	let finish: (value: AgentAction) => void = () => {};
	let calls = 0;
	const h = harness({
		prepare: async () =>
			++calls === 1
				? new Promise((resolve) => {
						finish = resolve;
					})
				: action(document, "newer"),
	});
	try {
		await h.controller.start();
		const old = h.controller.command({ kind: "focus-canvas", id: "old" });
		await until(() => calls === 1);
		const next = h.controller.command({ kind: "focus-canvas", id: "doc-1" });
		await until(() => h.controller.getContext()?.sequence === 1);
		h.controller.rendered(1);
		h.controller.presented(1, null);
		assert.equal(await next, "applied");
		finish(action({ ...document, primaryId: "review" }, "old"));
		assert.equal(await old, "ignored");
		assert.equal(h.controller.getContext()?.primaryId, "doc-1");
		assert.equal(h.receipts.at(-1)?.status, "ignored");
	} finally {
		h.dispose();
	}
});

it("a failed status refresh never sends a contradictory receipt for an applied canvas", async () => {
	const h = harness({
		observe: async (workspace, count) => {
			if (count === 2) throw new Error("temporarily unavailable");
			return workspace;
		},
	});
	try {
		await h.controller.start();
		const pending = h.controller.applyAction(action(), () => true);
		await until(() => h.controller.getContext()?.sequence === 1);
		h.controller.rendered(1);
		h.controller.presented(1, null);
		assert.equal(await pending, "applied");
		assert.equal(h.receipts.length, 1);
		assert.equal(h.receipts[0]?.status, "applied");
		assert.match(h.controller.store.getState().error, /workspace status is unavailable/);
	} finally {
		h.dispose();
	}
});

it("a delayed authoritative refresh cannot roll back a newer rendered candidate", async () => {
	let finish: (workspace: WorkspaceSnapshot) => void = () => {};
	const h = harness({
		observe: async (workspace, count) =>
			count === 2
				? new Promise((resolve) => {
						finish = resolve;
					})
				: workspace,
	});
	try {
		await h.controller.start();
		const first = h.controller.applyAction(action(), () => true);
		await until(() => h.controller.getContext()?.sequence === 1);
		h.controller.rendered(1);
		h.controller.presented(1, null);
		await until(() => h.receipts.length === 1);
		const next = h.controller.applyAction(
			action({ ...document, sequence: 2, primaryId: "review" }, "next"),
			() => true
		);
		await until(() => h.controller.getContext()?.sequence === 2);
		finish(document);
		assert.equal(await first, "applied");
		assert.equal(h.controller.getContext()?.sequence, 2);
		h.controller.rendered(2);
		h.controller.presented(2, null);
		assert.equal(await next, "applied");
		assert.equal(h.controller.getContext()?.primaryId, "review");
	} finally {
		h.dispose();
	}
});

it("manual selection prepares from fresh main state after the picker outlives its original snapshot", async () => {
	let expectedSequence = -1;
	const h = harness({
		observe: async (workspace, count) => (count === 2 ? { ...initial, sequence: 4 } : workspace),
		prepare: async (input) => {
			expectedSequence = (input as { expectedSequence: number }).expectedSequence;
			return action({ ...document, sequence: 5 });
		},
	});
	try {
		await h.controller.start();
		const selecting = h.controller.command({ kind: "focus-canvas", id: "doc-1" });
		await until(() => h.controller.getContext()?.sequence === 5);
		h.controller.rendered(5);
		h.controller.presented(5, null);
		assert.equal(await selecting, "applied");
		assert.equal(expectedSequence, 4);
	} finally {
		h.dispose();
	}
});
it("missing GitHub is actionable and a later selection can recover without restarting", async () => {
	let configured = false;
	const h = harness({
		prepare: async () => {
			if (!configured) throw new Error(WORKSPACE_GITHUB_REQUIRED);
			return action();
		},
	});
	try {
		await h.controller.start();
		assert.equal(
			await h.controller.command({ kind: "show-review", prId: "owner/repo#1" }),
			"ignored"
		);
		assert.equal(h.controller.store.getState().error, WORKSPACE_GITHUB_REQUIRED);
		assert.equal(h.receipts.length, 0);
		configured = true;
		const selecting = h.controller.command({ kind: "show-review", prId: "owner/repo#1" });
		await until(() => h.controller.getContext()?.sequence === 1);
		h.controller.rendered(1);
		h.controller.presented(1, null);
		assert.equal(await selecting, "applied");
		assert.equal(h.controller.store.getState().error, "");
	} finally {
		h.dispose();
	}
});

it("a sidebar-only receipt keeps the visible native browser and still waits for real rendered bounds", async () => {
	const page = {
		url: "https://example.com/actual",
		title: "Actual page",
		viewport: { width: 1024, height: 768 },
		canGoBack: false,
		canGoForward: false,
		provenance: "website-unverified-revision" as const,
	};
	const before: WorkspaceSnapshot = {
		...initial,
		centerSection: "home",
		browser: page,
		primaryId: "browser",
		canvases: [
			...initial.canvases,
			{ id: "browser", title: "Actual page", kind: "browser", revision: 1 },
		],
	};
	const h = harness({ observe: async (workspace, count) => (count === 1 ? before : workspace) });
	try {
		await h.controller.start();
		const pending = h.controller.applyAction(
			action({ ...before, sequence: 1, centerSection: "tickets" }),
			() => true
		);
		await until(() => h.controller.store.getState().workspace?.sequence === 1);
		assert.equal(
			h.paths.includes("localBrowser.present"),
			false,
			"Browsing must not hide the native page first"
		);
		assert.equal(h.receipts.length, 0);
		h.controller.rendered(1);
		h.controller.presented(0, null);
		assert.equal(h.receipts.length, 0);
		h.controller.presented(1, { x: 306, y: 128, width: 800, height: 600 });
		assert.equal(await pending, "applied");
		assert.equal(h.controller.getContext()?.primaryId, "browser");
		assert.deepEqual(h.browser.store.getState().page, page);
	} finally {
		h.dispose();
	}
});
it("category browsing waits for an active canvas effect without cancelling narration and only the newest category applies", async () => {
	const prepared: string[] = [];
	const h = harness({
		prepare: async (input) => {
			const value = input as { expectedSequence: number; command: { section: string } };
			prepared.push(value.command.section);
			return action(
				{
					...document,
					sequence: value.expectedSequence + 1,
					centerSection: value.command.section as "feedback",
				},
				"browse-result"
			);
		},
	});
	try {
		await h.controller.start();
		const showing = h.controller.applyAction(action(), () => true);
		await until(() => h.controller.getContext()?.sequence === 1);
		const first = h.controller.command({ kind: "browse-center", section: "tickets" });
		const second = h.controller.command({ kind: "browse-center", section: "feedback" });
		assert.deepEqual(prepared, []);
		assert.equal(h.interruptions(), 0);
		h.controller.rendered(1);
		h.controller.presented(1, null);
		assert.equal(await showing, "applied");
		assert.equal(await first, "ignored");
		await until(() => h.controller.getContext()?.sequence === 2);
		h.controller.rendered(2);
		h.controller.presented(2, null);
		assert.equal(await second, "applied");
		assert.deepEqual(prepared, ["feedback"]);
		assert.equal(h.interruptions(), 0);
		assert.equal(h.controller.getContext()?.primaryId, "doc-1");
	} finally {
		h.dispose();
	}
});
