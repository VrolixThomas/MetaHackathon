import assert from "node:assert/strict";
import { type TestContext, describe, it } from "node:test";
import {
	type AgentAction,
	AgentActionSchema,
	type LocalBrowserState,
	type PreparedReview,
	type ReviewInbox,
	type ReviewNavigation,
	type ReviewScreen,
	type WorkspaceActionReceipt,
	type WorkspaceBrowserObservation,
	type WorkspaceCommand,
	WorkspaceObservationSchema,
} from "../../shared/contracts";
import {
	type SavedWorkspaceCanvases,
	SavedWorkspaceCanvasesSchema,
	WorkspaceCoordinator,
	type WorkspaceCoordinatorPorts,
	validateReviewNavigation,
} from "./workspace";

type Action = Extract<AgentAction, { kind: "workspace-canvas" }>;
const clone = <T>(value: T): T => structuredClone(value);
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const signal = () => new AbortController().signal;
const turn = (requestId = "effect", sessionId = "session") => ({
	sessionId,
	turnId: "turn",
	generation: 1,
	requestId,
});
const document = (
	markdown = "Draft explanation"
): Extract<WorkspaceCommand, { kind: "write-document" }> => ({
	kind: "write-document",
	title: "Notes",
	markdown,
});
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((done, failed) => {
		resolve = done;
		reject = failed;
	});
	return { promise, resolve, reject };
}
async function until(check: () => boolean) {
	for (let count = 0; count < 100; count++) {
		if (check()) return;
		await tick();
	}
	assert.fail("Injected work did not reach the expected state");
}
const prepared = (): PreparedReview => ({
	id: "prepared-review",
	version: 1,
	pr: {
		id: "example/project#1",
		repository: "example/project",
		number: 1,
		title: "Real pinned change",
		author: "reviewer",
		url: "https://github.com/example/project/pull/1",
		baseSha: "a".repeat(40),
		headSha: "b".repeat(40),
	},
	createdAt: "2026-10-28T09:00:00Z",
	summary: "Inferred summary",
	orderRationale: "Read the boundary first",
	files: ["src/first.ts", "src/second.ts"].map((path) => ({
		path,
		summary: "Changed behavior",
		reason: "Understand the boundary",
		suggestedComments: [],
	})),
	coverage: "complete",
	evidence: "inferred-from-github",
});
const browserState = (url = "https://example.com/"): LocalBrowserState => ({
	url,
	title: "Actual page",
	viewport: { width: 1024, height: 768 },
	canGoBack: false,
	canGoForward: false,
	provenance: "website-unverified-revision",
});
function harness(t: TestContext, overrides: Partial<WorkspaceCoordinatorPorts> = {}) {
	const state = {
		screens: new Map<string, ReviewScreen>(),
		review: prepared(),
		ready: true,
		page: null as LocalBrowserState | null,
		presented: false,
		browserSequence: 1,
		documentId: "actual-document",
		openCalls: [] as string[],
		browserCalls: [] as unknown[],
		navigations: [] as ReviewNavigation[],
		saved: { version: 1, canvases: [] } as SavedWorkspaceCanvases,
		saves: [] as SavedWorkspaceCanvases[],
	};
	const observation = (): WorkspaceBrowserObservation | null =>
		state.page
			? {
					browserId: "native-browser",
					documentId: state.documentId,
					sequence: state.browserSequence,
					observedAt: "2026-10-28T09:00:00Z",
					url: state.page.url,
					title: state.page.title,
					viewport: state.page.viewport,
					text: "Untrusted website text",
					elements: [
						{
							id: "actual-document:button",
							role: "button",
							name: "Continue",
							tag: "button",
							bounds: { x: 20, y: 20, width: 100, height: 40 },
							visible: true,
							enabled: true,
						},
					],
					scroll: { x: 0, y: 0 },
					presented: state.presented,
					truncated: false,
					provenance: "website-unverified-revision",
				}
			: null;
	const ports: WorkspaceCoordinatorPorts = {
		getReviews: () => ({
			getScreen: async (sessionId) =>
				clone(state.screens.get(sessionId) ?? { sequence: 0, mode: "conversation", prId: null }),
			inbox: async (): Promise<ReviewInbox> => ({
				repository: "example/project",
				localPath: null,
				items: [
					{
						pr: state.review.pr,
						status: state.ready ? "ready" : "preparing",
						prepared: state.ready ? state.review : null,
						progress: null,
					},
				],
				refreshing: false,
				lastRefreshedAt: null,
			}),
			getReady: async (prId) => {
				assert.equal(prId, state.review.pr.id);
				if (!state.ready) throw new Error("Not ready");
				return clone(state.review);
			},
			navigate: async (prId, command) => {
				const navigation: ReviewNavigation = {
					prId,
					reviewId: state.review.id,
					baseSha: state.review.pr.baseSha,
					headSha: state.review.pr.headSha,
					path: command.path ?? (command.direction === "next" ? "src/second.ts" : "src/first.ts"),
					paused: command.direction === "pause",
				};
				state.navigations.push(clone(navigation));
				return navigation;
			},
		}),
		getBrowser: () => ({
			open: async (url) => {
				state.openCalls.push(url);
				state.presented = false;
				state.page = browserState(url);
				return clone(state.page);
			},
			observe: async () => clone(observation()),
			state: async () => clone(state.page),
			execute: async (command) => {
				assert.equal(state.presented, true);
				state.browserCalls.push(clone(command));
				state.browserSequence++;
				const result = observation();
				assert.ok(result);
				return result;
			},
		}),
		loadCanvases: async () => clone(state.saved),
		saveCanvases: async (saved) => {
			state.saves.push(clone(saved));
			state.saved = clone(saved);
		},
		...overrides,
	};
	const coordinator = new WorkspaceCoordinator(ports);
	t.after(() => coordinator.dispose());
	const prepare = async (
		command: WorkspaceCommand,
		requestId = "manual-effect",
		sessionId = "session"
	) => {
		const { workspace } = await coordinator.observe(sessionId);
		return coordinator.prepare({
			sessionId,
			requestId,
			expectedSequence: workspace.sequence,
			command,
		});
	};
	const apply = async (action: Action, reviewSequence?: number) => {
		const receipt = received(action);
		if (action.effect.navigation) {
			receipt.workspace.review.sequence = reviewSequence ?? receipt.workspace.review.sequence;
			state.screens.set(action.sessionId, clone(receipt.workspace.review));
		}
		state.presented = receipt.workspace.canvases.some(
			({ kind, id }) =>
				kind === "browser" &&
				(id === receipt.workspace.primaryId || id === receipt.workspace.secondaryId)
		);
		return coordinator.applied(receipt);
	};
	return { state, ports, coordinator, prepare, apply };
}
function received(action: Action): WorkspaceActionReceipt {
	return {
		sessionId: action.sessionId,
		turnId: action.turnId,
		generation: action.generation,
		requestId: action.requestId,
		status: "applied",
		workspace: clone(action.effect.snapshot),
	};
}

describe("WorkspaceCoordinator", () => {
	it("accepts only the main-verified desktop viewport that settles after a canvas renders", async (t) => {
		const h = harness(t);
		const original = h.ports.getBrowser();
		h.ports.getBrowser = () => ({
			...original,
			open: async (url, signal) => {
				const page = await original.open(url, signal);
				page.viewportMode = "desktop";
				return page;
			},
		});
		const action = await h.prepare({ kind: "open-browser", url: "https://example.com/" });
		assert.ok(h.state.page);
		h.state.page.viewportMode = "desktop";
		h.state.page.viewport = { width: 1280, height: 900 };
		h.state.presented = true;
		const receipt = received(action);
		assert.ok(receipt.workspace.browser);
		receipt.workspace.browser.viewport = h.state.page.viewport;
		assert.deepEqual(await h.coordinator.applied(receipt), { status: "accepted" });
		const next = await h.prepare({ kind: "code-view", view: "head" }, "forged-size");
		const forged = received(next);
		assert.ok(forged.workspace.browser);
		forged.workspace.browser.viewport = { width: 1100, height: 800 };
		await assert.rejects(h.coordinator.applied(forged), /actual displayed viewport/);
	});
	it("starts each UI session with one real review canvas and fresh bounded evidence", async (t) => {
		const { coordinator, state } = harness(t);
		const observed = await coordinator.observe("session");
		assert.deepEqual(observed.workspace, {
			sequence: 0,
			canvases: [{ id: "review", title: "Review", kind: "review", revision: 1 }],
			primaryId: "review",
			secondaryId: null,
			review: { sequence: 0, mode: "conversation", prId: null },
			codeView: "diff",
			browser: null,
		});
		assert.equal(observed.reviews[0]?.reviewId, state.review.id);
		assert.equal(observed.browser, null);
		assert.deepEqual(WorkspaceObservationSchema.parse(observed), observed);
		state.page = browserState();
		state.browserSequence = 17;
		const next = await coordinator.observe("other-session");
		assert.equal(next.browser?.sequence, 17);
		assert.equal(next.workspace.browser, null);
		assert.equal("headSha" in (next.browser ?? {}), false);
		assert.equal(state.openCalls.length, 0);
	});

	it("keeps manual draft candidates private until exact ack and durable save", async (t) => {
		const gate = deferred<void>();
		const h = harness(t, {
			saveCanvases: async (saved) => {
				h.state.saves.push(clone(saved));
				await gate.promise;
				h.state.saved = clone(saved);
			},
		});
		const action = await h.prepare(document());
		assert.equal(action.turnId, "manual-manual-effect");
		assert.equal(action.generation, 0);
		assert.equal(action.effect.expectedSequence, 0);
		assert.equal(action.effect.snapshot.sequence, 1);
		assert.deepEqual(AgentActionSchema.parse(action), action);
		assert.equal(h.state.saves.length, 0);
		assert.equal((await h.coordinator.observe("session")).workspace.canvases.length, 1);
		const applying = h.apply(action);
		await until(() => h.state.saves.length === 1);
		assert.equal((await h.coordinator.observe("session")).workspace.sequence, 0);
		gate.resolve();
		assert.deepEqual(await applying, { status: "accepted" });
		const visible = (await h.coordinator.observe("session")).workspace;
		assert.equal(visible.sequence, 1);
		const canvas = visible.canvases.find(({ kind }) => kind === "document");
		assert.ok(canvas && canvas.kind === "document");
		assert.match(canvas.id, /^[a-f0-9-]{36}$/);
		assert.equal(canvas.provenance, "agent-draft");
		assert.equal(canvas.markdown, "Draft explanation");
		assert.equal(canvas.revision, 1);
		assert.deepEqual(await h.apply(action), { status: "stale" });
	});

	it("emits one model effect and waits for its receipt before returning the observation", async (t) => {
		const h = harness(t);
		const effects: Action[] = [];
		let finished = false;
		const result = h.coordinator
			.execute(document(), turn(), signal(), (action) => {
				assert.equal(action.kind, "workspace-canvas");
				if (action.kind === "workspace-canvas") effects.push(action);
			})
			.then((value) => {
				finished = true;
				return value;
			});
		await until(() => effects.length === 1);
		assert.equal(finished, false);
		assert.equal((await h.coordinator.observe("session")).workspace.sequence, 0);
		const action = effects[0];
		assert.ok(action);
		await h.apply(action);
		assert.equal((await result).workspace.sequence, 1);
		assert.equal(effects.length, 1);
	});

	it("rejects foreign identity, forged contents, sequence changes and duplicate requests", async (t) => {
		const h = harness(t);
		const action = await h.prepare(document());
		for (const change of [
			{ sessionId: "foreign" },
			{ turnId: "foreign" },
			{ generation: 10 },
			{ requestId: "foreign" },
		])
			assert.deepEqual(await h.coordinator.applied({ ...received(action), ...change }), {
				status: "stale",
			});
		const forged = received(action);
		const draft = forged.workspace.canvases.find(({ kind }) => kind === "document");
		assert.ok(draft && draft.kind === "document");
		draft.markdown = "Unrequested content";
		assert.deepEqual(await h.coordinator.applied(forged), { status: "stale" });
		const advanced = received(action);
		advanced.workspace.review.sequence++;
		assert.deepEqual(await h.coordinator.applied(advanced), { status: "stale" });
		assert.equal((await h.coordinator.observe("session")).workspace.sequence, 0);
		await h.apply(action);
		await assert.rejects(h.prepare(document(), action.requestId), /already used/);
		assert.equal(h.state.saves.length, 1);
	});

	it("validates actual payloads and port results without leaking raw data", async (t) => {
		const h = harness(t);
		for (const command of [
			{ ...document(), markdown: "x".repeat(40001) },
			{ ...document(), id: "client-assigned-id" },
			{ kind: "open-browser", url: "https://user:secret@example.com" },
			{
				kind: "create-visual",
				title: "Invalid visual",
				visual: { width: 20, height: 20, elements: [] },
			},
			{ kind: "navigate-review", path: "../secret" },
		])
			await assert.rejects(h.prepare(command as WorkspaceCommand), /Invalid|unknown/);
		await assert.rejects(h.coordinator.applied({} as WorkspaceActionReceipt), /Invalid/);
		assert.equal(h.state.openCalls.length, 0);
		const bad = harness(t, {
			getBrowser: () => ({
				...h.ports.getBrowser(),
				observe: async () =>
					({ secret: "never reflect" }) as unknown as WorkspaceBrowserObservation,
			}),
		});
		await assert.rejects(
			bad.coordinator.observe("bad"),
			(error: Error) => !error.message.includes("never reflect")
		);
	});

	it("requires exact expected sequence on manual commands", async (t) => {
		const h = harness(t);
		await h.apply(await h.prepare(document()));
		await assert.rejects(
			h.coordinator.prepare({
				sessionId: "session",
				requestId: "old",
				expectedSequence: 0,
				command: { kind: "code-view", view: "head" },
			}),
			/sequence is stale/
		);
		assert.equal((await h.coordinator.observe("session")).workspace.codeView, "diff");
	});

	it("manual preparation stale-fences a pending model effect", async (t) => {
		const h = harness(t);
		const emitted = deferred<Action>();
		const running = h.coordinator.execute(
			document("Old model draft"),
			turn(),
			signal(),
			(action) => {
				if (action.kind === "workspace-canvas") emitted.resolve(action);
			}
		);
		const failure = assert.rejects(running, /manual change/);
		const old = await emitted.promise;
		const manual = await h.prepare(document("Manual draft"), "manual");
		await failure;
		assert.deepEqual(await h.apply(old), { status: "stale" });
		await h.apply(manual);
		const visible = (await h.coordinator.observe("session")).workspace;
		assert.equal(
			visible.canvases.some(
				(canvas) => canvas.kind === "document" && canvas.markdown === "Old model draft"
			),
			false
		);
	});

	it("ignored UI effects preserve canonical content and terminate the model wait", async (t) => {
		const h = harness(t);
		const base = (await h.coordinator.observe("session")).workspace;
		const emitted = deferred<Action>();
		const result = h.coordinator.execute(document(), turn(), signal(), (action) => {
			if (action.kind === "workspace-canvas") emitted.resolve(action);
		});
		const failure = assert.rejects(result, /ignored/);
		const action = await emitted.promise;
		assert.deepEqual(
			await h.coordinator.applied({ ...received(action), status: "ignored", workspace: base }),
			{ status: "accepted" }
		);
		await failure;
		assert.deepEqual((await h.coordinator.observe("session")).workspace, base);
		assert.equal(h.state.saves.length, 0);
	});

	it("ignored navigation merges only the actually shown review and no candidate draft", async (t) => {
		const h = harness(t);
		const action = await h.prepare(document());
		const actual: ReviewScreen = { sequence: 3, mode: "conversation", prId: h.state.review.pr.id };
		h.state.screens.set("session", actual);
		const ignored: WorkspaceActionReceipt = {
			...received(action),
			status: "ignored",
			workspace: { ...action.effect.snapshot, review: actual },
		};
		assert.deepEqual(await h.coordinator.applied(ignored), { status: "accepted" });
		const reconciled = await h.coordinator.observe("session");
		assert.deepEqual(reconciled.workspace.review, actual);
		assert.equal(reconciled.workspace.canvases.length, 1);
		assert.equal(reconciled.workspace.sequence, 1);
		assert.equal(h.state.saves.length, 0);
	});

	it("cancellation during noncooperating browser work cannot emit or publish late results", async (t) => {
		const gate = deferred<LocalBrowserState>();
		const h = harness(t, {
			getBrowser: () => ({ ...ordinary.ports.getBrowser(), open: async () => gate.promise }),
		});
		const ordinary = harness(t);
		const emitted: AgentAction[] = [];
		const abort = new AbortController();
		const result = h.coordinator.execute(
			{ kind: "open-browser", url: "https://example.com" },
			turn(),
			abort.signal,
			(action) => emitted.push(action)
		);
		const failure = assert.rejects(result, /cancelled/);
		await tick();
		abort.abort();
		await failure;
		gate.resolve(browserState());
		await tick();
		assert.equal(emitted.length, 0);
		assert.equal((await h.coordinator.observe("session")).workspace.sequence, 0);
	});

	it("cancel/release/dispose clear pending waits and reject late receipts", async (t) => {
		for (const end of ["cancel", "release", "dispose"] as const) {
			const h = harness(t);
			const emitted = deferred<Action>();
			const result = h.coordinator.execute(document(), turn(), signal(), (action) => {
				if (action.kind === "workspace-canvas") emitted.resolve(action);
			});
			const failure = assert.rejects(result, /cancelled|released/);
			const action = await emitted.promise;
			if (end === "cancel")
				h.coordinator.cancel({ sessionId: "session", turnId: "turn", generation: 1 });
			else if (end === "release") h.coordinator.release("session");
			else await h.coordinator.dispose();
			await failure;
			assert.deepEqual(await h.coordinator.applied(received(action)), { status: "stale" });
			assert.equal(h.state.saves.length, 0);
		}
	});

	it("cancellation while a session initializes fences its not-yet-prepared turn", async (t) => {
		const gate = deferred<SavedWorkspaceCanvases | null>();
		const h = harness(t, { loadCanvases: () => gate.promise });
		const result = h.coordinator.execute(document(), turn(), signal(), () =>
			assert.fail("cancelled turn emitted")
		);
		const failure = assert.rejects(result, /cancelled/);
		h.coordinator.cancel({ sessionId: "session", turnId: "turn", generation: 1 });
		gate.resolve(null);
		await failure;
	});

	it("storage failure does not publish and a later manual request can recover", async (t) => {
		let failWrite = true;
		const h = harness(t, {
			saveCanvases: async () => {
				if (failWrite) throw new Error("secret disk path");
			},
		});
		const action = await h.prepare(document());
		await assert.rejects(h.apply(action), (error: Error) => !error.message.includes("secret"));
		assert.equal((await h.coordinator.observe("session")).workspace.sequence, 0);
		assert.deepEqual(await h.apply(action), { status: "stale" });
		failWrite = false;
		await h.apply(await h.prepare(document("Recovered draft"), "retry"));
		assert.equal((await h.coordinator.observe("session")).workspace.sequence, 1);
	});

	it("late durable writes roll back behind a barrier before another action can commit", async (t) => {
		const gate = deferred<void>();
		let writes = 0;
		const h = harness(t, {
			saveCanvases: async (saved) => {
				writes++;
				if (writes === 1) await gate.promise;
				h.state.saved = clone(saved);
			},
		});
		const action = await h.prepare(document("Cancelled"));
		const applying = h.apply(action);
		const failure = assert.rejects(applying, /cancelled/);
		await until(() => writes === 1);
		h.coordinator.cancel({
			sessionId: action.sessionId,
			turnId: action.turnId,
			generation: action.generation,
		});
		await failure;
		const newer = await h.prepare(document("Latest"), "newer");
		const next = h.apply(newer);
		await tick();
		assert.equal(writes, 1);
		assert.equal((await h.coordinator.observe("session")).workspace.sequence, 0);
		gate.resolve();
		await next;
		assert.equal(writes, 3);
		assert.equal(h.state.saved.canvases.length, 1);
		assert.equal(
			h.state.saved.canvases[0]?.canvas.kind === "document" &&
				h.state.saved.canvases[0].canvas.markdown,
			"Latest"
		);
	});

	it("shutdown drains an admitted durable write and rollback before storage may close", async (t) => {
		const gate = deferred<void>();
		const h = harness(t, {
			saveCanvases: async (saved) => {
				h.state.saves.push(clone(saved));
				if (h.state.saves.length === 1) await gate.promise;
				h.state.saved = clone(saved);
			},
		});
		const action = await h.prepare(document());
		const applying = h.apply(action);
		const failure = assert.rejects(applying, /cancelled/);
		await until(() => h.state.saves.length === 1);
		let disposed = false;
		const disposal = h.coordinator.dispose().then(() => {
			disposed = true;
		});
		await failure;
		assert.equal(disposed, false);
		gate.resolve();
		await disposal;
		assert.equal(h.state.saves.length, 2);
		assert.equal(h.state.saved.canvases.length, 0);
		assert.deepEqual(await h.coordinator.applied(received(action)), { status: "stale" });
	});

	it("updates only known same-kind drafts with assigned revision and generated provenance", async (t) => {
		const h = harness(t);
		const first = await h.prepare(document());
		await h.apply(first);
		const id = first.effect.snapshot.primaryId;
		const update = await h.prepare({ ...document("Revised"), id }, "update");
		const canvas = update.effect.snapshot.canvases.find((canvas) => canvas.id === id);
		assert.equal(canvas?.revision, 2);
		await h.apply(update);
		await assert.rejects(
			h.prepare(
				{
					kind: "create-visual",
					id,
					title: "Wrong kind",
					visual: { width: 400, height: 200, background: "#ffffff", elements: [] },
				},
				"wrong"
			),
			/another canvas kind/
		);
		const visual = await h.prepare(
			{
				kind: "create-visual",
				title: "Mockup",
				visual: {
					width: 400,
					height: 200,
					background: "#ffffff",
					elements: [{ kind: "text", x: 10, y: 20, text: "Draft", fill: "#000000", fontSize: 16 }],
				},
				target: "secondary",
			},
			"visual"
		);
		await h.apply(visual);
		const rendered = (await h.coordinator.observe("session")).workspace;
		assert.equal(rendered.primaryId, id);
		assert.ok(rendered.secondaryId);
		assert.equal(
			rendered.canvases.some(
				(canvas) => canvas.kind === "visual" && canvas.provenance === "agent-draft"
			),
			true
		);
		assert.equal(JSON.stringify(rendered).includes('"execution"'), false);
	});

	it("retains closed drafts and restores them by ID after reinitialization", async (t) => {
		const h = harness(t);
		const draft = await h.prepare(document());
		await h.apply(draft);
		const id = draft.effect.snapshot.primaryId;
		await h.apply(await h.prepare({ kind: "close-canvas", id }, "close"));
		assert.equal(h.state.saved.canvases[0]?.closed, true);
		const reopened = harness(t, { loadCanvases: async () => clone(h.state.saved) });
		const startup = await reopened.coordinator.observe("session");
		assert.equal(startup.workspace.canvases.length, 1);
		assert.deepEqual(startup.savedCanvases, [
			{ id, title: "Notes", kind: "document", revision: 1 },
		]);
		await reopened.apply(await reopened.prepare({ kind: "focus-canvas", id }, "reopen"));
		const restored = (await reopened.coordinator.observe("session")).workspace;
		assert.equal(restored.primaryId, id);
		assert.equal(restored.canvases.find((canvas) => canvas.id === id)?.revision, 1);
	});

	it("bounds open canvases at twelve and preserves at most fifty archived drafts", async (t) => {
		const h = harness(t);
		for (let index = 0; index < 11; index++)
			await h.apply(await h.prepare(document(`${index}`), `create-${index}`));
		await assert.rejects(h.prepare(document("Overflow"), "overflow"), /maximum 12/);
		const visible = (await h.coordinator.observe("session")).workspace;
		assert.equal(visible.canvases.length, 12);
		const first = visible.canvases.find(({ kind }) => kind === "document");
		assert.ok(first);
		await h.apply(await h.prepare({ kind: "close-canvas", id: first.id }, "close-first"));
		await h.apply(await h.prepare(document("Replacement"), "replacement"));
		assert.equal(h.state.saved.canvases.find(({ canvas }) => canvas.id === first.id)?.closed, true);
		for (let index = 0; index < 51; index++) {
			const action = await h.prepare(
				{ kind: "close-canvas", id: (await h.coordinator.observe("session")).workspace.primaryId },
				`archive-${index}`
			);
			await h.apply(action);
			await h.apply(await h.prepare(document(`Archive ${index}`), `draft-${index}`));
		}
		assert.equal(h.state.saved.canvases.filter(({ closed }) => closed).length, 50);
		assert.deepEqual(SavedWorkspaceCanvasesSchema.parse(h.state.saved), h.state.saved);
	});

	it("requires ready reviews and validates target pins separately from UI sequence", async (t) => {
		const h = harness(t);
		h.state.ready = false;
		await assert.rejects(h.prepare({ kind: "show-review", prId: h.state.review.pr.id }), /failed/);
		h.state.ready = true;
		const action = await h.prepare({ kind: "show-review", prId: h.state.review.pr.id }, "ready");
		const navigation = action.effect.navigation;
		assert.ok(navigation);
		for (const update of [
			{ headSha: "c".repeat(40) },
			{ path: "src/second.ts" },
			{ paused: true },
			{ reviewId: "foreign" },
			{ prId: "foreign" },
		]) {
			const receipt = received(action);
			Object.assign(receipt.workspace.review, update);
			assert.equal(validateReviewNavigation(receipt.workspace.review, navigation), false);
			assert.deepEqual(await h.coordinator.applied(receipt), { status: "stale" });
		}
		const actual = received(action);
		actual.workspace.review.sequence += 4;
		h.state.screens.set("session", clone(actual.workspace.review));
		assert.equal((await h.coordinator.observe("session")).workspace.sequence, 0);
		assert.deepEqual(await h.coordinator.applied(actual), { status: "accepted" });
		assert.equal((await h.coordinator.observe("session")).workspace.review.sequence, 5);
		const next = await h.prepare({ kind: "navigate-review", direction: "next" }, "next");
		assert.equal(next.effect.navigation?.path, "src/second.ts");
		await h.apply(next, 10);
		const pause = await h.prepare({ kind: "navigate-review", direction: "pause" }, "pause");
		assert.equal(pause.effect.navigation?.paused, true);
		await h.apply(pause);
	});

	it("rejects a review receipt before the public review controller has shown its source", async (t) => {
		const h = harness(t);
		const action = await h.prepare({ kind: "show-review", prId: h.state.review.pr.id });
		await assert.rejects(h.coordinator.applied(received(action)), /actual displayed source/);
		assert.equal((await h.coordinator.observe("session")).workspace.sequence, 0);
	});

	it("unrelated actual manual review changes invalidate a pending workspace effect", async (t) => {
		const h = harness(t);
		const action = await h.prepare(document());
		h.state.screens.set("session", {
			sequence: 4,
			mode: "conversation",
			prId: h.state.review.pr.id,
		});
		const actual = await h.coordinator.observe("session");
		assert.equal(actual.workspace.sequence, 1);
		assert.equal(actual.workspace.canvases.length, 1);
		assert.deepEqual(await h.coordinator.applied(received(action)), { status: "stale" });
	});

	it("actual review changes during a durable write roll back before publication", async (t) => {
		const gate = deferred<void>();
		const h = harness(t, {
			saveCanvases: async (saved) => {
				h.state.saves.push(clone(saved));
				if (h.state.saves.length === 1) await gate.promise;
				h.state.saved = clone(saved);
			},
		});
		const action = await h.prepare(document());
		const applying = h.apply(action);
		const failure = assert.rejects(applying, /actual displayed source/);
		await until(() => h.state.saves.length === 1);
		assert.deepEqual(await h.coordinator.applied(received(action)), { status: "stale" });
		h.state.screens.set("session", {
			sequence: 3,
			mode: "conversation",
			prId: h.state.review.pr.id,
		});
		gate.resolve();
		await failure;
		assert.equal(h.state.saved.canvases.length, 0);
		assert.equal((await h.coordinator.observe("session")).workspace.canvases.length, 1);
	});

	it("browser loading can precede UI placement but cannot claim displayed before native presentation", async (t) => {
		const h = harness(t);
		const action = await h.prepare({ kind: "open-browser", url: "https://example.com/" });
		assert.equal(h.state.openCalls.length, 1);
		assert.equal(h.state.presented, false);
		assert.equal((await h.coordinator.observe("session")).workspace.browser, null);
		await assert.rejects(h.coordinator.applied(received(action)), /presentation has not settled/);
		assert.equal((await h.coordinator.observe("session")).workspace.sequence, 0);
		const retry = await h.prepare({ kind: "open-browser", url: "http://localhost:3000" }, "retry");
		await h.apply(retry);
		assert.equal((await h.coordinator.observe("session")).browser?.presented, true);
	});

	it("browser actions require the visible native page and current observation refs", async (t) => {
		const h = harness(t);
		const click: WorkspaceCommand = {
			kind: "browser-action",
			action: {
				kind: "click",
				browserId: "native-browser",
				observationSequence: 1,
				elementId: "actual-document:button",
			},
		};
		await assert.rejects(h.prepare(click), /actual presented page/);
		await h.apply(await h.prepare({ kind: "open-browser", url: "https://example.com" }, "open"));
		h.state.browserSequence++;
		await assert.rejects(h.prepare(click, "old-ref"), /stale observation/);
		const current = clone(click);
		if (current.kind === "browser-action" && current.action.kind === "click")
			current.action.observationSequence = 2;
		const action = await h.prepare(current, "click");
		assert.equal(h.state.browserCalls.length, 1);
		assert.equal((await h.coordinator.observe("session")).workspace.sequence, 1);
		await h.apply(action);
		await h.apply(await h.prepare({ kind: "focus-canvas", id: "review" }, "hide"));
		await assert.rejects(
			h.prepare({ kind: "browser-action", action: { kind: "reload" } }, "hidden"),
			/actual presented page/
		);
		assert.equal(h.state.browserCalls.length, 1);
	});

	it("layout, focus and code view share the same ack boundary and enforce unique panes", async (t) => {
		const h = harness(t);
		const draft = await h.prepare(document());
		await h.apply(draft);
		const id = draft.effect.snapshot.primaryId;
		await assert.rejects(
			h.prepare({ kind: "layout", primaryId: id, secondaryId: id }, "duplicate-pane"),
			/Invalid/
		);
		await h.apply(
			await h.prepare({ kind: "layout", primaryId: "review", secondaryId: id }, "split")
		);
		const codeView = await h.prepare({ kind: "code-view", view: "base" }, "base");
		assert.equal((await h.coordinator.observe("session")).workspace.codeView, "diff");
		await h.apply(codeView);
		assert.equal((await h.coordinator.observe("session")).workspace.codeView, "base");
		await h.apply(await h.prepare({ kind: "focus-canvas", id }, "swap"));
		const final = (await h.coordinator.observe("session")).workspace;
		assert.equal(final.primaryId, id);
		assert.equal(final.secondaryId, "review");
	});

	it("bounds the missing-UI receipt wait to ten seconds", { timeout: 15_000 }, async (t) => {
		const h = harness(t);
		const started = Date.now();
		await assert.rejects(
			h.coordinator.execute(document(), turn(), signal(), () => {}),
			/within 10 seconds/
		);
		assert.ok(Date.now() - started < 11_000);
		assert.equal((await h.coordinator.observe("session")).workspace.sequence, 0);
	});
});

it("creates a durable flow from main-read exact source outside changed files and rejects mixed commits", async (t) => {
	const requests: unknown[] = [];
	const h = harness(t, {
		readSource: async (location) => {
			requests.push(location);
			return {
				location,
				text: "unchanged source();\r\n",
				language: "typescript",
				truncated: false,
			};
		},
	});
	const location = {
		repository: "example/project",
		commitSha: "b".repeat(40),
		revision: "head" as const,
		path: "unchanged/caller.ts",
		startLine: 8,
		endLine: 8,
	};
	const command = {
		kind: "create-flow" as const,
		title: "Whole payment flow",
		summary: "Inferred order across actual source",
		steps: [{ title: "Caller", explanation: "Inferred relationship", location }],
	};
	const action = await h.prepare(command);
	assert.equal((await h.coordinator.observe("session")).workspace.primaryId, "review");
	await h.apply(action);
	const canvas = (await h.coordinator.observe("session")).workspace.canvases.find(
		(c) => c.kind === "flow"
	);
	assert.equal(canvas?.kind, "flow");
	if (canvas?.kind !== "flow") throw Error("Expected actual flow");
	assert.equal(canvas.flow.steps[0]?.source.text, "unchanged source();\r\n");
	assert.deepEqual(canvas.flow.steps[0]?.source.location, location);
	assert.equal(canvas.flow.provenance, "source-with-inferred-order");
	assert.ok(h.state.saved.canvases.some((entry) => entry.canvas.id === canvas.id));
	await assert.rejects(
		h.prepare(
			{
				...command,
				steps: [
					...command.steps,
					{
						title: "Another caller",
						explanation: "Inferred relationship",
						location: { ...location, commitSha: "c".repeat(40) },
					},
				],
			},
			"mixed-pins"
		),
		/one pinned/
	);
	assert.equal(requests.length, 1, "Mixed revisions reject before another source read");
});

it("sidebar browsing acknowledges only the category and preserves the displayed review, browser and panes", async (t) => {
	const h = harness(t, {
		hubSnapshot: async () => ({
			sequence: 0,
			refreshedAt: null,
			refreshing: false,
			viewer: { githubLogin: null, linearName: null },
			connections: { github: false, linear: false, model: false },
			repositories: [],
			reviews: [],
			tickets: [],
			jobs: [],
			notices: [],
			preferences: {
				linearTeamIds: [],
				linearProjectIds: [],
				maxWorkers: 2,
				autoApplySuggestions: false,
			},
			errors: [],
		}),
	});
	await h.apply(
		await h.prepare({ kind: "show-review", prId: h.state.review.pr.id }, "open-review")
	);
	await h.apply(
		await h.prepare(
			{ kind: "open-browser", url: "https://example.com/", target: "secondary" },
			"open-browser"
		)
	);
	for (const section of ["tickets", "feedback", "activity"] as const) {
		const before = (await h.coordinator.observe("session")).workspace;
		const action = await h.prepare({ kind: "browse-center", section }, `browse-${section}`);
		assert.equal(
			(await h.coordinator.observe("session")).workspace.centerSection,
			before.centerSection,
			"A prepared navigation is private until acknowledged"
		);
		assert.equal(await h.apply(action).then((r) => r.status), "accepted");
		const after = (await h.coordinator.observe("session")).workspace;
		const { sequence: _beforeSequence, centerSection: _beforeSection, ...content } = before;
		const { sequence: _afterSequence, centerSection: _afterSection, ...nextContent } = after;
		assert.deepEqual(nextContent, content);
		assert.equal(after.centerSection, section);
	}
	assert.equal(h.state.navigations.length, 1);
	assert.equal(h.state.openCalls.length, 1);
	assert.equal(h.state.presented, true);
});

const emptyFixHub: NonNullable<WorkspaceCoordinatorPorts["hubSnapshot"]> = async () => ({
	sequence: 0,
	refreshedAt: null,
	refreshing: false,
	viewer: { githubLogin: null, linearName: null },
	connections: { github: false, linear: false, model: false },
	repositories: [],
	reviews: [],
	tickets: [],
	jobs: [],
	notices: [],
	preferences: {
		linearTeamIds: [],
		linearProjectIds: [],
		maxWorkers: 2,
		autoApplySuggestions: false,
	},
	errors: [],
});

it("proposed fix file receipts pin the actual candidate and reject a changed head before narration", async (t) => {
	let head = "c".repeat(40);
	const h = harness(t, {
		hubSnapshot: emptyFixHub,
		prFixTarget: async (target) => ({
			id: target,
			title: "Proposed fix",
			source: { id: "fix", baseSha: "b".repeat(40), headSha: head, path: "src/fix.ts" },
		}),
	});
	const action = await h.prepare({
		kind: "open-center",
		section: "fixes",
		selectedId: "fix?file=src%2Ffix.ts",
	});
	const canvas = action.effect.snapshot.canvases.find(
		(row) => row.id === action.effect.snapshot.primaryId
	);
	assert.ok(canvas?.kind === "center");
	assert.equal(canvas.fixSource?.headSha, head);
	head = "d".repeat(40);
	await assert.rejects(h.apply(action), /suggested fix changed/);
	assert.equal((await h.coordinator.observe("session")).workspace.sequence, 0);
});

it("a current proposed fix file settles through the shared durable workspace receipt", async (t) => {
	const source = {
		id: "fix",
		baseSha: "b".repeat(40),
		headSha: "c".repeat(40),
		path: "src/fix.ts",
	};
	const h = harness(t, {
		hubSnapshot: emptyFixHub,
		prFixTarget: async (target) => ({ id: target, title: "src/fix.ts", source }),
	});
	const action = await h.prepare({
		kind: "open-center",
		section: "fixes",
		selectedId: "fix?file=src%2Ffix.ts",
	});
	await h.apply(action);
	const actual = (await h.coordinator.observe("session")).workspace;
	const canvas = actual.canvases.find((row) => row.id === actual.primaryId);
	assert.ok(canvas?.kind === "center");
	assert.deepEqual(canvas.fixSource, source);
	assert.equal(actual.centerSection, "fixes");
});

it("workspace preparation uses one operation-scoped review/navigation lookup when available", async (t) => {
	const h = harness(t);
	const original = h.ports.getReviews();
	let preparations = 0;
	h.ports.getReviews = () => ({
		...original,
		getReady: async () => {
			throw new Error("Redundant ready lookup");
		},
		navigate: async () => {
			throw new Error("Redundant navigation lookup");
		},
		prepareNavigation: async (prId, direction, signal) => {
			preparations++;
			return {
				review: h.state.review,
				navigation: await original.navigate(prId, direction, signal),
			};
		},
	});
	const opened = await h.prepare({ kind: "show-review", prId: h.state.review.pr.id });
	await h.apply(opened);
	const next = await h.prepare({ kind: "navigate-review", direction: "next" }, "next");
	assert.equal(next.effect.navigation?.path, "src/second.ts");
	await h.apply(next);
	assert.equal(preparations, 2);
});
