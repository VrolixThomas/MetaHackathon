import { randomUUID } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import { z } from "zod";
import {
	type AgentAction,
	AgentActionSchema,
	type Canvas,
	CanvasSchema,
	type CodeLocation,
	type HubSnapshot,
	IdSchema,
	type LocalBrowserState,
	LocalBrowserStateSchema,
	type PinnedSource,
	PreparedReviewSchema,
	ReviewInboxSchema,
	type ReviewNavigation,
	ReviewNavigationSchema,
	type ReviewScreen,
	ReviewScreenSchema,
	type TurnIdentity,
	TurnIdentitySchema,
	type WorkspaceActionReceipt,
	WorkspaceActionReceiptSchema,
	type WorkspaceBrowserCommand,
	type WorkspaceBrowserObservation,
	WorkspaceBrowserObservationSchema,
	type WorkspaceCommand,
	WorkspaceCommandSchema,
	type WorkspaceObservation,
	WorkspaceObservationSchema,
	type WorkspaceSnapshot,
	WorkspaceSnapshotSchema,
} from "../../shared/contracts";
import type { ReviewCoordinator } from "./reviews";

export type GeneratedCanvas = Extract<Canvas, { kind: "document" | "visual" | "flow" }>;
const generatedSchema = CanvasSchema.refine(
	(value): value is GeneratedCanvas =>
		value.kind === "document" || value.kind === "visual" || value.kind === "flow",
	"Only generated drafts can be saved"
);
/** Root owns the durable adapter; closed drafts remain addressable by their assigned ID. */
export const SavedWorkspaceCanvasesSchema = z
	.strictObject({
		version: z.literal(1),
		canvases: z.array(z.strictObject({ canvas: generatedSchema, closed: z.boolean() })).max(62),
	})
	.superRefine(({ canvases }, context) => {
		if (
			new Set(canvases.map(({ canvas }) => canvas.id)).size !== canvases.length ||
			canvases.filter(({ closed }) => closed).length > 50 ||
			canvases.filter(({ closed }) => !closed).length > 12 ||
			canvases.some(({ canvas }) => ["review", "browser", "center"].includes(canvas.id))
		)
			context.addIssue({ code: "custom", message: "Invalid saved canvas identities or limits" });
	});
export type SavedWorkspaceCanvases = z.infer<typeof SavedWorkspaceCanvasesSchema>;
export type WorkspaceReviewPort = Pick<
	ReviewCoordinator,
	"getScreen" | "inbox" | "getReady" | "navigate"
>;
export interface WorkspaceBrowserPort {
	open(url: string, signal?: AbortSignal): Promise<LocalBrowserState>;
	observe(signal?: AbortSignal): Promise<WorkspaceBrowserObservation | null>;
	execute(
		command: WorkspaceBrowserCommand,
		signal?: AbortSignal
	): Promise<WorkspaceBrowserObservation>;
	state(): Promise<LocalBrowserState | null>;
}
export interface WorkspaceCoordinatorPorts {
	getReviews(): WorkspaceReviewPort;
	getBrowser(): WorkspaceBrowserPort;
	loadCanvases?(): Promise<SavedWorkspaceCanvases | null>;
	saveCanvases?(value: SavedWorkspaceCanvases, signal?: AbortSignal): Promise<void>;
	hubSnapshot?(): Promise<HubSnapshot>;
	readSource?(location: CodeLocation, signal: AbortSignal): Promise<PinnedSource>;
	activateReview?(prId: string, signal: AbortSignal): Promise<void>;
}
type WorkspaceAction = Extract<AgentAction, { kind: "workspace-canvas" }>;
const prepareSchema = z.strictObject({
	sessionId: IdSchema,
	requestId: IdSchema,
	expectedSequence: z.int().nonnegative(),
	command: WorkspaceCommandSchema,
});
const turnSchema = TurnIdentitySchema.extend({ requestId: IdSchema });
const clone = <T>(value: T): T => structuredClone(value);
const generated = (canvas: Canvas): canvas is GeneratedCanvas =>
	canvas.kind === "document" || canvas.kind === "visual" || canvas.kind === "flow";
const initialReview = (): Canvas => ({
	id: "review",
	kind: "review",
	title: "Review",
	revision: 1,
});
class WorkspaceError extends Error {}
function fail(message: string): never {
	throw new WorkspaceError(message);
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
	try {
		const result = schema.safeParse(value);
		if (result.success) return result.data;
	} catch {
		// URL refinements and adapter errors must not reflect page content or credentials.
	}
	return fail("Invalid workspace payload.");
}

/** Review sequence may advance while the UI actually reads and displays the pinned source. */
export function validateReviewNavigation(
	screen: ReviewScreen,
	navigation: ReviewNavigation
): boolean {
	const target = parse(ReviewNavigationSchema, navigation);
	const actual = parse(ReviewScreenSchema, screen);
	return (
		actual.mode === "review" &&
		actual.prId === target.prId &&
		actual.reviewId === target.reviewId &&
		actual.baseSha === target.baseSha &&
		actual.headSha === target.headSha &&
		actual.path === target.path &&
		actual.paused === target.paused
	);
}
interface Pending {
	turn: TurnIdentity & { requestId: string };
	controller: AbortController;
	signal: AbortSignal;
	expectedSequence: number;
	base: WorkspaceSnapshot;
	action?: WorkspaceAction;
	command: WorkspaceCommand;
	settled: Promise<void>;
	resolve(): void;
	reject(error: Error): void;
	cleanup(): void;
	applying: boolean;
	timer?: ReturnType<typeof setTimeout>;
}
interface Session {
	id: string;
	controller: AbortController;
	ready: Promise<void>;
	snapshot?: WorkspaceSnapshot;
	pending?: Pending;
	requests: Set<string>;
	cancelled: Set<string>;
}

/** Per-UI canonical state. Native operations and durable storage are injected by composition. */
export class WorkspaceCoordinator {
	private readonly lifetime = new AbortController();
	private readonly sessions = new Map<string, Session>();
	private readonly released = new Set<string>();
	private library: SavedWorkspaceCanvases = { version: 1, canvases: [] };
	private loading?: Promise<void>;
	private storage: Promise<unknown> = Promise.resolve();
	private disposal?: Promise<void>;

	constructor(private readonly ports: WorkspaceCoordinatorPorts) {}

	private live(signal?: AbortSignal): void {
		if (this.lifetime.signal.aborted || signal?.aborted) fail("Workspace operation was cancelled.");
	}
	/** A noncooperating adapter cannot keep cancelled callers or UI acknowledgements alive. */
	private async call<T>(signal: AbortSignal, work: () => T | Promise<T>): Promise<T> {
		this.live(signal);
		const bounded = AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(15_000)]);
		let abort = () => {};
		const cancelled = new Promise<never>((_resolve, reject) => {
			abort = () => reject(new WorkspaceError("Workspace operation was cancelled or timed out."));
			bounded.addEventListener("abort", abort, { once: true });
		});
		try {
			return await Promise.race([
				Promise.resolve().then(() => {
					this.live(bounded);
					return work();
				}),
				cancelled,
			]);
		} catch (error) {
			throw error instanceof WorkspaceError
				? error
				: new WorkspaceError("Workspace operation failed.");
		} finally {
			bounded.removeEventListener("abort", abort);
		}
	}
	private load(): Promise<void> {
		this.loading ??= (async () => {
			if (!this.ports.loadCanvases) return;
			const saved = await this.call(this.lifetime.signal, () => this.ports.loadCanvases?.());
			this.live();
			if (saved != null) this.library = parse(SavedWorkspaceCanvasesSchema, saved);
		})();
		return this.loading;
	}
	private async session(raw: string, caller?: AbortSignal): Promise<Session> {
		const id = parse(IdSchema, raw);
		this.live(caller);
		if (this.released.has(id)) fail("Workspace session was released.");
		let session = this.sessions.get(id);
		if (!session) {
			if (this.sessions.size >= 100) fail("Too many workspace sessions.");
			const created: Session = {
				id,
				controller: new AbortController(),
				ready: Promise.resolve(),
				requests: new Set(),
				cancelled: new Set(),
			};
			this.sessions.set(id, created);
			created.ready = (async () => {
				await this.load();
				const screen = parse(
					ReviewScreenSchema,
					await this.call(created.controller.signal, () => this.ports.getReviews().getScreen(id))
				);
				this.live(created.controller.signal);
				// The executive brief is live data; legacy isolated compositions retain their review canvas.
				created.snapshot = parse(WorkspaceSnapshotSchema, {
					sequence: 0,
					canvases: this.ports.hubSnapshot
						? [{ id: "center", title: "Home", revision: 1, kind: "center", section: "home" }]
						: [initialReview()],
					primaryId: this.ports.hubSnapshot ? "center" : "review",
					...(this.ports.hubSnapshot ? { centerSection: "home" } : {}),
					secondaryId: null,
					review: screen,
					codeView: "diff",
					browser: null,
				});
			})();
			void created.ready.catch(() => {});
			session = created;
		}
		await this.call(
			AbortSignal.any([session.controller.signal, ...(caller ? [caller] : [])]),
			() => session.ready
		);
		return session;
	}
	private snapshot(session: Session): WorkspaceSnapshot {
		this.live(session.controller.signal);
		if (!session.snapshot) fail("Workspace has not initialized.");
		return session.snapshot;
	}
	private current(session: Session, pending: Pending): void {
		this.live(pending.signal);
		if (session.pending !== pending || this.snapshot(session).sequence !== pending.expectedSequence)
			fail("Workspace action is stale.");
	}
	private reject(session: Session, pending: Pending, message: string): void {
		if (session.pending !== pending) return;
		session.pending = undefined;
		pending.cleanup();
		pending.controller.abort();
		pending.reject(new WorkspaceError(message));
	}
	private begin(
		session: Session,
		turn: Pending["turn"],
		command: WorkspaceCommand,
		expectedSequence: number,
		manual: boolean,
		caller?: AbortSignal
	): Pending {
		const base = this.snapshot(session);
		if (session.cancelled.has(JSON.stringify([turn.turnId, turn.generation])))
			fail("Workspace turn was cancelled.");
		if (expectedSequence !== base.sequence) fail("Workspace sequence is stale. Observe it again.");
		if (session.requests.has(turn.requestId)) fail("Workspace request was already used.");
		if (session.requests.size >= 4096) fail("Workspace session request limit reached.");
		if (session.pending) {
			if (!manual) fail("Workspace already has a pending action.");
			this.reject(session, session.pending, "Workspace action was interrupted by a manual change.");
		}
		this.live(caller);
		const controller = new AbortController();
		const signal = AbortSignal.any([
			controller.signal,
			session.controller.signal,
			this.lifetime.signal,
			...(caller ? [caller] : []),
		]);
		let resolve = () => {};
		let reject = (_error: Error) => {};
		const settled = new Promise<void>((done, failed) => {
			resolve = done;
			reject = failed;
		});
		void settled.catch(() => {});
		const aborted = () => this.reject(session, pending, "Workspace action was cancelled.");
		const pending: Pending = {
			turn,
			controller,
			signal,
			expectedSequence,
			base: clone(base),
			command,
			settled,
			resolve,
			reject,
			cleanup: () => {
				clearTimeout(pending.timer);
				signal.removeEventListener("abort", aborted);
			},
			applying: false,
		};
		session.requests.add(turn.requestId);
		session.pending = pending;
		signal.addEventListener("abort", aborted, { once: true });
		return pending;
	}
	private focus(
		snapshot: WorkspaceSnapshot,
		id: string,
		target: "primary" | "secondary" = "primary"
	) {
		if (!snapshot.canvases.some((canvas) => canvas.id === id)) fail("Unknown workspace canvas.");
		if (target === "primary") {
			if (snapshot.secondaryId === id) snapshot.secondaryId = snapshot.primaryId;
			snapshot.primaryId = id;
		} else {
			if (snapshot.primaryId === id) fail("A canvas cannot occupy both panes.");
			snapshot.secondaryId = id;
		}
	}
	private put(snapshot: WorkspaceSnapshot, canvas: Canvas) {
		const index = snapshot.canvases.findIndex(({ id }) => id === canvas.id);
		if (index >= 0) snapshot.canvases[index] = canvas;
		else {
			if (snapshot.canvases.length >= 12)
				fail("Close a canvas before opening another (maximum 12).");
			snapshot.canvases.push(canvas);
		}
	}
	private async build(session: Session, pending: Pending): Promise<WorkspaceAction> {
		const snapshot = clone(pending.base);
		const command = pending.command;
		const signal = pending.signal;
		let navigation: ReviewNavigation | undefined;
		const invoke = <T>(work: () => T | Promise<T>) => this.call(signal, work);
		switch (command.kind) {
			case "browse-center":
				if (!this.ports.hubSnapshot) fail("Command center is unavailable.");
				snapshot.centerSection = command.section;
				break;
			case "open-center": {
				if (!this.ports.hubSnapshot) fail("Command center is unavailable.");
				const titles = {
					home: "Home",
					reviews: "PR reviews",
					feedback: "My PR feedback",
					tickets: "My tickets",
					completed: "Completed work",
					activity: "Activity",
				};
				const previous = snapshot.canvases.find((canvas) => canvas.id === "center");
				this.put(
					snapshot,
					parse(CanvasSchema, {
						id: "center",
						kind: "center",
						revision: (previous?.revision ?? 0) + 1,
						title: titles[command.section],
						section: command.section,
						...(command.selectedId ? { selectedId: command.selectedId } : {}),
					})
				);
				snapshot.centerSection = command.section;
				snapshot.primaryId = "center";
				snapshot.secondaryId = null;
				break;
			}
			case "open-source": {
				if (!this.ports.readSource) fail("Pinned source is unavailable.");
				const source = await invoke(() => this.ports.readSource?.(command.location, signal));
				const id = command.target === "secondary" ? "source-secondary" : "source-primary";
				const previousSource = snapshot.canvases.find((canvas) => canvas.id === id);
				this.put(
					snapshot,
					parse(CanvasSchema, {
						id,
						kind: "source",
						revision: (previousSource?.revision ?? 0) + 1,
						title: command.location.path.slice(-120),
						source,
					})
				);
				this.focus(snapshot, id, command.target);
				break;
			}
			case "create-flow": {
				if (!this.ports.readSource) fail("Pinned source is unavailable.");
				const first = command.steps[0]?.location;
				if (
					!first ||
					command.steps.some(
						(step) =>
							step.location.repository !== first.repository ||
							step.location.commitSha !== first.commitSha ||
							step.location.revision !== first.revision
					)
				)
					fail("A flow must use one pinned repository revision.");
				const previous = command.id
					? (snapshot.canvases.find((canvas) => canvas.id === command.id) ??
						this.library.canvases.find((item) => item.canvas.id === command.id)?.canvas)
					: undefined;
				if (command.id && previous?.kind !== "flow") fail("Unknown code flow.");
				const steps = [];
				for (const step of command.steps) {
					const source = await invoke(() => this.ports.readSource?.(step.location, signal));
					steps.push({
						id: randomUUID(),
						title: step.title,
						explanation: step.explanation,
						source,
					});
				}
				const id = previous?.id ?? randomUUID();
				this.put(
					snapshot,
					parse(CanvasSchema, {
						id,
						kind: "flow",
						revision: (previous?.revision ?? 0) + 1,
						title: command.title,
						flow: {
							title: command.title,
							summary: command.summary,
							steps,
							provenance: "source-with-inferred-order",
						},
					})
				);
				this.focus(snapshot, id, command.target);
				break;
			}
			case "write-document":
			case "create-visual": {
				const previous = command.id
					? (snapshot.canvases.find(({ id }) => id === command.id) ??
						this.library.canvases.find(({ canvas }) => canvas.id === command.id)?.canvas)
					: undefined;
				const kind = command.kind === "write-document" ? "document" : "visual";
				if (command.id && (!previous || previous.kind !== kind))
					fail("Draft ID is unknown or belongs to another canvas kind.");
				const canvas = parse(CanvasSchema, {
					id: previous?.id ?? randomUUID(),
					revision: (previous?.revision ?? 0) + 1,
					title: command.title,
					kind,
					provenance: "agent-draft",
					references: command.references ?? [],
					...(command.kind === "write-document"
						? { markdown: command.markdown }
						: { visual: command.visual }),
				});
				this.put(snapshot, canvas);
				this.focus(snapshot, canvas.id, command.target);
				break;
			}
			case "focus-canvas": {
				if (!snapshot.canvases.some(({ id }) => id === command.id)) {
					const saved = this.library.canvases.find(({ canvas }) => canvas.id === command.id);
					if (!saved) fail("Unknown workspace canvas.");
					this.put(snapshot, clone(saved.canvas));
				}
				this.focus(snapshot, command.id, command.target);
				break;
			}
			case "close-canvas": {
				if (!snapshot.canvases.some(({ id }) => id === command.id))
					fail("Unknown workspace canvas.");
				if (snapshot.canvases.length === 1) fail("The last canvas cannot be closed.");
				snapshot.canvases = snapshot.canvases.filter(({ id }) => id !== command.id);
				if (snapshot.secondaryId === command.id) snapshot.secondaryId = null;
				if (snapshot.primaryId === command.id) {
					const first = snapshot.canvases[0];
					if (!first) fail("The last canvas cannot be closed.");
					snapshot.primaryId = snapshot.secondaryId ?? first.id;
					snapshot.secondaryId = null;
				}
				break;
			}
			case "layout":
				snapshot.primaryId = command.primaryId;
				snapshot.secondaryId = command.secondaryId;
				break;
			case "code-view":
				snapshot.codeView = command.view;
				break;
			case "show-review":
			case "navigate-review": {
				const prId = command.kind === "show-review" ? command.prId : snapshot.review.prId;
				if (!prId) fail("Open a ready review before navigating its source.");
				if (command.kind === "show-review" && this.ports.activateReview)
					await invoke(() => this.ports.activateReview?.(prId, signal));
				const review = parse(
					PreparedReviewSchema,
					await invoke(() => this.ports.getReviews().getReady(prId, signal))
				);
				if (command.kind === "show-review" && this.ports.hubSnapshot) {
					const hub = await this.ports.hubSnapshot();
					snapshot.centerSection =
						hub.reviews.find((item) => item.pr.id === prId)?.kind === "own"
							? "feedback"
							: "reviews";
				}
				const direction =
					command.kind === "navigate-review"
						? {
								direction: command.direction,
								path: command.path,
								line: command.line,
								side: command.side,
							}
						: { direction: "resume" as const };
				navigation = parse(
					ReviewNavigationSchema,
					await invoke(() => this.ports.getReviews().navigate(prId, direction, signal))
				);
				if (
					navigation.prId !== review.pr.id ||
					navigation.reviewId !== review.id ||
					navigation.baseSha !== review.pr.baseSha ||
					navigation.headSha !== review.pr.headSha ||
					!review.files.some(({ path }) => path === navigation?.path)
				)
					fail("Review navigation does not match the ready revision.");
				snapshot.review = {
					sequence: snapshot.review.sequence + 1,
					mode: "review",
					prId: navigation.prId,
					reviewId: navigation.reviewId,
					baseSha: navigation.baseSha,
					headSha: navigation.headSha,
					path: navigation.path,
					paused: navigation.paused,
				};
				if (navigation.highlight) snapshot.codeView = navigation.highlight.revision;
				if (!snapshot.canvases.some(({ id }) => id === "review"))
					this.put(snapshot, initialReview());
				this.focus(snapshot, "review", command.kind === "show-review" ? command.target : undefined);
				break;
			}
			case "open-browser": {
				snapshot.browser = parse(
					LocalBrowserStateSchema,
					await invoke(() => this.ports.getBrowser().open(command.url, signal))
				);
				const previous = snapshot.canvases.find(({ id }) => id === "browser");
				this.put(snapshot, {
					id: "browser",
					kind: "browser",
					title: "Browser",
					revision: (previous?.revision ?? 0) + 1,
				});
				this.focus(snapshot, "browser", command.target);
				break;
			}
			case "browser-action": {
				const browser = this.ports.getBrowser();
				const observed = parse(
					WorkspaceBrowserObservationSchema.nullable(),
					await invoke(() => browser.observe(signal))
				);
				if (!this.browserVisible(snapshot) || !observed?.presented)
					fail("Browser actions require the actual presented page.");
				const action = command.action;
				if (
					"browserId" in action &&
					(action.browserId !== observed.browserId ||
						action.observationSequence !== observed.sequence ||
						("elementId" in action &&
							action.elementId !== undefined &&
							!observed.elements.some(({ id }) => id === action.elementId)))
				)
					fail("Browser action refers to a stale observation.");
				this.current(session, pending);
				parse(
					WorkspaceBrowserObservationSchema,
					await invoke(() => browser.execute(action, signal))
				);
				snapshot.browser = parse(
					LocalBrowserStateSchema.nullable(),
					await invoke(() => browser.state())
				);
				if (!snapshot.browser) fail("Browser page is no longer available.");
				break;
			}
		}
		this.current(session, pending);
		snapshot.sequence++;
		const action = parse(AgentActionSchema, {
			...pending.turn,
			kind: "workspace-canvas",
			screenSequence: pending.expectedSequence,
			effect: {
				expectedSequence: pending.expectedSequence,
				snapshot,
				...(navigation ? { navigation } : {}),
			},
		});
		if (action.kind !== "workspace-canvas") fail("Invalid workspace effect.");
		pending.action = action;
		pending.timer = setTimeout(
			() =>
				this.reject(
					session,
					pending,
					"Workspace did not acknowledge the action within 10 seconds."
				),
			10_000
		);
		return clone(action);
	}

	async prepare(raw: z.infer<typeof prepareSchema>): Promise<WorkspaceAction> {
		const input = parse(prepareSchema, raw);
		const session = await this.session(input.sessionId);
		const turn = {
			sessionId: input.sessionId,
			requestId: input.requestId,
			turnId: `manual-${input.requestId}`,
			generation: 0,
		};
		const pending = this.begin(session, turn, input.command, input.expectedSequence, true);
		try {
			return await this.build(session, pending);
		} catch (error) {
			this.reject(session, pending, "Workspace action could not be prepared.");
			throw error;
		}
	}
	async execute(
		raw: WorkspaceCommand,
		rawTurn: TurnIdentity & { requestId: string },
		signal: AbortSignal,
		onAction: (action: AgentAction) => void
	): Promise<WorkspaceObservation> {
		const command = parse(WorkspaceCommandSchema, raw);
		const turn = parse(turnSchema, rawTurn);
		const session = await this.session(turn.sessionId, signal);
		const pending = this.begin(
			session,
			turn,
			command,
			this.snapshot(session).sequence,
			false,
			signal
		);
		try {
			const action = await this.build(session, pending);
			this.current(session, pending);
			onAction(action);
			await pending.settled;
			return await this.observe(turn.sessionId, signal);
		} catch (error) {
			this.reject(session, pending, "Workspace action failed.");
			throw error;
		}
	}
	private browserVisible(snapshot: WorkspaceSnapshot): boolean {
		return snapshot.canvases.some(
			({ id, kind }) =>
				kind === "browser" && (snapshot.primaryId === id || snapshot.secondaryId === id)
		);
	}
	private receiptMatches(pending: Pending, receipt: WorkspaceActionReceipt): boolean {
		const expected = pending.action?.effect.snapshot;
		if (!expected) return false;
		if (receipt.status === "ignored") {
			// Discard all UI content. Only observe() can reconcile the actually displayed source.
			return true;
		}
		const candidate = clone(receipt.workspace);
		if (pending.action?.effect.navigation) {
			if (
				candidate.review.sequence < expected.review.sequence ||
				!validateReviewNavigation(candidate.review, pending.action.effect.navigation)
			)
				return false;
			candidate.review.sequence = expected.review.sequence;
		}
		// Fitting a desktop page happens after its canvas renders. Only its dimensions may
		// settle differently; applied() verifies them against the actual native observation.
		if (
			expected.browser?.viewportMode === "desktop" &&
			candidate.browser?.viewportMode === "desktop"
		)
			candidate.browser.viewport = expected.browser.viewport;
		return equal(candidate, expected);
	}
	private savedCandidate(pending: Pending, snapshot: WorkspaceSnapshot): SavedWorkspaceCanvases {
		const records = clone(this.library.canvases);
		for (const canvas of snapshot.canvases.filter(generated)) {
			const index = records.findIndex((entry) => entry.canvas.id === canvas.id);
			if (index >= 0) {
				const latest = records[index]?.canvas;
				if (!latest) fail("Draft storage changed.");
				if (
					latest.revision > canvas.revision ||
					(latest.revision === canvas.revision && !equal(latest, canvas))
				)
					fail("Draft changed in another workspace. Reopen its latest revision.");
				records.splice(index, 1);
			}
			records.push({ canvas: clone(canvas), closed: false });
		}
		for (const canvas of pending.base.canvases.filter(generated)) {
			if (snapshot.canvases.some(({ id }) => id === canvas.id)) continue;
			const index = records.findIndex((entry) => entry.canvas.id === canvas.id);
			if (index >= 0) {
				const [record] = records.splice(index, 1);
				if (!record) fail("Draft storage changed.");
				record.closed = true;
				records.push(record);
			}
		}
		const archived = records.filter(({ closed }) => closed).slice(-50);
		return parse(SavedWorkspaceCanvasesSchema, {
			version: 1,
			canvases: [...archived, ...records.filter(({ closed }) => !closed)],
		});
	}
	async applied(raw: WorkspaceActionReceipt): Promise<{ status: "accepted" | "stale" }> {
		const receipt = parse(WorkspaceActionReceiptSchema, raw);
		const session = this.sessions.get(receipt.sessionId);
		const pending = session?.pending;
		if (
			!session ||
			!pending ||
			pending.applying ||
			!equal(pending.turn, {
				sessionId: receipt.sessionId,
				turnId: receipt.turnId,
				generation: receipt.generation,
				requestId: receipt.requestId,
			}) ||
			!this.receiptMatches(pending, receipt)
		)
			return { status: "stale" };
		if (receipt.status === "ignored") {
			this.reject(session, pending, "Workspace action was ignored by the UI.");
			return { status: "accepted" };
		}
		pending.applying = true;
		const commit = this.storage
			.catch(() => {})
			.then(async () => {
				this.current(session, pending);
				const snapshot = clone(receipt.workspace);
				const checkActual = async () => {
					const screen = parse(
						ReviewScreenSchema,
						await this.call(pending.signal, () => this.ports.getReviews().getScreen(session.id))
					);
					if (!equal(screen, snapshot.review))
						fail("Review receipt does not identify the actual displayed source.");
					const observed = parse(
						WorkspaceBrowserObservationSchema.nullable(),
						await this.call(pending.signal, () => this.ports.getBrowser().observe(pending.signal))
					);
					if (this.browserVisible(snapshot) !== (observed?.presented ?? false))
						fail("Native browser presentation has not settled.");
					if (observed?.presented && snapshot.browser?.viewportMode) {
						const native = parse(
							LocalBrowserStateSchema.nullable(),
							await this.call(pending.signal, () => this.ports.getBrowser().state())
						);
						if (
							native?.viewportMode !== snapshot.browser.viewportMode ||
							native.url !== snapshot.browser.url
						)
							fail(
								"Browser receipt does not identify the current native page and presentation mode."
							);
					}
					if (
						snapshot.browser?.viewportMode === "desktop" &&
						observed?.presented &&
						!equal(snapshot.browser.viewport, observed.viewport)
					)
						fail("Browser receipt does not identify the actual displayed viewport.");
				};
				await checkActual();
				this.current(session, pending);
				const saved = this.savedCandidate(pending, snapshot);
				const previous = clone(this.library);
				const changed = !equal(saved, previous);
				if (changed && this.ports.saveCanvases) {
					// Keep the storage barrier until the underlying write settles, even after cancellation.
					await this.ports.saveCanvases(clone(saved), pending.signal);
					try {
						this.current(session, pending);
						await checkActual();
					} catch (error) {
						await this.ports.saveCanvases(previous, AbortSignal.timeout(15_000));
						throw error;
					}
				}
				this.current(session, pending);
				this.library = saved;
				session.snapshot = snapshot;
				session.pending = undefined;
				pending.cleanup();
				pending.resolve();
			});
		this.storage = commit;
		try {
			await this.call(pending.signal, () => commit);
			return { status: "accepted" };
		} catch (error) {
			this.reject(session, pending, "Workspace action could not be committed.");
			throw error;
		}
	}

	async observe(sessionId: string, caller?: AbortSignal): Promise<WorkspaceObservation> {
		const session = await this.session(sessionId, caller);
		const signal = AbortSignal.any([
			session.controller.signal,
			this.lifetime.signal,
			...(caller ? [caller] : []),
		]);
		const [screen, inbox, browser, state] = await Promise.all([
			this.call(signal, () => this.ports.getReviews().getScreen(session.id)),
			this.call(signal, () => this.ports.getReviews().inbox()),
			this.call(signal, () => this.ports.getBrowser().observe(signal)),
			this.call(signal, () => this.ports.getBrowser().state()),
		]);
		this.live(signal);
		const actual = parse(ReviewScreenSchema, screen);
		const nativeObservation = parse(WorkspaceBrowserObservationSchema.nullable(), browser);
		const nativeState = parse(LocalBrowserStateSchema.nullable(), state);
		const reviewInbox = parse(ReviewInboxSchema, inbox);
		const snapshot = this.snapshot(session);
		if (!equal(actual, snapshot.review) && actual.sequence >= snapshot.review.sequence) {
			const navigation = session.pending?.action?.effect.navigation;
			// A prepared source becoming visible is still private until its matching receipt commits.
			if (!navigation || !validateReviewNavigation(actual, navigation)) {
				if (session.pending)
					this.reject(session, session.pending, "Review changed during workspace action.");
				session.snapshot = parse(WorkspaceSnapshotSchema, {
					...snapshot,
					sequence: snapshot.sequence + 1,
					review: actual,
				});
			}
		}
		const current = clone(this.snapshot(session));
		if (!session.pending && current.canvases.some(({ kind }) => kind === "browser")) {
			current.browser = nativeState;
			session.snapshot = clone(current);
		}
		return parse(WorkspaceObservationSchema, {
			workspace: current,
			browser: nativeObservation,
			reviews: reviewInbox.items.map(({ pr, status, prepared }) => ({
				pr,
				status,
				...(status === "ready" && prepared ? { reviewId: prepared.id } : {}),
			})),
			capabilities: ["documents", "visuals", "browser", "review"],
			...(this.ports.hubSnapshot
				? {
						hub: await this.ports.hubSnapshot(),
						capabilities: ["documents", "visuals", "browser", "review", "center", "source", "flow"],
					}
				: {}),
			savedCanvases: this.library.canvases
				.filter(
					({ closed, canvas }) => closed || !current.canvases.some(({ id }) => id === canvas.id)
				)
				.slice(-50)
				.map(({ canvas }) => ({
					id: canvas.id,
					title: canvas.title,
					kind: canvas.kind,
					revision: canvas.revision,
				})),
		});
	}
	cancel(raw: TurnIdentity): void {
		const turn = parse(TurnIdentitySchema, raw);
		const session = this.sessions.get(turn.sessionId);
		if (session) {
			if (session.cancelled.size >= 4096) this.release(turn.sessionId);
			else session.cancelled.add(JSON.stringify([turn.turnId, turn.generation]));
		}
		const pending = session?.pending;
		if (
			session &&
			pending &&
			pending.turn.turnId === turn.turnId &&
			pending.turn.generation === turn.generation
		)
			this.reject(session, pending, "Workspace action was cancelled.");
	}
	release(raw: string): void {
		const id = parse(IdSchema, raw);
		const session = this.sessions.get(id);
		if (session?.pending) this.reject(session, session.pending, "Workspace session was released.");
		session?.controller.abort();
		this.sessions.delete(id);
		this.released.add(id);
	}
	dispose(): Promise<void> {
		if (this.disposal) return this.disposal;
		this.lifetime.abort();
		for (const id of this.sessions.keys()) this.release(id);
		// The owner may close storage only after an admitted write and its rollback settle.
		this.disposal = this.storage.then(
			() => {},
			() => {}
		);
		return this.disposal;
	}
}
