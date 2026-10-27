import assert from "node:assert/strict";
import { it } from "node:test";
import type {
	AgentAction,
	AppConfiguration,
	ConversationActionReceipt,
	ConversationTurnInput,
	PollTurnResult,
	PullRequest,
} from "../../shared/contracts";
import { createPreparedApi } from "../prepared/api";
import { createPreparedController } from "../prepared/controller";
import type { ConversationApi } from "./api";
import { createConversationController } from "./controller";

const config: AppConfiguration = {
	envPath: "/test/.env",
	configured: { meta: true, elevenlabs: true, github: false },
	voiceId: "voice",
	microphone: "granted",
};
const pr: PullRequest = {
	id: "owner/project#12",
	repository: "owner/project",
	number: 12,
	title: "A real API result",
	url: "https://github.com/owner/project/pull/12",
	author: "owner",
	baseSha: "a".repeat(40),
	headSha: "b".repeat(40),
};
function harness(overrides: Partial<ConversationApi> = {}) {
	const starts: ConversationTurnInput[] = [];
	const cancels: unknown[] = [];
	let prepares = 0;
	const api: ConversationApi = {
		call: async () => undefined,
		start: async (input) => {
			starts.push(input);
			return {
				sessionId: input.sessionId,
				turnId: input.turnId,
				generation: input.generation,
				status: "running",
			};
		},
		poll: async (input) => ({
			sessionId: input.sessionId,
			turnId: input.turnId,
			generation: input.generation,
			status: "completed",
			sequence: 1,
			events: [
				{
					sessionId: input.sessionId,
					turnId: input.turnId,
					generation: input.generation,
					sequence: 1,
					kind: "completed",
				},
			],
			text: "Actual API response",
			actions: [],
		}),
		cancel: async (input) => {
			cancels.push(input);
			return {
				sessionId: input.sessionId,
				turnId: input.turnId,
				generation: input.generation,
				requestId: input.requestId,
				status: "cancelled",
			};
		},
		release: async () => {},
		config: async () => config,
		reloadConfig: async () => config,
		openEnv: async () => {},
		requestMicrophone: async () => "granted",
		voiceStatus: async () => ({ phase: "stopped", voiceId: "voice", missing: [] }),
		prepareVoice: async () => {
			prepares++;
			return { phase: "ready", voiceId: "voice", missing: [] };
		},
		githubAccount: async () => ({ login: "owner", avatar_url: "https://github.com/owner.png" }),
		githubSignIn: async () => ({ login: "owner", avatar_url: "https://github.com/owner.png" }),
		reviewRequests: async () => [pr],
		prContext: async () => ({ pr, description: "PR description", files: [], truncated: false }),
		...overrides,
	};
	let count = 0;
	return {
		api,
		starts,
		cancels,
		prepares: () => prepares,
		controller: createConversationController(api, { id: () => `test-${++count}`, pollInterval: 0 }),
	};
}
it("starts empty and talks without a PR or screen; adds only selected GitHub context", async () => {
	const h = harness();
	try {
		assert.deepEqual(h.controller.store.getState().exchanges, []);
		assert.deepEqual(h.controller.store.getState().prs, []);
		await h.controller.submit("Hello");
		assert.equal(h.starts.length, 1);
		assert.equal("prId" in (h.starts[0] ?? {}), false);
		assert.equal("screenContext" in (h.starts[0] ?? {}), false);
		assert.equal(h.controller.store.getState().exchanges[0]?.answer, "Actual API response");
		await h.controller.refreshGitHub();
		await h.controller.selectPR(pr);
		await h.controller.submit("Explain this change");
		assert.equal(h.starts[1]?.prId, pr.id);
		assert.equal(h.starts[0]?.sessionId, h.starts[1]?.sessionId);
		assert.ok(Number(h.starts[1]?.generation) > Number(h.starts[0]?.generation));
	} finally {
		h.controller.dispose();
	}
});
it("auto prepares configured voice and release during microphone permission cannot start capture", async () => {
	let grant: (value: "granted") => void = () => {};
	const h = harness({
		config: async () => ({ ...config, microphone: "not-determined" }),
		requestMicrophone: () =>
			new Promise((resolve) => {
				grant = resolve;
			}),
	});
	let captures = 0;
	h.controller.attachVoice({
		beginCapture: () => {
			captures++;
		},
		endCapture() {},
		interrupt() {},
		dispose() {},
	});
	try {
		await h.controller.configure();
		assert.equal(h.prepares(), 1);
		h.controller.press();
		h.controller.release();
		grant("granted");
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(captures, 0);
		assert.equal(h.controller.store.getState().config?.microphone, "granted");
		h.controller.press();
		assert.equal(captures, 1);
	} finally {
		h.controller.dispose();
	}
});
it("one shared voice identity displays transcript without starting another typed turn", async () => {
	const h = harness();
	try {
		const turn = h.controller.allocateIdentity();
		assert.equal(h.controller.beginVoice(turn), true);
		h.controller.transcript(turn, "Spoken question");
		h.controller.answer(turn, "Spoken response");
		assert.equal(h.starts.length, 0);
		h.controller.finishVoice(turn, "complete");
		await h.controller.submit("Typed follow-up");
		h.controller.answer(turn, "Late output");
		assert.equal(h.controller.store.getState().exchanges[0]?.answer, "Spoken response");
		assert.equal(h.starts[0]?.sessionId, turn.sessionId);
		assert.ok(Number(h.starts[0]?.generation) > turn.generation);
		assert.equal(h.controller.beginVoice(turn), false);
	} finally {
		h.controller.dispose();
	}
});
it("cancels main work and ignores a late response after stop", async () => {
	let finish: (value: PollTurnResult) => void = () => {};
	const h = harness({
		poll: () =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	});
	try {
		const work = h.controller.submit("Question");
		for (let i = 0; i < 8; i++) await Promise.resolve();
		const turn = h.starts[0];
		assert.ok(turn);
		h.controller.stop();
		finish({
			sessionId: turn.sessionId,
			turnId: turn.turnId,
			generation: turn.generation,
			status: "completed",
			sequence: 1,
			events: [],
			actions: [],
			text: "Late response",
		});
		await work;
		assert.equal(h.cancels.length, 1);
		assert.equal(h.controller.store.getState().exchanges[0]?.answer, "");
		assert.equal(h.controller.store.getState().exchanges[0]?.phase, "cancelled");
	} finally {
		h.controller.dispose();
	}
});
it("does not synthesize fallback replies or PRs after API failures", async () => {
	const h = harness({
		start: async () => {
			throw new Error("private upstream detail");
		},
		reviewRequests: async () => {
			throw new Error("offline");
		},
	});
	try {
		await h.controller.submit("Hello");
		await h.controller.refreshGitHub();
		assert.equal(h.controller.store.getState().exchanges[0]?.answer, "");
		assert.deepEqual(h.controller.store.getState().prs, []);
		assert.ok(h.controller.store.getState().error);
		assert.equal(h.controller.store.getState().error.includes("private"), false);
	} finally {
		h.controller.dispose();
	}
});

it("changing optional PR context does not interrupt an ongoing voice turn", async () => {
	const h = harness();
	let interrupts = 0;
	h.controller.attachVoice({
		beginCapture() {},
		endCapture() {},
		interrupt: () => {
			interrupts++;
		},
		dispose() {},
	});
	try {
		const turn = h.controller.allocateIdentity();
		h.controller.beginVoice(turn);
		await h.controller.selectPR(pr);
		assert.equal(interrupts, 0);
		assert.deepEqual(h.controller.store.getState().active, turn);
		h.controller.transcript(turn, "Still speaking");
		assert.equal(h.controller.store.getState().exchanges[0]?.question, "Still speaking");
	} finally {
		h.controller.dispose();
	}
});

it("keeps the known env path and Open configuration available after malformed reload", async () => {
	let opens = 0;
	const h = harness({
		reloadConfig: async () => {
			throw new Error("malformed private file");
		},
		openEnv: async () => {
			opens++;
		},
	});
	try {
		await h.controller.configure();
		await h.controller.configure(true);
		assert.equal(h.controller.store.getState().envPath, config.envPath);
		assert.equal(h.controller.store.getState().config, null);
		assert.equal(h.controller.store.getState().voice, null);
		assert.ok(h.controller.store.getState().error.includes("Open"));
		await h.controller.openEnv();
		assert.equal(opens, 1);
	} finally {
		h.controller.dispose();
	}
});

it("shows authoritative configuration repair errors without attempting voice setup", async () => {
	const repair = {
		...config,
		configured: { meta: false, elevenlabs: false, github: false },
		voiceId: null,
		error: "Repair the local configuration file, then reload.",
	};
	const h = harness({ config: async () => repair });
	try {
		await h.controller.configure();
		assert.equal(h.controller.store.getState().error, repair.error);
		assert.equal(h.controller.store.getState().config?.envPath, repair.envPath);
		assert.equal(h.controller.store.getState().configBusy, false);
		assert.equal(h.prepares(), 0);
	} finally {
		h.controller.dispose();
	}
});

it("typed guided review waits for real source/progress/receipt and ignores retired turn navigation", async () => {
	const receipts: ConversationActionReceipt[] = [];
	const reviewId = "prepared-review";
	const plan = {
		id: reviewId,
		version: 1,
		pr,
		createdAt: "2026-10-27T22:00:00Z",
		summary: "Prepared summary",
		orderRationale: "Entry point then helper",
		files: ["entry.ts", "helper.ts"].map((path) => ({
			path,
			reason: "Prepared reason",
			summary: "Inferred summary",
			suggestedComments: [],
		})),
		coverage: "complete",
		evidence: "inferred-from-github",
	};
	let effect: AgentAction | undefined;
	const h = harness({
		poll: async (input) => {
			const identity = {
				sessionId: input.sessionId,
				turnId: input.turnId,
				generation: input.generation,
			};
			if (input.afterSequence === 0) {
				effect = {
					...identity,
					requestId: "next-file",
					screenSequence: h.starts[0]?.screen?.sequence ?? 0,
					kind: "review-navigation",
					navigation: {
						prId: pr.id,
						reviewId,
						baseSha: pr.baseSha,
						headSha: pr.headSha,
						path: "helper.ts",
						paused: false,
					},
				};
				return {
					...identity,
					status: "running",
					sequence: 1,
					text: "",
					actions: [effect],
					events: [{ ...identity, kind: "action", sequence: 1, action: effect }],
				};
			}
			assert.equal(receipts[0]?.status, "applied");
			assert.equal(receipts[0]?.screen.path, "helper.ts");
			return {
				...identity,
				status: "completed",
				sequence: 3,
				text: "Here is the helper.",
				actions: effect ? [effect] : [],
				events: [
					{ ...identity, sequence: 2, kind: "text-delta", delta: "Here is the helper." },
					{ ...identity, sequence: 3, kind: "completed" },
				],
			};
		},
	});
	const reviews = createPreparedController(
		createPreparedApi(async (_type, path, raw) => {
			const input = raw as Record<string, unknown>;
			if (path === "reviews.get") return { pr, status: "ready", prepared: plan, progress: null };
			if (path === "reviews.screen") return input["screen"];
			if (path === "reviews.file")
				return {
					prId: pr.id,
					path: input["path"],
					status: "modified",
					patch: null,
					base: {
						path: input["path"],
						commitSha: pr.baseSha,
						status: "available",
						content: "before",
					},
					head: {
						path: input["path"],
						commitSha: pr.headSha,
						status: "available",
						content: "after",
					},
				};
			if (path === "reviews.progress")
				return {
					...input,
					baseSha: pr.baseSha,
					headSha: pr.headSha,
					visited: [input["path"]],
					updatedAt: "2026-10-27T22:00:01Z",
				};
			if (path === "conversation.actionApplied") {
				receipts.push(raw as ConversationActionReceipt);
				return { status: "accepted" };
			}
			throw new Error("Unexpected route");
		}),
		h.controller.sessionId
	);
	h.controller.attachReview(reviews);
	try {
		await reviews.open(pr.id);
		await h.controller.submit("Next file, please");
		assert.equal(h.starts[0]?.screen?.reviewId, reviewId);
		assert.equal(reviews.store.getState().file?.path, "helper.ts");
		assert.equal(h.controller.store.getState().exchanges[0]?.answer, "Here is the helper.");
		assert.ok(effect);
		const before = reviews.store.getState().screen;
		assert.equal(
			await h.controller.applyConversationAction({ ...effect, requestId: "late-effect" }),
			"ignored"
		);
		assert.equal(reviews.store.getState().screen, before);
	} finally {
		h.controller.dispose();
		reviews.dispose();
	}
});
