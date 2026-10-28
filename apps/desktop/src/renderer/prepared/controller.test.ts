import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReviewInbox, ReviewScreen } from "../../shared/contracts";
import { ReviewWorkspace } from "./ReviewWorkspace";
import { createPreparedApi } from "./api";
import { createPreparedController } from "./controller";

const empty: ReviewInbox = {
	repository: null,
	localPath: null,
	items: [],
	refreshing: false,
	lastRefreshedAt: null,
};
it("connects only a valid explicit repository and displays server-reported states", async () => {
	const calls: Array<{ path: string; input: unknown }> = [];
	let current = empty;
	const api = createPreparedApi(async (_type, path, input) => {
		calls.push({ path, input });
		if (path === "reviews.connect")
			current = { ...empty, repository: "owner/project", refreshing: true };
		return current;
	});
	const ui = createPreparedController(api, "session");
	try {
		assert.equal(ui.store.getState().inbox, null);
		await ui.connect("https://github.com/owner/project");
		assert.equal(calls.length, 0);
		await ui.connect(" owner/project ");
		assert.deepEqual(calls, [{ path: "reviews.connect", input: { repository: "owner/project" } }]);
		assert.deepEqual(ui.store.getState().inbox, current);
		current = { ...current, refreshing: false, lastRefreshedAt: "2026-10-27T22:00:00Z" };
		await ui.poll();
		assert.deepEqual(ui.store.getState().inbox, current);
		assert.equal(
			calls.some((call) => call.path === "reviews.prepare"),
			false
		);
	} finally {
		ui.dispose();
	}
});
it("does not restore the old repository from a poll that finishes after a new connection", async () => {
	let resolveOld: (value: ReviewInbox) => void = () => {};
	const connected = { ...empty, repository: "new/repository" };
	const api = createPreparedApi(async (_type, path) =>
		path === "reviews.connect"
			? connected
			: new Promise<ReviewInbox>((resolve) => {
					resolveOld = resolve;
				})
	);
	const ui = createPreparedController(api, "session");
	try {
		const polling = ui.poll();
		await ui.connect("new/repository");
		resolveOld({ ...empty, repository: "old/repository" });
		await polling;
		assert.equal(ui.store.getState().inbox?.repository, "new/repository");
	} finally {
		ui.dispose();
	}
});
it("reports unavailable inbox without inventing review results", async () => {
	const ui = createPreparedController(
		createPreparedApi(async () => {
			throw new Error("offline");
		}),
		"session"
	);
	try {
		await ui.poll();
		assert.equal(ui.store.getState().inbox, null);
		assert.ok(ui.store.getState().error);
	} finally {
		ui.dispose();
	}
});

const pr = {
	id: "owner/project#1",
	repository: "owner/project",
	number: 1,
	title: "Change two files",
	url: "https://github.com/owner/project/pull/1",
	author: "owner",
	baseSha: "a".repeat(40),
	headSha: "b".repeat(40),
};
const plan = {
	id: "review-1",
	version: 1 as const,
	pr,
	createdAt: "2026-10-27T22:00:00Z",
	summary: "Prepared summary",
	orderRationale: "Read the entry point first",
	files: ["a.ts", "b.ts"].map((path) => ({
		path,
		reason: `Why ${path}`,
		summary: `Summary ${path}`,
		suggestedComments: [{ id: `draft-${path}`, body: "Consider the edge case." }],
	})),
	coverage: "complete" as const,
	evidence: "inferred-from-github" as const,
};
const detail = { pr, status: "ready" as const, prepared: plan, progress: null };
function source(path: string) {
	return {
		prId: pr.id,
		path,
		status: "modified",
		patch: "@@ -1 +1 @@\n-old\n+new",
		base: { path, commitSha: pr.baseSha, status: "available", content: "old\n" },
		head: { path, commitSha: pr.headSha, status: "available", content: "new\n" },
	};
}
function progress(input: Record<string, unknown>) {
	return {
		...input,
		baseSha: pr.baseSha,
		headSha: pr.headSha,
		visited: [input["path"]],
		updatedAt: "2026-10-27T22:00:01Z",
	};
}
function reviewHarness(
	override?: (path: string, input: Record<string, unknown>) => Promise<unknown> | undefined
) {
	const calls: Array<{ path: string; input: Record<string, unknown> }> = [];
	const api = createPreparedApi(async (_type, path, raw) => {
		const input = (raw ?? {}) as Record<string, unknown>;
		calls.push({ path, input });
		const custom = override?.(path, input);
		if (custom) return custom;
		if (path === "reviews.get" || path === "reviews.prepare") return detail;
		if (path === "reviews.file") return source(String(input["path"]));
		if (path === "reviews.progress") return progress(input);
		if (path === "reviews.screen") return input["screen"];
		if (path === "conversation.actionApplied") return { status: "accepted" };
		return { ...empty, repository: pr.repository, items: [detail] };
	});
	const ui = createPreparedController(api, "session");
	const action = (requestId = "navigate", changes = {}) => ({
		sessionId: "session",
		turnId: "turn",
		generation: 1,
		requestId,
		screenSequence: ui.store.getState().screen.sequence,
		kind: "review-navigation" as const,
		navigation: {
			reviewId: plan.id,
			prId: pr.id,
			baseSha: pr.baseSha,
			headSha: pr.headSha,
			path: "b.ts",
			paused: false,
			...changes,
		},
	});
	return { ui, calls, action };
}
it("workspace navigation loads exact source and saves it without using the legacy effect gate", async () => {
	const h = reviewHarness();
	try {
		const nav = h.action().navigation;
		const highlight = {
			repository: pr.repository,
			path: "b.ts",
			revision: "head" as const,
			commitSha: pr.headSha,
			startLine: 1,
			endLine: 1,
		};
		assert.equal(await h.ui.navigate({ ...nav, paused: true, highlight }, () => true), "applied");
		assert.equal(h.ui.store.getState().file?.path, "b.ts");
		assert.deepEqual(h.ui.store.getState().highlight, highlight);
		assert.equal(h.ui.getContext().screen?.paused, true);
		assert.equal(h.ui.store.getState().detail?.progress?.path, "b.ts");
		assert.ok(h.calls.every((call) => call.path !== "conversation.actionApplied"));
		assert.equal(
			(h.calls.find((call) => call.path === "reviews.screen")?.input["screen"] as ReviewScreen)
				.path,
			"b.ts"
		);
		const before = h.ui.getContext();
		assert.equal(await h.ui.navigate({ ...nav, headSha: "c".repeat(40) }, () => true), "ignored");
		assert.deepEqual(h.ui.getContext(), before);
	} finally {
		h.ui.dispose();
	}
});

it("cancelled workspace source loading cannot install or persist a late file", async () => {
	let finish: (value: unknown) => void = () => {};
	const h = reviewHarness((path) =>
		path === "reviews.file"
			? new Promise((resolve) => {
					finish = resolve;
				})
			: undefined
	);
	try {
		const abort = new AbortController();
		const pending = h.ui.navigate(h.action().navigation, () => true, abort.signal);
		for (let i = 0; i < 10 && !h.calls.some((call) => call.path === "reviews.file"); i++)
			await Promise.resolve();
		abort.abort();
		assert.equal(h.ui.store.getState().fileBusy, false);
		finish(source("b.ts"));
		assert.equal(await pending, "ignored");
		assert.equal(h.ui.store.getState().file, null);
		assert.ok(h.calls.every((call) => call.path !== "reviews.progress"));
	} finally {
		h.ui.dispose();
	}
});
it("shows fetched pinned source before persisting position and keeps pause visible", async () => {
	const h = reviewHarness();
	try {
		await h.ui.open(pr.id);
		assert.equal(h.ui.store.getState().file?.path, "a.ts");
		assert.equal(h.ui.store.getState().screen.path, "a.ts");
		assert.ok(
			h.calls.findIndex((call) => call.path === "reviews.file") <
				h.calls.findIndex((call) => call.path === "reviews.progress")
		);
		await h.ui.pause(true);
		assert.equal(h.ui.store.getState().screen.mode, "review");
		assert.equal(h.ui.store.getState().screen.paused, true);
		assert.equal(h.ui.store.getState().detail?.progress?.paused, true);
		h.ui.close();
		assert.deepEqual(h.ui.getContext(), {});
	} finally {
		h.ui.dispose();
	}
});
it("rejects wrong revision source without marking an unseen position", async () => {
	const h = reviewHarness((path, input) =>
		path === "reviews.file"
			? Promise.resolve({
					...source(String(input["path"])),
					head: { ...source("a.ts").head, commitSha: "c".repeat(40) },
				})
			: undefined
	);
	try {
		await h.ui.open(pr.id);
		assert.equal(h.ui.store.getState().file, null);
		assert.equal(
			h.calls.some((call) => call.path === "reviews.progress"),
			false
		);
		assert.ok(h.ui.store.getState().reviewError);
	} finally {
		h.ui.dispose();
	}
});
it("does not replace a manual selection with an older file response", async () => {
	let resolve: (value: unknown) => void = () => {};
	const h = reviewHarness((path, input) =>
		path === "reviews.file" && input["path"] === "b.ts"
			? new Promise((done) => {
					resolve = done;
				})
			: undefined
	);
	try {
		await h.ui.open(pr.id);
		h.calls.length = 0;
		const older = h.ui.showPath("b.ts");
		await h.ui.showPath("a.ts");
		resolve(source("b.ts"));
		await older;
		assert.equal(h.ui.store.getState().file?.path, "a.ts");
		assert.equal(
			h.calls.some((call) => call.path === "reviews.progress" && call.input["path"] === "b.ts"),
			false
		);
	} finally {
		h.ui.dispose();
	}
});
it("awaits file and progress settlement before one applied receipt for duplicate actions", async () => {
	let resolve: (value: unknown) => void = () => {};
	let saved: Record<string, unknown> = {};
	const h = reviewHarness((path, input) =>
		path === "reviews.progress" && input["path"] === "b.ts"
			? new Promise((done) => {
					saved = input;
					resolve = done;
				})
			: undefined
	);
	try {
		await h.ui.open(pr.id);
		h.calls.length = 0;
		const action = h.action();
		const first = h.ui.applyAction(action, () => true);
		const duplicate = h.ui.applyAction(action, () => true);
		for (let i = 0; i < 12; i++) await Promise.resolve();
		assert.equal(h.ui.store.getState().file?.path, "b.ts");
		assert.equal(
			h.calls.some((call) => call.path === "conversation.actionApplied"),
			false
		);
		resolve(progress(saved));
		assert.deepEqual(await Promise.all([first, duplicate]), ["applied", "applied"]);
		assert.equal(h.calls.filter((call) => call.path === "reviews.file").length, 1);
		const receipts = h.calls.filter((call) => call.path === "conversation.actionApplied");
		assert.equal(receipts.length, 1);
		assert.equal(receipts[0]?.input["status"], "applied");
		assert.deepEqual(receipts[0]?.input["screen"], h.ui.store.getState().screen);
	} finally {
		h.ui.dispose();
	}
});
it("ignores foreign PR/revision effects and retired file work without moving a newer screen", async () => {
	let resolve: (value: unknown) => void = () => {};
	const h = reviewHarness((path, input) =>
		path === "reviews.file" && input["path"] === "b.ts"
			? new Promise((done) => {
					resolve = done;
				})
			: undefined
	);
	try {
		await h.ui.open(pr.id);
		h.calls.length = 0;
		assert.equal(
			await h.ui.applyAction(h.action("foreign", { prId: "other/repo#2" }), () => true),
			"ignored"
		);
		assert.equal(
			await h.ui.applyAction(h.action("stale", { headSha: "d".repeat(40) }), () => true),
			"ignored"
		);
		assert.equal(
			h.calls.some((call) => call.path === "reviews.file"),
			false
		);
		let live = true;
		const pending = h.ui.applyAction(h.action("retired"), () => live);
		await Promise.resolve();
		await Promise.resolve();
		live = false;
		h.ui.close();
		const screen = h.ui.store.getState().screen;
		resolve(source("b.ts"));
		assert.equal(await pending, "ignored");
		assert.equal(h.ui.store.getState().file, null);
		assert.equal(h.ui.store.getState().screen, screen);
		assert.equal(
			h.calls.some((call) => call.path === "reviews.progress"),
			false
		);
	} finally {
		h.ui.dispose();
	}
});
it("native folder choice connects only the selected repository/path", async () => {
	const calls: Array<{ path: string; input: unknown }> = [];
	const selected = { repository: "owner/project", localPath: "/local/project" };
	const ui = createPreparedController(
		createPreparedApi(async (_type, path, input) => {
			calls.push({ path, input });
			return path === "reviews.chooseRepository" ? selected : { ...empty, ...selected };
		}),
		"session"
	);
	try {
		await ui.chooseRepository();
		assert.deepEqual(calls.find((call) => call.path === "reviews.connect")?.input, selected);
		assert.equal(ui.store.getState().inbox?.localPath, selected.localPath);
	} finally {
		ui.dispose();
	}
});

it("renders only the fetched plan/source and labels suggested comments as unposted inferences", async () => {
	const h = reviewHarness();
	try {
		await h.ui.open(pr.id);
		const html = renderToStaticMarkup(
			createElement(ReviewWorkspace, {
				controller: { ...h.ui, store: { ...h.ui.store, getInitialState: h.ui.store.getState } },
				onInteraction() {},
			})
		);
		assert.match(html, /Why a.ts/);
		assert.match(html, /Summary a.ts/);
		assert.match(html, /Consider the edge case/);
		assert.match(html, /Inferred drafts · not posted/);
		assert.match(html, /data-review-path="a.ts"/);
		assert.doesNotMatch(html, /Post comment|Scenario C|localhost/);
	} finally {
		h.ui.dispose();
	}
});
it("invalidates a pending file immediately on cancellation and ignores its later result", async () => {
	let resolve: (value: unknown) => void = () => {};
	const h = reviewHarness((path, input) =>
		path === "reviews.file" && input["path"] === "b.ts"
			? new Promise((done) => {
					resolve = done;
				})
			: undefined
	);
	try {
		await h.ui.open(pr.id);
		const abort = new AbortController();
		const pending = h.ui.applyAction(h.action(), () => !abort.signal.aborted, abort.signal);
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(h.ui.store.getState().fileBusy, true);
		abort.abort();
		assert.equal(h.ui.store.getState().fileBusy, false);
		const screen = h.ui.store.getState().screen;
		resolve(source("b.ts"));
		assert.equal(await pending, "ignored");
		assert.equal(h.ui.store.getState().screen, screen);
		assert.equal(h.ui.store.getState().file?.path, "a.ts");
	} finally {
		h.ui.dispose();
	}
});

it("accepts a renamed base path and binds each highlight to its own revision path", async () => {
	const previousPath = "previous/b.ts";
	const renamed = {
		...source("b.ts"),
		status: "renamed",
		base: { ...source("b.ts").base, path: previousPath },
	};
	const h = reviewHarness((path, input) =>
		path === "reviews.file" && input["path"] === "b.ts" ? Promise.resolve(renamed) : undefined
	);
	try {
		await h.ui.open(pr.id);
		const baseHighlight = {
			repository: pr.repository,
			revision: "base" as const,
			commitSha: pr.baseSha,
			path: previousPath,
			startLine: 1,
			endLine: 1,
		};
		assert.equal(
			await h.ui.applyAction(h.action("renamed-base", { highlight: baseHighlight }), () => true),
			"applied"
		);
		assert.equal(h.ui.store.getState().file?.base.path, previousPath);
		assert.equal(h.ui.store.getState().highlight?.path, previousPath);
		assert.equal(h.ui.store.getState().screen.path, "b.ts");
		assert.equal(h.ui.store.getState().detail?.progress?.path, "b.ts");
		const headHighlight = {
			...baseHighlight,
			revision: "head" as const,
			commitSha: pr.headSha,
			path: "b.ts",
		};
		assert.equal(
			await h.ui.applyAction(h.action("renamed-head", { highlight: headHighlight }), () => true),
			"applied"
		);
		assert.equal(
			await h.ui.applyAction(
				h.action("wrong-base-path", { highlight: { ...baseHighlight, path: "b.ts" } }),
				() => true
			),
			"ignored"
		);
		assert.equal(
			await h.ui.applyAction(
				h.action("wrong-head-path", { highlight: { ...headHighlight, path: previousPath } }),
				() => true
			),
			"ignored"
		);
	} finally {
		h.ui.dispose();
	}
});

it("limits the rename exception to base path and retains PR/head/base revision checks", async () => {
	const renamed = {
		...source("a.ts"),
		status: "renamed",
		base: { ...source("a.ts").base, path: "previous/a.ts" },
	};
	const invalid = [
		{ ...renamed, status: "modified" },
		{ ...renamed, head: { ...renamed.head, path: "other.ts" } },
		{ ...renamed, base: { ...renamed.base, commitSha: "c".repeat(40) } },
		{ ...renamed, head: { ...renamed.head, commitSha: "c".repeat(40) } },
		{ ...renamed, prId: "other/repository#2" },
	];
	for (const response of invalid) {
		const h = reviewHarness((path) =>
			path === "reviews.file" ? Promise.resolve(response) : undefined
		);
		try {
			await h.ui.open(pr.id);
			assert.equal(h.ui.store.getState().file, null);
			assert.equal(
				h.calls.some((call) => call.path === "reviews.progress"),
				false
			);
		} finally {
			h.ui.dispose();
		}
	}
});

it("publishes no review file identity while its plan or initial source is still loading", async () => {
	let resolveDetail: (value: unknown) => void = () => {};
	let resolveFile: (value: unknown) => void = () => {};
	let fileStarted = () => {};
	const fetchingFile = new Promise<void>((resolve) => {
		fileStarted = resolve;
	});
	const h = reviewHarness((path) => {
		if (path === "reviews.get")
			return new Promise((resolve) => {
				resolveDetail = resolve;
			});
		if (path === "reviews.file") {
			fileStarted();
			return new Promise((resolve) => {
				resolveFile = resolve;
			});
		}
		return undefined;
	});
	const published = () =>
		h.calls
			.filter((call) => call.path === "reviews.screen")
			.map((call) => call.input["screen"] as ReviewScreen);
	try {
		const opening = h.ui.open(pr.id);
		assert.equal(
			h.ui.store.getState().screen.mode,
			"review",
			"Keep the local loading pane visible"
		);
		assert.ok(published().length > 0);
		assert.ok(
			published().every(
				(screen) =>
					screen.mode === "conversation" && !screen.path && !screen.reviewId && !screen.paused
			)
		);
		resolveDetail(detail);
		await fetchingFile;
		assert.equal(h.ui.getContext().screen?.mode, "conversation");
		assert.ok(
			published().every(
				(screen) => screen.mode === "conversation" && !screen.path && !screen.reviewId
			)
		);
		resolveFile(source("a.ts"));
		await opening;
		const ready = published().filter((screen) => screen.mode === "review");
		assert.ok(ready.length > 0);
		for (const screen of ready) {
			assert.equal(screen.path, "a.ts");
			assert.equal(screen.reviewId, plan.id);
			assert.equal(screen.baseSha, pr.baseSha);
			assert.equal(screen.headSha, pr.headSha);
		}
	} finally {
		h.ui.dispose();
	}
});

it("does not publish a pathless review for an empty prepared plan", async () => {
	const h = reviewHarness((path) =>
		path === "reviews.get"
			? Promise.resolve({ ...detail, prepared: { ...plan, files: [] } })
			: undefined
	);
	try {
		await h.ui.open(pr.id);
		const screens = h.calls
			.filter((call) => call.path === "reviews.screen")
			.map((call) => call.input["screen"] as ReviewScreen);
		assert.ok(
			screens.every((screen) => screen.mode === "conversation" && !screen.reviewId && !screen.path)
		);
		assert.equal(h.ui.getContext().screen?.mode, "conversation");
		assert.equal(
			h.calls.some((call) => call.path === "reviews.progress"),
			false
		);
	} finally {
		h.ui.dispose();
	}
});
