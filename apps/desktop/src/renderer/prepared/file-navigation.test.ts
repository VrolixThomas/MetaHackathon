import assert from "node:assert/strict";
import { it } from "node:test";
import type {
	WorkspaceActionReceipt,
	WorkspaceCommand,
	WorkspaceSnapshot,
} from "../../shared/contracts";
import { createWorkspaceController } from "../workspace/controller";
import { createLocalBrowserController } from "../workspace/local-browser";
import { createPreparedApi } from "./api";
import { createPreparedController } from "./controller";
import { connectPreparedFileNavigation } from "./file-navigation";

const pr = {
	id: "owner/project#8",
	repository: "owner/project",
	number: 8,
	title: "Review source",
	url: "https://github.com/owner/project/pull/8",
	author: "owner",
	baseSha: "a".repeat(40),
	headSha: "b".repeat(40),
};
const plan = {
	id: "review-8",
	version: 1 as const,
	pr,
	createdAt: "2026-10-31T10:00:00Z",
	summary: "Source changes",
	orderRationale: "Public API before implementation",
	files: ["z-api.ts", "a-implementation.ts", "m-tests.ts"].map((path) => ({
		path,
		reason: `Read ${path}`,
		summary: `Changes to ${path}`,
		suggestedComments: [],
	})),
	coverage: "complete" as const,
	evidence: "inferred-from-github" as const,
};
const detail = { pr, prepared: plan, status: "ready" as const, progress: null };
function file(path: string) {
	return {
		prId: pr.id,
		path,
		status: "modified",
		patch: null,
		base: { path, commitSha: pr.baseSha, status: "available" as const, content: "old\n" },
		head: { path, commitSha: pr.headSha, status: "available" as const, content: "new\n" },
	};
}
function screen(path: string) {
	return {
		sequence: 1,
		mode: "review" as const,
		prId: pr.id,
		reviewId: plan.id,
		baseSha: pr.baseSha,
		headSha: pr.headSha,
		path,
	};
}
function snapshot(path: string): WorkspaceSnapshot {
	return {
		sequence: 1,
		canvases: [
			{ kind: "review", id: "review", title: "Code", revision: 1 },
			{ kind: "center", id: "center", title: "Home", section: "home", revision: 1 },
		],
		primaryId: "review",
		secondaryId: null,
		review: screen(path),
		codeView: "diff",
		browser: null,
	};
}
class Keyboard extends EventTarget {
	document = {
		activeElement: null,
		querySelector: () => null,
		hasFocus: () => true,
		hidden: false,
	} as unknown as Document;
	press(key: string, changes: Partial<KeyboardEvent> = {}) {
		const event = Object.assign(new Event("keydown", { cancelable: true }), { key, ...changes });
		this.dispatchEvent(event);
		return event;
	}
}
function harness() {
	const commands: WorkspaceCommand[] = [];
	const reviews = createPreparedController(
		createPreparedApi(async () => {
			throw new Error("No IPC expected");
		}),
		"session"
	);
	const browser = createLocalBrowserController(async () => null);
	const workspace = createWorkspaceController(async () => null, reviews, browser, "session");
	const keyboard = new Keyboard();
	const select = (path: string) => {
		reviews.store.setState({ detail, file: file(path), screen: screen(path) });
		workspace.store.setState({ workspace: snapshot(path) });
	};
	select("a-implementation.ts");
	const disconnect = connectPreparedFileNavigation(
		reviews,
		{
			store: workspace.store,
			command: async (command) => {
				commands.push(command);
				return "applied";
			},
		},
		keyboard
	);
	return {
		commands,
		reviews,
		workspace,
		keyboard,
		select,
		disconnect,
		dispose: () => {
			disconnect();
			reviews.dispose();
			workspace.dispose();
			browser.dispose();
		},
	};
}

it("uses the current prepared file order for j/k and clamps endpoints without handling other keys", () => {
	const h = harness();
	try {
		assert.equal(h.keyboard.press("j").defaultPrevented, true);
		assert.equal(h.keyboard.press("k").defaultPrevented, true);
		assert.deepEqual(h.commands, [
			{ kind: "navigate-review", path: "m-tests.ts" },
			{ kind: "navigate-review", path: "z-api.ts" },
		]);
		h.select("z-api.ts");
		assert.equal(h.keyboard.press("k").defaultPrevented, false);
		h.select("m-tests.ts");
		assert.equal(h.keyboard.press("j").defaultPrevented, false);
		for (const key of ["Escape", " ", "Enter"]) h.keyboard.press(key);
		assert.equal(h.commands.length, 2);
		h.disconnect();
		h.keyboard.press("k");
		assert.equal(h.commands.length, 2, "unmount removes the listener");
	} finally {
		h.dispose();
	}
});

it("navigates a visible secondary review but leaves a hidden, loading or stale review alone", () => {
	const h = harness();
	try {
		const initial = snapshot("a-implementation.ts");
		h.workspace.store.setState({
			workspace: { ...initial, primaryId: "center", secondaryId: "review" },
		});
		h.keyboard.press("j");
		assert.equal(h.commands.length, 1);
		h.commands.length = 0;
		h.workspace.store.setState({ workspace: { ...initial, primaryId: "center" } });
		h.keyboard.press("j");
		h.workspace.store.setState({ workspace: initial, busy: true });
		h.keyboard.press("j");
		h.workspace.store.setState({ busy: false });
		h.reviews.store.setState({ fileBusy: true });
		h.keyboard.press("j");
		h.reviews.store.setState({ fileBusy: false, stale: true });
		h.keyboard.press("j");
		h.reviews.store.setState({ stale: false, detail: null });
		h.keyboard.press("j");
		assert.deepEqual(h.commands, []);
	} finally {
		h.dispose();
	}
});

it("requires the shown source, prepared plan and workspace to agree on PR, revision and path", () => {
	const h = harness();
	try {
		for (const mismatch of [
			{ mode: "conversation" as const },
			{ prId: "owner/other#8" },
			{ reviewId: "old-review" },
			{ baseSha: "c".repeat(40) },
			{ headSha: "c".repeat(40) },
			{ path: "z-api.ts" },
		]) {
			h.select("a-implementation.ts");
			const value = snapshot("a-implementation.ts");
			h.workspace.store.setState({
				workspace: { ...value, review: { ...value.review, ...mismatch } },
			});
			assert.equal(h.keyboard.press("j").defaultPrevented, false);
		}
		h.select("a-implementation.ts");
		h.reviews.store.setState({ file: { ...file("a-implementation.ts"), prId: "owner/other#8" } });
		h.keyboard.press("j");
		h.select("not-in-plan.ts");
		h.keyboard.press("j");
		assert.deepEqual(h.commands, []);
	} finally {
		h.dispose();
	}
});

async function until(predicate: () => boolean) {
	for (let count = 0; count < 30 && !predicate(); count++)
		await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(predicate(), true, "Expected controlled async state to settle");
}

it("j uses the real manual controller's source, progress and render/presentation receipt gate", async () => {
	const receipts: WorkspaceActionReceipt[] = [];
	const commands: WorkspaceCommand[] = [];
	const paths: string[] = [];
	let interruptions = 0;
	let canonical = snapshot("z-api.ts");
	const call = async (_type: "query" | "mutation", path: string, raw?: unknown) => {
		paths.push(path);
		const input = (raw ?? {}) as Record<string, unknown>;
		if (path === "workspace.observe")
			return { workspace: canonical, browser: null, reviews: [], capabilities: ["review"] };
		if (path === "workspace.prepare") {
			const command = input["command"] as Extract<WorkspaceCommand, { kind: "navigate-review" }>;
			commands.push(command);
			const next = snapshot(String(command.path));
			next.sequence = canonical.sequence + 1;
			return {
				kind: "workspace-canvas",
				sessionId: "session",
				turnId: "manual",
				generation: 1,
				requestId: input["requestId"],
				screenSequence: canonical.sequence,
				effect: {
					expectedSequence: canonical.sequence,
					snapshot: next,
					navigation: {
						prId: pr.id,
						reviewId: plan.id,
						baseSha: pr.baseSha,
						headSha: pr.headSha,
						path: command.path,
						paused: false,
					},
				},
			};
		}
		if (path === "reviews.file") return file(String(input["path"]));
		if (path === "reviews.screen") return input["screen"];
		if (path === "reviews.progress")
			return {
				...input,
				baseSha: pr.baseSha,
				headSha: pr.headSha,
				visited: [input["path"]],
				updatedAt: "2026-10-31T10:00:01Z",
			};
		if (path === "workspace.applied") {
			const receipt = raw as WorkspaceActionReceipt;
			receipts.push(receipt);
			canonical = receipt.workspace;
			return { status: "accepted" };
		}
		if (path === "localBrowser.present" || path === "localBrowser.close") return null;
		throw new Error(`Unexpected controlled RPC ${path}`);
	};
	const reviews = createPreparedController(createPreparedApi(call), "session");
	reviews.store.setState({ detail, file: file("z-api.ts"), screen: screen("z-api.ts") });
	const browser = createLocalBrowserController(call);
	const workspace = createWorkspaceController(call, reviews, browser, "session", {
		onManualChange: () => interruptions++,
	});
	const keyboard = new Keyboard();
	const disconnect = connectPreparedFileNavigation(reviews, workspace, keyboard);
	try {
		await workspace.start();
		keyboard.press("j");
		keyboard.press("j");
		await until(() => workspace.store.getState().workspace?.sequence === 2);
		assert.deepEqual(commands, [{ kind: "navigate-review", path: "a-implementation.ts" }]);
		assert.equal(interruptions, 1);
		assert.equal(reviews.store.getState().file?.path, "a-implementation.ts");
		assert.equal(reviews.store.getState().detail?.progress?.path, "a-implementation.ts");
		assert.equal(receipts.length, 0);
		workspace.rendered(2);
		await Promise.resolve();
		assert.equal(receipts.length, 0);
		workspace.presented(2, null);
		await until(() => !workspace.store.getState().busy);
		assert.equal(receipts.length, 1);
		assert.equal(receipts[0]?.status, "applied");
		assert.equal(receipts[0]?.workspace.review.path, "a-implementation.ts");
		assert.ok(paths.includes("reviews.file") && paths.includes("reviews.progress"));
	} finally {
		disconnect();
		workspace.dispose();
		reviews.dispose();
		browser.dispose();
	}
});
