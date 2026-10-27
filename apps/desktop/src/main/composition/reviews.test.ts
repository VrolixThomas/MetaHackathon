import assert from "node:assert/strict";
import { type TestContext, describe, it } from "node:test";
import type {
	ConversationPRContext,
	PinnedReviewFileRequest,
	PreparedReview,
	PullRequest,
	ReviewCache,
	ReviewFile,
	ReviewNavigation,
	ReviewScreen,
} from "../../shared/contracts";
import { ReviewCoordinator, type ReviewCoordinatorPorts } from "./reviews";
import { createReviewRouter } from "./reviews-router";

const repo = "example/project";
const base = "a".repeat(40);
const head = "b".repeat(40);
const nextHead = "c".repeat(40);
const signal = () => new AbortController().signal;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((done, failed) => {
		resolve = done;
		reject = failed;
	});
	return { promise, resolve, reject };
}
function pr(number = 1, headSha = head): PullRequest {
	return {
		id: `${repo}#${number}`,
		repository: repo,
		number,
		title: `Change ${number}`,
		author: "author",
		url: `https://github.com/${repo}/pull/${number}`,
		baseSha: base,
		headSha,
	};
}
function context(value: PullRequest): ConversationPRContext {
	return {
		pr: value,
		description: "A test change",
		truncated: false,
		files: ["src/first.ts", "src/second.ts"].map((path) => ({
			path,
			status: "modified",
			additions: 2,
			deletions: 1,
			patch: "@@ -1 +1 @@\n-old\n+new",
		})),
	};
}
function prepared(value: PullRequest, suffix = ""): PreparedReview {
	return {
		id: `review:${value.id}:${value.headSha}${suffix}`,
		version: 1,
		pr: value,
		createdAt: "2026-10-27T12:00:00Z",
		summary: "Inferred change summary",
		orderRationale: "Read dependencies first",
		evidence: "inferred-from-github",
		coverage: "complete",
		files: context(value).files.map(({ path }) => ({
			path,
			reason: "Understand the change",
			summary: "Updated behavior",
			suggestedComments: [{ id: `suggestion:${path}`, body: "Consider a boundary test." }],
		})),
	};
}
function file(input: PinnedReviewFileRequest): ReviewFile {
	return {
		prId: input.prId,
		path: input.path,
		status: "modified",
		patch: "@@ -1 +1 @@\n-old\n+new",
		base: {
			path: input.path,
			commitSha: input.baseSha,
			status: "available",
			content: "old\nline two\n",
		},
		head: {
			path: input.path,
			commitSha: input.headSha,
			status: "available",
			content: "new\nline two\n",
		},
	};
}
async function until(check: () => boolean | Promise<boolean>) {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (await check()) return;
		await tick();
	}
	assert.fail("injected work did not reach expected state");
}
function harness(t: TestContext, overrides: Partial<ReviewCoordinatorPorts> = {}) {
	const state = {
		cache: { repository: null, localPath: null, prepared: [], progress: [] } as ReviewCache,
		open: [pr()],
		current: new Map([[pr().id, pr()]]),
		saves: [] as ReviewCache[],
		listed: [] as string[],
		prepared: [] as ConversationPRContext[],
		signals: [] as AbortSignal[],
		files: [] as { input: PinnedReviewFileRequest; localPath: string | null }[],
		closed: false,
	};
	const ports: ReviewCoordinatorPorts = {
		loadCache: () => structuredClone(state.cache),
		saveCache: (cache) => {
			assert.equal(state.closed, false);
			state.cache = structuredClone(cache);
			state.saves.push(structuredClone(cache));
		},
		listOpen: async (repository) => {
			state.listed.push(repository);
			return structuredClone(state.open);
		},
		readPR: async (id) => {
			const value = state.current.get(id);
			if (!value) throw new Error("fake-secret missing PR");
			return structuredClone(value);
		},
		getContext: async (id) => context(structuredClone(state.current.get(id) as PullRequest)),
		readFile: async (input, localPath) => {
			state.files.push({ input, localPath });
			return file(input);
		},
		prepare: async (input, active) => {
			state.prepared.push(structuredClone(input));
			state.signals.push(active);
			return prepared(input.pr);
		},
		validateLocal: async () => "/canonical/local",
		...overrides,
	};
	const coordinator = new ReviewCoordinator(ports);
	t.after(() => coordinator.dispose());
	return {
		state,
		ports,
		coordinator,
		caller: createReviewRouter(() => coordinator).createCaller({}),
	};
}
async function ready(coordinator: ReviewCoordinator, id = pr().id) {
	await until(async () => (await coordinator.get(id)).status === "ready");
	return coordinator.getReady(id, signal());
}
function shown(navigation: ReviewNavigation, sequence = 1): ReviewScreen {
	const { reviewId, prId, baseSha, headSha, path, paused } = navigation;
	return { sequence, mode: "review", reviewId, prId, baseSha, headSha, path, paused };
}
function receipt(screen: ReviewScreen) {
	return {
		sessionId: "session",
		turnId: "turn",
		generation: 1,
		requestId: "action",
		status: "applied" as const,
		screen,
	};
}

describe("prepared review queue and durable cache", () => {
	it("starts with ordinary conversation and no repository, model or GitHub calls", async (t) => {
		const { coordinator, state, caller } = harness(t);
		await coordinator.initialize();
		assert.deepEqual(await caller.inbox(), {
			repository: null,
			localPath: null,
			items: [],
			refreshing: false,
			lastRefreshedAt: null,
		});
		assert.deepEqual(await coordinator.getScreen("session"), {
			sequence: 0,
			mode: "conversation",
			prId: null,
		});
		await caller.refresh();
		assert.deepEqual(state.listed, []);
		assert.deepEqual(state.prepared, []);
		assert.deepEqual(state.saves, []);
	});
	it("precomputes before opening, persists progress and resumes the same head without another model call", async (t) => {
		const { coordinator, state, ports, caller } = harness(t);
		await caller.connect({ repository: repo, localPath: "/selected/dirty-repo" });
		await until(() => state.cache.prepared.length === 1);
		assert.equal(state.prepared.length, 1);
		const review = await ready(coordinator);
		await caller.progress({
			prId: pr().id,
			reviewId: review.id,
			path: review.files[0]?.path ?? "",
			paused: true,
		});
		await coordinator.dispose();
		const restarted = new ReviewCoordinator(ports);
		t.after(() => restarted.dispose());
		await restarted.initialize();
		assert.equal((await restarted.getReady(pr().id, signal())).id, review.id);
		assert.equal((await restarted.getProgress(pr().id, signal()))?.paused, true);
		assert.equal(state.prepared.length, 1);
		assert.equal((await restarted.inbox()).localPath, "/canonical/local");
	});
	it("runs one preparation at a time and preserves independent cached results", async (t) => {
		const first = deferred<PreparedReview>();
		const second = deferred<PreparedReview>();
		const started: number[] = [];
		const { coordinator, state } = harness(t, {
			prepare: async (input) => {
				started.push(input.pr.number);
				return input.pr.number === 1 ? first.promise : second.promise;
			},
		});
		state.open = [pr(1), pr(2)];
		state.current.set(pr(2).id, pr(2));
		await coordinator.connect({ repository: repo });
		await until(() => started.length === 1);
		assert.equal((await coordinator.get(pr(2).id)).status, "queued");
		first.resolve(prepared(pr(1)));
		await until(() => started.length === 2);
		second.resolve(prepared(pr(2)));
		await ready(coordinator, pr(2).id);
		assert.deepEqual(started, [1, 2]);
		assert.equal(state.cache.prepared.length, 2);
	});
	it("keeps an existing connection if local-origin or remote validation fails and never touches dirty files", async (t) => {
		const dirty = { tracked: "unsaved local edit", untracked: "keep me" };
		const original = structuredClone(dirty);
		const { coordinator, state, ports } = harness(t);
		await coordinator.connect({ repository: repo, localPath: "/dirty" });
		await ready(coordinator);
		ports.validateLocal = async () => {
			throw new Error("fake-secret wrong origin");
		};
		await assert.rejects(
			coordinator.connect({ repository: "other/repo", localPath: "/wrong" }),
			/origin/
		);
		assert.equal((await coordinator.inbox()).repository, repo);
		ports.listOpen = async () => {
			throw new Error("fake-secret remote denied");
		};
		await assert.rejects(coordinator.connect({ repository: "other/repo" }), /GitHub token/);
		assert.equal(state.cache.repository, repo);
		const review = await coordinator.getReady(pr().id, signal());
		const result = await coordinator.file({
			prId: pr().id,
			reviewId: review.id,
			path: "src/first.ts",
		});
		assert.equal(result.head.content, "new\nline two\n");
		assert.equal(state.files[0]?.localPath, "/canonical/local");
		assert.equal(state.files[0]?.input.headSha, head);
		assert.deepEqual(dirty, original);
	});
	it("failed preparation never fabricates results or loops on refresh; explicit prepare retries", async (t) => {
		let calls = 0;
		let failing = true;
		const { coordinator, state } = harness(t, {
			prepare: async (input) => {
				calls++;
				if (failing) throw new Error("fake-secret provider failure");
				return prepared(input.pr);
			},
		});
		await coordinator.connect({ repository: repo });
		await until(async () => (await coordinator.get(pr().id)).status === "error");
		await coordinator.refresh();
		await coordinator.refresh();
		assert.equal(calls, 1);
		assert.equal(state.cache.prepared.length, 0);
		const failed = await coordinator.get(pr().id);
		assert.equal(failed.prepared, null);
		assert.equal(JSON.stringify(failed).includes("fake-secret"), false);
		await assert.rejects(coordinator.getReady(pr().id, signal()), /model key/);
		failing = false;
		await coordinator.prepareReview(pr().id);
		await ready(coordinator);
		assert.equal(calls, 2);
	});
	it("rejects foreign prepared files and suggested comment SHAs without fallback analysis", async (t) => {
		const { coordinator, state } = harness(t, {
			prepare: async (input) => {
				const review = prepared(input.pr);
				const comment = review.files[0]?.suggestedComments[0];
				assert.ok(comment);
				comment.location = {
					repository: repo,
					revision: "head",
					commitSha: nextHead,
					path: "src/first.ts",
					startLine: 1,
					endLine: 1,
				};
				return review;
			},
		});
		await coordinator.connect({ repository: repo });
		await until(async () => (await coordinator.get(pr().id)).status === "error");
		assert.equal(state.cache.prepared.length, 0);
		assert.equal((await coordinator.get(pr().id)).prepared, null);
	});
	it("bounds the repository inbox to 200 and rejects inconsistent cache data", async (t) => {
		const { coordinator, state } = harness(t);
		state.open = Array.from({ length: 201 }, (_, index) => pr(index + 1));
		await assert.rejects(coordinator.connect({ repository: repo }));
		assert.equal((await coordinator.inbox()).repository, null);
		assert.equal(state.prepared.length, 0);
		const bad = harness(t, {
			loadCache: () => ({
				repository: "other/repo",
				localPath: null,
				prepared: [prepared(pr())],
				progress: [],
			}),
		});
		await assert.rejects(bad.coordinator.initialize(), /Saved reviews/);
	});
	it("polling starts only after connection and stops after disconnect", async (t) => {
		const { coordinator, state } = harness(t, { pollIntervalMs: 10 });
		await coordinator.initialize();
		await new Promise((resolve) => setTimeout(resolve, 25));
		assert.equal(state.listed.length, 0);
		await coordinator.connect({ repository: repo });
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.ok(state.listed.length >= 2);
		await coordinator.disconnect();
		const count = state.listed.length;
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(state.listed.length, count);
	});
});

describe("repository connection transactions", () => {
	it("keeps the accepted connection, cache and progress when candidate persistence fails", async (t) => {
		const { coordinator, state, ports } = harness(t);
		await coordinator.connect({ repository: repo, localPath: "/accepted" });
		const review = await ready(coordinator);
		await coordinator.progress({
			prId: pr().id,
			reviewId: review.id,
			path: "src/second.ts",
			paused: true,
		});
		const accepted = structuredClone(state.cache);
		const inbox = await coordinator.inbox();
		ports.listOpen = async () => [];
		ports.saveCache = async () => {
			throw new Error("fake-secret unavailable store");
		};
		await assert.rejects(
			coordinator.connect({ repository: "other/repo" }),
			(error: Error) => !error.message.includes("fake-secret")
		);
		assert.deepEqual(await coordinator.inbox(), inbox);
		assert.deepEqual(state.cache, accepted);
		assert.equal((await coordinator.getReady(pr().id, signal())).id, review.id);
		assert.equal((await coordinator.getProgress(pr().id, signal()))?.paused, true);
	});
	it("rolls back an aborted candidate after a newer invalid selection and retains queued progress", async (t) => {
		const { coordinator, state, ports } = harness(t);
		await coordinator.connect({ repository: repo });
		const review = await ready(coordinator);
		await coordinator.progress({
			prId: pr().id,
			reviewId: review.id,
			path: "src/first.ts",
			paused: false,
		});
		const saving = deferred<void>();
		let writing = false;
		const save = ports.saveCache;
		ports.listOpen = async (repository) => {
			if (repository === "invalid/newer") throw new Error("fake-secret denied");
			return [];
		};
		ports.saveCache = async (cache) => {
			if (cache.repository === "valid/older") {
				writing = true;
				await saving.promise;
			}
			await save(cache);
		};
		try {
			const older = coordinator.connect({ repository: "valid/older" });
			const rejected = assert.rejects(older, /cancelled/);
			await until(() => writing);
			assert.equal((await coordinator.inbox()).repository, repo);
			assert.equal((await coordinator.getReady(pr().id, signal())).id, review.id);
			const progress = coordinator.progress({
				prId: pr().id,
				reviewId: review.id,
				path: "src/second.ts",
				paused: true,
			});
			await assert.rejects(coordinator.connect({ repository: "invalid/newer" }), /GitHub token/);
			saving.resolve();
			await Promise.all([rejected, progress]);
			assert.equal((await coordinator.inbox()).repository, repo);
			assert.equal(state.cache.repository, repo);
			assert.equal(state.cache.prepared[0]?.id, review.id);
			assert.equal(state.cache.progress[0]?.path, "src/second.ts");
			assert.equal(state.cache.progress[0]?.paused, true);
			const candidateWrite = state.saves.findIndex((cache) => cache.repository === "valid/older");
			assert.ok(candidateWrite >= 0);
			assert.equal(state.saves[candidateWrite + 1]?.repository, repo);
		} finally {
			saving.resolve();
		}
	});
	it("publishes the new connection and aborts old preparation only after a guarded save", async (t) => {
		const oldWork = deferred<PreparedReview>();
		let oldSignal: AbortSignal | undefined;
		const { coordinator, state, ports } = harness(t, {
			prepare: async (input, active) => {
				if (input.pr.repository === repo) {
					oldSignal = active;
					return oldWork.promise;
				}
				return prepared(input.pr);
			},
		});
		await coordinator.connect({ repository: repo });
		await until(() => Boolean(oldSignal));
		const other = {
			...pr(),
			id: "other/repo#1",
			repository: "other/repo",
			url: "https://github.com/other/repo/pull/1",
		};
		state.current.set(other.id, other);
		ports.listOpen = async () => [other];
		const saving = deferred<void>();
		let writing = false;
		const save = ports.saveCache;
		ports.saveCache = async (cache) => {
			if (cache.repository === other.repository) {
				writing = true;
				await saving.promise;
			}
			await save(cache);
		};
		try {
			const connection = coordinator.connect({ repository: other.repository });
			await until(() => writing);
			assert.equal(oldSignal?.aborted, false);
			assert.equal((await coordinator.inbox()).repository, repo);
			assert.equal(state.cache.repository, repo);
			saving.resolve();
			assert.equal((await connection).repository, other.repository);
			assert.equal(oldSignal?.aborted, true);
			assert.equal((await ready(coordinator, other.id)).pr.repository, other.repository);
			assert.equal(state.cache.repository, other.repository);
		} finally {
			saving.resolve();
			oldWork.resolve(prepared(pr()));
		}
	});
	it("rejects a stale reconnect snapshot if the accepted PR changes during its save", async (t) => {
		const { coordinator, state, ports } = harness(t);
		await coordinator.connect({ repository: repo });
		await ready(coordinator);
		const saving = deferred<void>();
		let writing = false;
		const save = ports.saveCache;
		ports.saveCache = async (cache) => {
			if (cache.localPath === "/canonical/local") {
				writing = true;
				await saving.promise;
			}
			await save(cache);
		};
		try {
			const connection = coordinator.connect({ repository: repo, localPath: "/new/path" });
			const rejected = assert.rejects(connection, /changed while connecting/);
			await until(() => writing);
			state.open = [pr(1, nextHead)];
			state.current.set(pr().id, pr(1, nextHead));
			const refresh = coordinator.refresh();
			await until(async () => (await coordinator.get(pr().id)).pr.headSha === nextHead);
			saving.resolve();
			await Promise.all([rejected, refresh]);
			assert.equal((await ready(coordinator)).pr.headSha, nextHead);
			assert.equal(state.cache.localPath, null);
			assert.equal(state.cache.prepared[0]?.pr.headSha, nextHead);
		} finally {
			saving.resolve();
		}
	});
});

describe("prepared review durable publication", () => {
	it("keeps a pending candidate private until its save succeeds", async (t) => {
		const { coordinator, state, ports } = harness(t);
		const saving = deferred<void>();
		let started = false;
		const save = ports.saveCache;
		ports.saveCache = async (cache) => {
			if (cache.prepared.length) {
				started = true;
				await saving.promise;
			}
			await save(cache);
		};
		try {
			await coordinator.connect({ repository: repo });
			await until(() => started);
			const pending = (await coordinator.inbox()).items[0];
			assert.equal(pending?.status, "preparing");
			assert.equal(pending?.prepared, null);
			assert.equal(pending?.progress, null);
			assert.deepEqual(state.cache.prepared, []);
			await assert.rejects(coordinator.getReady(pr().id, signal()), /still being prepared/);
			saving.resolve();
			const review = await ready(coordinator);
			assert.deepEqual(state.cache.prepared, [review]);
		} finally {
			saving.resolve();
		}
	});
	it("never exposes ready when the delayed save fails", async (t) => {
		const { coordinator, state, ports } = harness(t);
		const saving = deferred<void>();
		let started = false;
		const save = ports.saveCache;
		ports.saveCache = async (cache) => {
			if (cache.prepared.length) {
				started = true;
				await saving.promise;
			}
			await save(cache);
		};
		try {
			await coordinator.connect({ repository: repo });
			await until(() => started);
			assert.equal((await coordinator.get(pr().id)).status, "preparing");
			saving.reject(new Error("fake-secret database unavailable"));
			await until(async () => (await coordinator.get(pr().id)).status === "error");
			const failed = await coordinator.get(pr().id);
			assert.equal(failed.prepared, null);
			assert.equal(JSON.stringify(failed).includes("fake-secret"), false);
			assert.deepEqual(state.cache.prepared, []);
			await coordinator.refresh();
			assert.equal(state.prepared.length, 1);
		} finally {
			saving.resolve();
		}
	});
	it("rolls back a superseded candidate and preserves queued newer progress", async (t) => {
		const { coordinator, state, ports } = harness(t);
		state.open = [pr(), pr(2)];
		state.current.set(pr(2).id, pr(2));
		await coordinator.connect({ repository: repo });
		await ready(coordinator);
		const other = await ready(coordinator, pr(2).id);
		await coordinator.progress({
			prId: other.pr.id,
			reviewId: other.id,
			path: "src/first.ts",
			paused: false,
		});
		const saving = deferred<void>();
		let held = false;
		const save = ports.saveCache;
		const writes: ReviewCache[] = [];
		ports.saveCache = async (cache) => {
			if (
				!held &&
				cache.prepared.some((review) => review.pr.id === pr().id && review.pr.headSha === head)
			) {
				held = true;
				await saving.promise;
			}
			writes.push(structuredClone(cache));
			await save(cache);
		};
		try {
			await coordinator.prepareReview(pr().id, true);
			await until(() => held);
			assert.equal((await coordinator.get(pr().id)).status, "preparing");
			const progress = coordinator.progress({
				prId: other.pr.id,
				reviewId: other.id,
				path: "src/second.ts",
				paused: true,
			});
			state.open = [pr(1, nextHead), pr(2)];
			state.current.set(pr().id, pr(1, nextHead));
			const refresh = coordinator.refresh();
			await until(async () => (await coordinator.get(pr().id)).pr.headSha === nextHead);
			saving.resolve();
			await Promise.all([progress, refresh]);
			const current = await ready(coordinator);
			assert.equal(current.pr.headSha, nextHead);
			const oldWrite = writes.findIndex((cache) =>
				cache.prepared.some((review) => review.pr.id === pr().id && review.pr.headSha === head)
			);
			assert.ok(oldWrite >= 0);
			assert.equal(
				writes[oldWrite + 1]?.prepared.some((review) => review.pr.id === pr().id),
				false
			);
			assert.equal(
				state.cache.prepared.some(
					(review) => review.pr.id === pr().id && review.pr.headSha === head
				),
				false
			);
			assert.deepEqual(
				state.cache.progress.find((item) => item.prId === other.pr.id),
				await coordinator.getProgress(other.pr.id, signal())
			);
			assert.equal(
				state.cache.progress.find((item) => item.prId === other.pr.id)?.path,
				"src/second.ts"
			);
			assert.equal(state.cache.progress.find((item) => item.prId === other.pr.id)?.paused, true);
		} finally {
			saving.resolve();
		}
	});
	it("drains and rolls back an aborted candidate before shutdown completes", async (t) => {
		const { coordinator, state, ports } = harness(t);
		const saving = deferred<void>();
		let started = false;
		const save = ports.saveCache;
		ports.saveCache = async (cache) => {
			if (cache.prepared.length) {
				started = true;
				await saving.promise;
			}
			await save(cache);
		};
		try {
			await coordinator.connect({ repository: repo });
			await until(() => started);
			let finished = false;
			const disposal = coordinator.dispose().then(() => {
				finished = true;
			});
			await tick();
			assert.equal(finished, false);
			saving.resolve();
			await disposal;
			assert.deepEqual(state.cache.prepared, []);
			state.closed = true;
			const writes = state.saves.length;
			await tick();
			assert.equal(state.saves.length, writes);
		} finally {
			saving.resolve();
		}
	});
});

describe("review revision and shutdown fences", () => {
	it("caller cancellation reaches an in-flight pinned read without publishing late content", async (t) => {
		const waiting = deferred<ReviewFile>();
		let reading: AbortSignal | undefined;
		const { coordinator } = harness(t, {
			readFile: async (_, __, active) => {
				reading = active;
				return waiting.promise;
			},
		});
		await coordinator.connect({ repository: repo });
		const review = await ready(coordinator);
		const controller = new AbortController();
		const result = coordinator.file(
			{ prId: pr().id, reviewId: review.id, path: "src/first.ts" },
			controller.signal
		);
		const rejected = assert.rejects(result, /cancelled/);
		await until(() => Boolean(reading));
		controller.abort();
		await rejected;
		assert.equal(reading?.aborted, true);
		waiting.resolve(file({ prId: pr().id, baseSha: base, headSha: head, path: "src/first.ts" }));
		await tick();
	});
	it("shutdown during resumed cache persistence never starts polling or new preparation", async (t) => {
		const saving = deferred<void>();
		let entered = false;
		const { coordinator, state } = harness(t, {
			loadCache: () => ({
				repository: repo,
				localPath: null,
				prepared: [prepared(pr())],
				progress: [],
			}),
			saveCache: async () => {
				entered = true;
				await saving.promise;
			},
			pollIntervalMs: 10,
		});
		const initialization = coordinator.initialize();
		const rejected = assert.rejects(initialization, /cancelled/);
		await until(() => entered);
		const stop = coordinator.dispose();
		saving.resolve();
		await Promise.all([rejected, stop]);
		await new Promise((resolve) => setTimeout(resolve, 25));
		assert.equal(state.listed.length, 1);
		assert.equal(state.prepared.length, 0);
		await assert.rejects(coordinator.initialize(), /cancelled/);
	});
	it("head change aborts old preparation and suppresses its late result", async (t) => {
		const stale = deferred<PreparedReview>();
		let oldSignal: AbortSignal | undefined;
		const { coordinator, state } = harness(t, {
			prepare: async (input, active) => {
				if (input.pr.headSha === head) {
					oldSignal = active;
					return stale.promise;
				}
				return prepared(input.pr);
			},
		});
		await coordinator.connect({ repository: repo });
		await until(() => Boolean(oldSignal));
		state.open = [pr(1, nextHead)];
		state.current.set(pr().id, pr(1, nextHead));
		await coordinator.refresh();
		await ready(coordinator);
		assert.equal(oldSignal?.aborted, true);
		stale.resolve(prepared(pr()));
		await tick();
		assert.equal(state.cache.prepared[0]?.pr.headSha, nextHead);
		assert.equal((await coordinator.get(pr().id)).prepared?.pr.headSha, nextHead);
	});
	it("revalidates after model completion and queues a changed revision before publishing", async (t) => {
		let calls = 0;
		const { coordinator, state } = harness(t, {
			prepare: async (input) => {
				calls++;
				state.current.set(pr().id, pr(1, nextHead));
				return prepared(input.pr);
			},
		});
		await coordinator.connect({ repository: repo });
		await until(() => state.cache.prepared[0]?.pr.headSha === nextHead);
		assert.equal(calls, 2);
		assert.equal(
			state.saves.some((cache) => cache.prepared.some((review) => review.pr.headSha === head)),
			false
		);
	});
	it("getReady catches a changed PR and stale file completion cannot return old content", async (t) => {
		const { coordinator, state, ports } = harness(t);
		await coordinator.connect({ repository: repo });
		const old = await ready(coordinator);
		const pendingFile = deferred<ReviewFile>();
		let reading = false;
		ports.readFile = async () => {
			reading = true;
			return pendingFile.promise;
		};
		const result = coordinator.file({ prId: pr().id, reviewId: old.id, path: "src/first.ts" });
		const rejected = assert.rejects(result, /changed/);
		await until(() => reading);
		state.current.set(pr().id, pr(1, nextHead));
		pendingFile.resolve(
			file({ prId: pr().id, baseSha: base, headSha: head, path: "src/first.ts" })
		);
		await rejected;
		const current = await ready(coordinator);
		assert.equal(current.pr.headSha, nextHead);
		await assert.rejects(
			coordinator.file({ prId: pr().id, reviewId: old.id, path: "src/first.ts" }),
			/old review/
		);
		state.current.set(pr().id, pr(1, "d".repeat(40)));
		await assert.rejects(coordinator.getReady(pr().id, signal()), /changed/);
	});
	it("closing a PR cancels its job and removes the durable review", async (t) => {
		const waiting = deferred<PreparedReview>();
		let active: AbortSignal | undefined;
		const { coordinator, state } = harness(t, {
			prepare: async (_, signal) => {
				active = signal;
				return waiting.promise;
			},
		});
		await coordinator.connect({ repository: repo });
		await until(() => Boolean(active));
		state.open = [];
		await coordinator.refresh();
		assert.equal(active?.aborted, true);
		waiting.resolve(prepared(pr()));
		await tick();
		assert.deepEqual((await coordinator.inbox()).items, []);
		assert.deepEqual(state.cache.prepared, []);
	});
	it("disconnect cancels pending connection validation and cannot be undone by its late result", async (t) => {
		const waiting = deferred<PullRequest[]>();
		let listing = false;
		const { coordinator, state } = harness(t, {
			listOpen: async () => {
				listing = true;
				return waiting.promise;
			},
		});
		await coordinator.initialize();
		const connection = coordinator.connect({ repository: repo });
		const rejected = assert.rejects(connection);
		await until(() => listing);
		await coordinator.disconnect();
		waiting.resolve([pr()]);
		await rejected;
		assert.equal((await coordinator.inbox()).repository, null);
		assert.equal(state.prepared.length, 0);
	});
	it("disposal aborts uncooperative callbacks without late publication or store access", async (t) => {
		const waiting = deferred<PreparedReview>();
		let active: AbortSignal | undefined;
		const { coordinator, state } = harness(t, {
			prepare: async (_, signal) => {
				active = signal;
				return waiting.promise;
			},
		});
		await coordinator.connect({ repository: repo });
		await until(() => Boolean(active));
		const disposed = coordinator.dispose();
		assert.equal(coordinator.dispose(), disposed);
		await disposed;
		state.closed = true;
		const saved = state.saves.length;
		waiting.resolve(prepared(pr()));
		await tick();
		assert.equal(active?.aborted, true);
		assert.equal(state.saves.length, saved);
		await assert.rejects(coordinator.inbox(), /cancelled/);
		await assert.rejects(coordinator.connect({ repository: repo }));
	});
	it("disposal drains a started SQLite save before the owner closes its store", async (t) => {
		const { coordinator, state, ports } = harness(t);
		await coordinator.connect({ repository: repo });
		await ready(coordinator);
		await tick();
		const written = deferred<void>();
		let writing = false;
		ports.saveCache = async (cache) => {
			writing = true;
			await written.promise;
			assert.equal(state.closed, false);
			state.cache = structuredClone(cache);
		};
		const disconnected = coordinator.disconnect();
		await until(() => writing);
		let stopped = false;
		const stop = coordinator.dispose().then(() => {
			stopped = true;
		});
		await tick();
		assert.equal(stopped, false);
		written.resolve();
		await Promise.allSettled([disconnected, stop]);
		state.closed = true;
		assert.equal(stopped, true);
	});
});

describe("review navigation, actual progress and canonical screens", () => {
	it("renamed files preserve the runtime-verified original base path for highlights", async (t) => {
		const { coordinator } = harness(t, {
			readFile: async (input) => {
				const result = file(input);
				result.status = "renamed";
				result.base.path = "src/original.ts";
				return result;
			},
		});
		await coordinator.connect({ repository: repo });
		await ready(coordinator);
		const navigation = await coordinator.navigate(pr().id, { side: "base", line: 1 }, signal());
		assert.equal(navigation.path, "src/first.ts");
		assert.equal(navigation.highlight?.path, "src/original.ts");
		assert.equal(navigation.highlight?.commitSha, base);
	});
	it("navigation does not mark files visited; shown receipts persist pause/resume and exact screen", async (t) => {
		const { coordinator, state } = harness(t);
		await coordinator.connect({ repository: repo });
		const review = await ready(coordinator);
		const first = await coordinator.navigate(pr().id, { direction: "start", line: 2 }, signal());
		assert.equal(first.path, "src/first.ts");
		assert.equal(first.highlight?.commitSha, head);
		assert.equal(await coordinator.getProgress(pr().id, signal()), null);
		await coordinator.actionApplied(receipt(shown(first)), first, signal());
		assert.deepEqual((await coordinator.getProgress(pr().id, signal()))?.visited, [first.path]);
		const second = await coordinator.navigate(pr().id, { direction: "next" }, signal());
		assert.equal(second.path, "src/second.ts");
		await coordinator.actionApplied(receipt(shown(second, 2)), second, signal());
		const pause = await coordinator.navigate(pr().id, { direction: "pause" }, signal());
		await coordinator.actionApplied(receipt(shown(pause, 3)), pause, signal());
		assert.equal((await coordinator.getProgress(pr().id, signal()))?.paused, true);
		assert.equal((await coordinator.getScreen("session")).paused, true);
		assert.equal(
			(await coordinator.navigate(pr().id, { direction: "resume" }, signal())).path,
			second.path
		);
		assert.equal(state.cache.progress[0]?.reviewId, review.id);
		await assert.rejects(
			coordinator.navigate(pr().id, { line: 99 }, signal()),
			/line is unavailable/
		);
	});
	it("rejects stale progress, foreign files and mismatched applied receipts", async (t) => {
		const { coordinator, caller } = harness(t);
		await caller.connect({ repository: repo });
		const review = await ready(coordinator);
		await assert.rejects(
			caller.progress({ prId: pr().id, reviewId: "old", path: "src/first.ts", paused: false }),
			/old review/
		);
		await assert.rejects(
			caller.file({ prId: pr().id, reviewId: review.id, path: "not-changed.ts" }),
			/old review/
		);
		const navigation = await coordinator.navigate(pr().id, {}, signal());
		await assert.rejects(
			coordinator.actionApplied(receipt({ ...shown(navigation), headSha: nextHead }), navigation),
			/old review/
		);
		await assert.rejects(
			coordinator.actionApplied(receipt({ ...shown(navigation), paused: true }), navigation),
			/does not match/
		);
		assert.equal(await coordinator.getProgress(pr().id, signal()), null);
	});
	it("canonical screens are monotonic, reject equal conflicts and do not themselves persist progress", async (t) => {
		const { coordinator, caller } = harness(t);
		await caller.connect({ repository: repo });
		await ready(coordinator);
		const navigation = await coordinator.navigate(pr().id, {}, signal());
		const current = shown(navigation, 3);
		await caller.screen({ sessionId: "session", screen: current });
		assert.deepEqual(
			await coordinator.getScreen("session", { sequence: 1, mode: "conversation", prId: null }),
			current
		);
		await assert.rejects(
			caller.screen({
				sessionId: "session",
				screen: { sequence: 3, mode: "conversation", prId: null },
			}),
			/share a sequence/
		);
		await assert.rejects(
			coordinator.actionApplied(receipt(shown(navigation, 2)), navigation),
			/stale/
		);
		assert.equal(await coordinator.getProgress(pr().id, signal()), null);
	});
	it("cancelled or superseded receipt persistence rolls back and cannot publish a screen", async (t) => {
		const { coordinator, state, ports } = harness(t);
		await coordinator.connect({ repository: repo });
		await ready(coordinator);
		await tick();
		const navigation = await coordinator.navigate(pr().id, {}, signal());
		const writing = deferred<void>();
		let started = false;
		let calls = 0;
		ports.saveCache = async (cache) => {
			calls++;
			if (calls === 1) {
				started = true;
				await writing.promise;
			}
			state.cache = structuredClone(cache);
		};
		const controller = new AbortController();
		const applied = coordinator.actionApplied(
			receipt(shown(navigation)),
			navigation,
			controller.signal
		);
		const rejected = assert.rejects(applied);
		await until(() => started);
		controller.abort();
		writing.resolve();
		await rejected;
		assert.equal(state.cache.progress.length, 0);
		assert.equal(await coordinator.getProgress(pr().id, signal()), null);
		assert.deepEqual(await coordinator.getScreen("session"), {
			sequence: 0,
			mode: "conversation",
			prId: null,
		});
		assert.equal(calls, 2);
	});
});
