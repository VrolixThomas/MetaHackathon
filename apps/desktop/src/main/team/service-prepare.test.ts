import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { digest } from "../../../../../services/team/protocol";
import type { ConversationPRContext, PreparedReview } from "../../shared/contracts";
import { LocalReviewSubmissionSchema, ReviewKeySchema } from "../../shared/contracts/team";
import { TeamService } from "./service";
import { EncryptedTeamStore } from "./storage";

const userId = "00000000-0000-4000-8000-000000000001";
const orgId = "10000000-0000-4000-8000-000000000001";
const settings = {
	url: "https://auth.example",
	publishableKey: "sb_publishable_controlled",
	serviceUrl: "https://team.example/functions/api",
};
// Controlled encryption only; no OS encryption or native-app claim.
const encryption = {
	isEncryptionAvailable: () => true,
	encryptString: (text: string) => Buffer.from(text),
	decryptString: (bytes: Buffer) => bytes.toString(),
};
const context: ConversationPRContext = {
	pr: {
		id: "test/repo#1",
		repository: "test/repo",
		number: 1,
		url: "https://github.com/test/repo/pull/1",
		title: "Controlled PR",
		author: "test",
		baseSha: "a".repeat(40),
		headSha: "b".repeat(40),
	},
	description: "Bounded source context",
	files: [],
	truncated: false,
};
const localReview: PreparedReview = {
	id: "controlled-local-review",
	version: 1,
	pr: context.pr,
	createdAt: "2026-11-01T00:00:00Z",
	summary: "Own local inferred report",
	orderRationale: "Read source",
	files: [],
	coverage: "complete",
	evidence: "inferred-from-github",
};
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
type Handler = (
	path: string,
	body: unknown,
	signal: AbortSignal
) => Response | Promise<Response> | undefined;
async function harness(
	options: {
		configured?: boolean;
		connected?: boolean;
		selected?: boolean;
		handler?: Handler;
		getSettings?: () => Promise<typeof settings>;
		getGitHubToken?: () => Promise<string | undefined>;
	} = {}
) {
	const directory = await mkdtemp(join(tmpdir(), "muse-local-review-"));
	const data = join(directory, "team", digest(settings).slice(0, 24));
	const scope = { orgId, repositoryId: "42", repository: "test/repo", analysisVersion: "old-v1" };
	if (options.connected !== false)
		await new EncryptedTeamStore(join(data, "session.bin"), encryption).write({
			access_token: "controlled-user",
			refresh_token: "controlled-refresh",
			expires_at: 2000000000,
			user: { id: userId },
		});
	if (options.selected !== false)
		await new EncryptedTeamStore(join(data, "scopes.bin"), encryption).write({
			users: { [userId]: { scopes: [scope] } },
		});
	const requests: string[] = [];
	let revision = 0;
	const service = new TeamService({
		directory,
		encryption,
		getSettings: options.getSettings ?? (() => (options.configured === false ? {} : settings)),
		getGitHubToken: options.getGitHubToken ?? (async () => "controlled-github"),
		getAccountRevision: () => revision,
		openExternal: async () => assert.fail("No browser login in a unit probe"),
		fetch: (async (raw, init) => {
			const url = new URL(String(raw));
			assert.ok(url.pathname.startsWith("/functions/api/v1/"));
			const path = url.pathname.slice("/functions/api/v1/".length);
			assert.ok(!["reviews/request", "reviews/status", "reviews/retry"].includes(path));
			requests.push(path);
			const body: unknown = JSON.parse(String(init?.body));
			assert.ok(init?.signal);
			const handled = await options.handler?.(path, body, init.signal);
			if (handled) return handled;
			if (path === "organizations")
				return Response.json({
					analysisVersion: "current-v2",
					items: [{ id: orgId, name: "Controlled org" }],
				});
			if (path === "reviews/read") return Response.json(null);
			if (path === "reviews/publish") {
				const input = LocalReviewSubmissionSchema.parse(body);
				return Response.json({
					key: input.key,
					review: input.review,
					digest: input.digest,
					provenance: "reported-local-analysis",
					preparedBy: userId,
				});
			}
			assert.fail(`Unexpected request ${path}`);
		}) as typeof fetch,
	});
	return {
		service,
		requests,
		changeAccount: () => {
			revision++;
		},
		cache: new EncryptedTeamStore(join(data, "cache.bin"), encryption),
		close: async () => {
			service.dispose();
			await rm(directory, { recursive: true, force: true });
		},
	};
}

for (const mode of [
	"no-team",
	"disconnected",
	"no-scope",
	"offline",
	"denied",
	"no-github",
] as const) {
	test(`local preparation succeeds exactly once with ${mode} sharing`, async () => {
		const h = await harness({
			configured: mode !== "no-team",
			connected: mode !== "disconnected",
			selected: mode !== "no-scope",
			getGitHubToken: mode === "no-github" ? async () => undefined : undefined,
			handler: (path) => {
				if (mode === "offline") throw new Error("Controlled offline");
				if (mode === "denied" && path === "reviews/read")
					return new Response(null, { status: 403 });
			},
		});
		try {
			let called = 0;
			const signal = new AbortController().signal;
			const result = await h.service.prepare(context, signal, async (active) => {
				assert.equal(active, signal);
				called++;
				return localReview;
			});
			assert.deepEqual(result, localReview);
			assert.equal(called, 1);
			assert.equal(h.requests.includes("reviews/publish"), false);
			if (["no-team", "disconnected", "no-scope", "no-github"].includes(mode))
				assert.equal(h.requests.length, 0);
		} finally {
			await h.close();
		}
	});
}

test("fresh exact shared findings reuse current server analysis version without local or publication calls", async () => {
	const h = await harness({
		handler: (path, body) => {
			if (path !== "reviews/read") return;
			const key = ReviewKeySchema.parse((body as { key: unknown }).key);
			assert.equal(key.analysisVersion, "current-v2");
			assert.equal(key.contextDigest, digest(context));
			const review = { ...localReview, summary: "Canonical reported inference" };
			return Response.json({
				key,
				review,
				digest: digest({ key, review }),
				provenance: "reported-local-analysis",
				preparedBy: userId,
			});
		},
	});
	try {
		const result = await h.service.prepare(context, new AbortController().signal, async () =>
			assert.fail("Fresh shared result should be reused")
		);
		assert.equal(result.summary, "Canonical reported inference");
		assert.deepEqual(h.requests, ["organizations", "reviews/read"]);
	} finally {
		await h.close();
	}
});

test("local miss publishes only the exact inferred report and returns own report if another publisher wins", async () => {
	const h = await harness({
		handler: (path, body) => {
			if (path !== "reviews/publish") return;
			const input = LocalReviewSubmissionSchema.parse(body);
			assert.deepEqual(Object.keys(input).sort(), ["digest", "key", "requestId", "review"]);
			assert.deepEqual(input.review, localReview);
			assert.equal(input.key.contextDigest, digest(context));
			assert.equal(input.digest, digest({ key: input.key, review: localReview }));
			const review = {
				...localReview,
				id: "other-local-analysis",
				summary: "Other first canonical report",
			};
			return Response.json({
				key: input.key,
				review,
				digest: digest({ key: input.key, review }),
				provenance: "reported-local-analysis",
				preparedBy: orgId,
			});
		},
	});
	try {
		let calls = 0;
		assert.deepEqual(
			await h.service.prepare(context, new AbortController().signal, async () => {
				calls++;
				return localReview;
			}),
			localReview
		);
		assert.equal(calls, 1);
		assert.deepEqual(h.requests, ["organizations", "reviews/read", "reviews/publish"]);
	} finally {
		await h.close();
	}
});

test("publication failure retains the local report without re-running local analysis", async () => {
	const h = await harness({
		handler: (path) =>
			path === "reviews/publish" ? new Response(null, { status: 503 }) : undefined,
	});
	try {
		let calls = 0;
		assert.deepEqual(
			await h.service.prepare(context, new AbortController().signal, async () => {
				calls++;
				return localReview;
			}),
			localReview
		);
		assert.equal(calls, 1);
		assert.equal(h.requests.filter((p) => p === "reviews/publish").length, 1);
	} finally {
		await h.close();
	}
});

test("offline cached shared findings are not fresh reuse authority", async () => {
	let offline = false;
	const h = await harness({
		handler: (path, body) => {
			if (path !== "reviews/read") return;
			if (offline) throw new Error("Controlled read offline");
			const key = ReviewKeySchema.parse((body as { key: unknown }).key);
			const review = { ...localReview, summary: "Old cached shared inference" };
			return Response.json({ key, review, digest: digest({ key, review }) });
		},
	});
	try {
		assert.equal(
			(await h.service.prepare(context, new AbortController().signal)).summary,
			"Old cached shared inference"
		);
		offline = true;
		let calls = 0;
		assert.deepEqual(
			await h.service.prepare(context, new AbortController().signal, async () => {
				calls++;
				return localReview;
			}),
			localReview
		);
		assert.equal(calls, 1);
	} finally {
		await h.close();
	}
});

test("a shared finding for the wrong source is discarded before local preparation", async () => {
	const h = await harness({
		handler: (path, body) => {
			if (path !== "reviews/read") return;
			const key = ReviewKeySchema.parse((body as { key: unknown }).key);
			const review = {
				...localReview,
				pr: { ...context.pr, repository: "other/repo", id: "other/repo#1" },
			};
			return Response.json({ key, review, digest: digest({ key, review }) });
		},
	});
	try {
		let calls = 0;
		assert.deepEqual(
			await h.service.prepare(context, new AbortController().signal, async () => {
				calls++;
				return localReview;
			}),
			localReview
		);
		assert.equal(calls, 1);
		assert.equal(h.requests.includes("reviews/publish"), false);
	} finally {
		await h.close();
	}
});

for (const stage of [
	"settings",
	"lookup-fetch",
	"lookup-body",
	"publish-fetch",
	"publish-body",
] as const) {
	test(
		`${stage} cannot hold local preparation beyond its four-second sharing budget`,
		{ timeout: 8000 },
		async () => {
			const late = deferred<Response>();
			const settingsGate = deferred<typeof settings>();
			let cloudSignal: AbortSignal | undefined;
			const h = await harness({
				getSettings: stage === "settings" ? () => settingsGate.promise : undefined,
				handler: (path, _body, signal) => {
					if (
						(stage.startsWith("lookup") && path === "reviews/read") ||
						(stage.startsWith("publish") && path === "reviews/publish")
					) {
						cloudSignal = signal;
						if (stage.endsWith("fetch")) return late.promise;
						return new Response(
							new ReadableStream({
								pull: () => new Promise(() => {}),
								cancel: () => new Promise(() => {}),
							})
						);
					}
				},
			});
			try {
				let calls = 0;
				const start = Date.now();
				const result = await h.service.prepare(context, new AbortController().signal, async () => {
					calls++;
					return localReview;
				});
				assert.ok(Date.now() - start < 5500);
				assert.deepEqual(result, localReview);
				assert.equal(calls, 1);
				if (cloudSignal) assert.equal(cloudSignal.aborted, true);
				late.resolve(Response.json(null));
				settingsGate.resolve(settings);
				await new Promise<void>((resolve) => setImmediate(resolve));
				if (!stage.startsWith("publish"))
					assert.equal(h.requests.includes("reviews/publish"), false);
				assert.equal(await h.cache.read(), null);
			} finally {
				await h.close();
			}
		}
	);
}

for (const stage of ["lookup", "local", "publish"] as const) {
	test(`foreground cancellation during ${stage} rejects and suppresses late continuation`, async () => {
		const entered = deferred<void>();
		const lateResponse = deferred<Response>();
		const lateLocal = deferred<PreparedReview>();
		const controller = new AbortController();
		const h = await harness({
			handler: (path) => {
				if (
					(stage === "lookup" && path === "reviews/read") ||
					(stage === "publish" && path === "reviews/publish")
				) {
					entered.resolve();
					return lateResponse.promise;
				}
			},
		});
		try {
			let calls = 0;
			const pending = h.service.prepare(context, controller.signal, async () => {
				calls++;
				if (stage === "local") {
					entered.resolve();
					return lateLocal.promise;
				}
				return localReview;
			});
			await entered.promise;
			controller.abort();
			await assert.rejects(pending, { name: "AbortError" });
			const before = [...h.requests];
			lateResponse.resolve(Response.json(null));
			lateLocal.resolve(localReview);
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.deepEqual(h.requests, before);
			assert.equal(calls, stage === "lookup" ? 0 : 1);
			assert.equal(await h.cache.read(), null);
			assert.equal(h.requests.includes("reviews/publish"), stage === "publish");
		} finally {
			await h.close();
		}
	});
}

test("account changes during local analysis retain own report but fence sharing", async () => {
	const h = await harness();
	try {
		const result = await h.service.prepare(context, new AbortController().signal, async () => {
			h.changeAccount();
			return localReview;
		});
		assert.deepEqual(result, localReview);
		assert.equal(h.requests.includes("reviews/publish"), false);
	} finally {
		await h.close();
	}
});

test("changed account cannot reuse a pending previous-account shared result", async () => {
	const entered = deferred<void>();
	const late = deferred<Response>();
	let reviewKey: unknown;
	const h = await harness({
		handler: (path, body) => {
			if (path === "reviews/read") {
				reviewKey = (body as { key: unknown }).key;
				entered.resolve();
				return late.promise;
			}
		},
	});
	try {
		let calls = 0;
		const pending = h.service.prepare(context, new AbortController().signal, async () => {
			calls++;
			return localReview;
		});
		await entered.promise;
		h.changeAccount();
		const review = { ...localReview, summary: "Old account finding" };
		late.resolve(
			Response.json({ key: reviewKey, review, digest: digest({ key: reviewKey, review }) })
		);
		assert.deepEqual(await pending, localReview);
		assert.equal(calls, 1);
		assert.equal(h.requests.includes("reviews/publish"), false);
		assert.equal(await h.cache.read(), null);
	} finally {
		await h.close();
	}
});

test("invalid context and local source errors are not sharing failures and never publish", async () => {
	let settingsCalls = 0;
	const h = await harness({
		getSettings: async () => {
			settingsCalls++;
			return settings;
		},
	});
	try {
		await assert.rejects(
			h.service.prepare(
				{ ...context, privateHistory: "not approved context" } as ConversationPRContext,
				new AbortController().signal,
				async () => assert.fail("No local call for invalid context")
			)
		);
		assert.equal(settingsCalls, 0);
		const sourceError = new Error("Controlled source read failed");
		await assert.rejects(
			h.service.prepare(context, new AbortController().signal, async () => {
				throw sourceError;
			}),
			(error) => error === sourceError
		);
		await assert.rejects(
			h.service.prepare(context, new AbortController().signal, async () => ({
				...localReview,
				pr: { ...context.pr, headSha: "c".repeat(40) },
			})),
			/invalid/
		);
		assert.equal(h.requests.includes("reviews/publish"), false);
	} finally {
		await h.close();
	}
});

test("legacy retry validates and cancels without any cloud request or queued work", async () => {
	const h = await harness();
	try {
		await h.service.retryPreparation(context, randomUUID(), new AbortController().signal);
		assert.equal(h.requests.length, 0);
		await assert.rejects(
			h.service.retryPreparation(context, "invalid", new AbortController().signal)
		);
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(h.service.retryPreparation(context, randomUUID(), controller.signal), {
			name: "AbortError",
		});
		await assert.rejects(
			h.service.prepare(context, controller.signal, async () =>
				assert.fail("Pre-cancelled preparation")
			),
			{ name: "AbortError" }
		);
		assert.equal(h.requests.length, 0);
	} finally {
		await h.close();
	}
});
