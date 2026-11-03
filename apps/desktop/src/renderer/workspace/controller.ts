import { createStore } from "zustand/vanilla";
import {
	type AgentAction,
	AgentActionReceiptResultSchema,
	AgentActionSchema,
	type BrowserBounds,
	type ImageAsset,
	ImageReadResultSchema,
	type PRFixPresentation,
	WORKSPACE_GITHUB_REQUIRED,
	type WorkspaceActionReceipt,
	WorkspaceActionReceiptSchema,
	type WorkspaceCommand,
	WorkspaceCommandSchema,
	type WorkspaceObservation,
	WorkspaceObservationSchema,
	type WorkspaceSnapshot,
	WorkspaceSnapshotSchema,
} from "../../shared/contracts";
import type { ConversationApi } from "../conversation/api";
import type { PreparedController } from "../prepared/controller";
import type { LocalBrowserController } from "./local-browser";

type Status = "applied" | "ignored";
export const PR_FIX_SOURCE_CHANGED = "The proposed fix completed while its view was loading.";
type CanvasAction = Extract<AgentAction, { kind: "workspace-canvas" }>;
type PendingRender = {
	sequence: number;
	committed: boolean;
	native: boolean;
	images: Set<string>;
	resolve(status: Status): void;
};

function validateWorkspace(input: WorkspaceSnapshot) {
	const workspace = WorkspaceSnapshotSchema.parse(input);
	if (
		["browser", "review"].some(
			(kind) => workspace.canvases.filter((canvas) => canvas.kind === kind).length > 1
		)
	)
		throw new Error("Native browser and pinned review canvases are singletons");
	return workspace;
}

/** Sidebar selection shares receipts while retaining the exact displayed content. */
function samePresentedContent(a: WorkspaceSnapshot, b: WorkspaceSnapshot) {
	const { sequence: _aSequence, centerSection: _aSection, ...aContent } = a;
	const { sequence: _bSequence, centerSection: _bSection, ...bContent } = b;
	return JSON.stringify(aContent) === JSON.stringify(bContent);
}

export function createWorkspaceController(
	call: ConversationApi["call"],
	reviews: PreparedController,
	browser: LocalBrowserController,
	sessionId: string,
	options: {
		onManualChange?: () => void;
		renderTimeoutMs?: number;
		ensureDayItem?: (id: string) => Promise<void>;
		ensureSlackTarget?: (target: string) => Promise<void>;
		ensurePRFixTarget?: (target: string, expected: PRFixPresentation) => Promise<void>;
	} = {}
) {
	const store = createStore<{
		workspace: WorkspaceSnapshot | null;
		observation: WorkspaceObservation | null;
		busy: boolean;
		error: string;
	}>(() => ({ workspace: null, observation: null, busy: false, error: "" }));
	let disposed = false;
	let obscured = false;
	let epoch = 0;
	let manualEpoch = 0;
	let browseIntent = 0;
	let manualPending: Promise<Status> | undefined;
	let manualInteraction = options.onManualChange;
	let pending: PendingRender | undefined;
	const readyImages = new Set<string>();
	let operation: AbortController | undefined;
	let activeRequest: string | undefined;
	let retryFixRequest: string | undefined;
	const deliveries = new Map<string, Promise<Status>>();

	const getContext = (): WorkspaceSnapshot | undefined => {
		const workspace = store.getState().workspace;
		if (!workspace) return undefined;
		return WorkspaceSnapshotSchema.parse({
			...workspace,
			review: reviews.getContext().screen ?? reviews.store.getState().screen,
			browser: browser.store.getState().page,
		});
	};
	function invalidate() {
		epoch++;
		operation?.abort();
		activeRequest = undefined;
		pending?.resolve("ignored");
		pending = undefined;
	}
	function finishRender() {
		if (pending?.committed && pending.native && pending.images.size === 0)
			pending.resolve("applied");
	}
	function rendered(sequence: number) {
		if (!pending || pending.sequence !== sequence || obscured || disposed) return;
		pending.committed = true;
		finishRender();
	}
	function presented(sequence: number, bounds: BrowserBounds | null) {
		const workspace = store.getState().workspace;
		if (!pending || pending.sequence !== sequence || !workspace || disposed) return;
		const visibleBrowser = workspace.canvases.some(
			(canvas) =>
				canvas.kind === "browser" &&
				(canvas.id === workspace.primaryId || canvas.id === workspace.secondaryId)
		);
		if (obscured || (visibleBrowser && (!bounds || bounds.width < 1 || bounds.height < 1))) {
			pending.resolve("ignored");
			return;
		}
		pending.native = visibleBrowser ? bounds !== null : bounds === null;
		finishRender();
	}
	function presentationFailed(sequence: number) {
		if (!pending || pending.sequence !== sequence || disposed) return;
		pending.resolve("ignored");
		store.setState({ error: "The browser surface could not be positioned. Try the canvas again." });
	}
	async function reconcile(current: number) {
		if (disposed || current !== epoch) return;
		const observation = WorkspaceObservationSchema.parse(
			await call("query", "workspace.observe", { sessionId })
		);
		if (disposed || current !== epoch) return;
		validateWorkspace(observation.workspace);
		browser.adopt(observation.workspace.browser);
		store.setState({ workspace: observation.workspace, observation });
	}
	async function acknowledge(action: CanvasAction, status: Status) {
		const receiptEpoch = epoch;
		const key = JSON.stringify([
			action.sessionId,
			action.turnId,
			action.generation,
			action.requestId,
		]);
		const workspace = getContext();
		if (!workspace) return "ignored" as const;
		const receipt: WorkspaceActionReceipt = WorkspaceActionReceiptSchema.parse({
			sessionId: action.sessionId,
			turnId: action.turnId,
			generation: action.generation,
			requestId: action.requestId,
			status,
			workspace,
		});
		const result = AgentActionReceiptResultSchema.parse(
			await call("mutation", "workspace.applied", receipt)
		);
		if (activeRequest === undefined || activeRequest === key) {
			try {
				await reconcile(receiptEpoch);
			} catch {
				if (!disposed && receiptEpoch === epoch) {
					store.setState({
						error:
							"The canvas changed, but workspace status is unavailable. Try again to reconnect.",
					});
				}
			}
		}
		return result.status === "accepted" ? status : ("ignored" as const);
	}
	function applyAction(
		input: AgentAction,
		live: () => boolean,
		signal?: AbortSignal
	): Promise<Status> {
		const action = AgentActionSchema.parse(input);
		if (action.kind !== "workspace-canvas") return Promise.resolve("ignored");
		const key = JSON.stringify([
			action.sessionId,
			action.turnId,
			action.generation,
			action.requestId,
		]);
		const prior = deliveries.get(key);
		if (prior) return prior;
		const work = (async () => {
			let status: Status = "ignored";
			const before = getContext();
			if (!before || disposed) return status;
			if (
				action.sessionId !== sessionId ||
				signal?.aborted ||
				!live() ||
				obscured ||
				action.effect.expectedSequence !== before.sequence ||
				action.screenSequence !== before.sequence
			)
				return acknowledge(action, status);
			invalidate();
			const current = epoch;
			const abort = new AbortController();
			operation = abort;
			activeRequest = key;
			const cancel = () => abort.abort();
			signal?.addEventListener("abort", cancel, { once: true });
			const valid = () =>
				!disposed && !obscured && !abort.signal.aborted && current === epoch && live();
			const cancelled = new Promise<"ignored">((resolve) =>
				abort.signal.addEventListener("abort", () => resolve("ignored"), { once: true })
			);
			store.setState({ busy: true, error: "" });
			const timeout = setTimeout(() => {
				if (!disposed && current === epoch)
					store.setState({ error: "The canvas did not finish displaying. Try again." });
				abort.abort();
			}, options.renderTimeoutMs ?? 15000);
			try {
				validateWorkspace(action.effect.snapshot);
				const primary = action.effect.snapshot.canvases.find(
					(canvas) => canvas.id === action.effect.snapshot.primaryId
				);
				if (primary?.kind === "center" && primary.section === "day" && primary.selectedId) {
					if (!options.ensureDayItem) throw new Error("Day presentation is unavailable");
					await Promise.race([options.ensureDayItem(primary.selectedId), cancelled]);
					if (!valid()) return await acknowledge(action, status);
				}
				if (primary?.kind === "center" && primary.section === "slack" && primary.selectedId) {
					if (!options.ensureSlackTarget) throw new Error("Slack presentation is unavailable");
					await Promise.race([options.ensureSlackTarget(primary.selectedId), cancelled]);
					if (!valid()) return await acknowledge(action, status);
				}
				if (primary?.kind === "center" && primary.section === "fixes" && primary.selectedId) {
					if (!options.ensurePRFixTarget || !primary.fixSource)
						throw new Error("Suggested fix presentation is unavailable");
					await Promise.race([
						options.ensurePRFixTarget(primary.selectedId, primary.fixSource),
						cancelled,
					]);
					if (!valid()) return await acknowledge(action, status);
				}
				// Hide goes ahead of native navigation/resize queues and before installing another canvas.
				if (!samePresentedContent(before, action.effect.snapshot))
					await Promise.race([browser.present(null), cancelled]);
				if (!valid()) return await acknowledge(action, status);
				if (action.effect.navigation) {
					const navigation = await Promise.race([
						reviews.navigate(action.effect.navigation, valid, abort.signal),
						cancelled,
					]);
					if (navigation !== "applied" || !valid()) return await acknowledge(action, status);
				}
				if (!valid()) return await acknowledge(action, status);
				browser.adopt(action.effect.snapshot.browser);
				const snapshot = validateWorkspace({
					...action.effect.snapshot,
					review: reviews.getContext().screen ?? reviews.store.getState().screen,
				});
				const displayed = new Promise<Status>((resolve) => {
					pending = {
						sequence: snapshot.sequence,
						committed: false,
						native: false,
						resolve,
						images: new Set(
							snapshot.canvases
								.filter(
									(canvas) =>
										canvas.kind === "image" &&
										(canvas.id === snapshot.primaryId || canvas.id === snapshot.secondaryId)
								)
								.map((canvas) =>
									canvas.kind === "image" ? `${canvas.asset.id}:${canvas.asset.sha256}` : ""
								)
								.filter((key) => !readyImages.has(key))
						),
					};
				});
				store.setState({ workspace: snapshot });
				status = await Promise.race([displayed, cancelled]);
				if (!valid()) status = "ignored";
				if (status === "ignored" && valid())
					store.setState({ error: "The canvas did not finish displaying. Try again." });
				return await acknowledge(action, status);
			} catch (error) {
				if (valid() && error instanceof Error && error.message === PR_FIX_SOURCE_CHANGED)
					retryFixRequest = action.requestId;
				if (valid())
					store.setState({ error: "The workspace change could not complete. Try again." });
				try {
					return await acknowledge(action, "ignored");
				} catch {
					return "ignored" as const;
				}
			} finally {
				clearTimeout(timeout);
				signal?.removeEventListener("abort", cancel);
				if (current === epoch) {
					pending = undefined;
					operation = undefined;
					activeRequest = undefined;
					store.setState({ busy: false });
				}
			}
		})();
		deliveries.set(key, work);
		if (deliveries.size > 400) {
			const oldest = deliveries.keys().next().value;
			if (oldest) deliveries.delete(oldest);
		}
		return work;
	}
	function command(input: WorkspaceCommand): Promise<Status> {
		const parsed = WorkspaceCommandSchema.safeParse(input);
		if (!parsed.success) {
			store.setState({
				error:
					"Check the workspace request. Websites require an HTTPS or local HTTP address without credentials.",
			});
			return Promise.resolve("ignored" as const);
		}
		const intent = ++browseIntent;
		const command = parsed.data;
		const prior = manualPending;
		const display = activeRequest ? deliveries.get(activeRequest) : undefined;
		const work =
			command.kind === "browse-center"
				? (async () => {
						await Promise.allSettled([...(prior ? [prior] : []), ...(display ? [display] : [])]);
						if (intent !== browseIntent || disposed || obscured) return "ignored" as const;
						return performCommand(command);
					})()
				: performCommand(command);
		manualPending = work;
		void work
			.finally(() => {
				if (manualPending === work) manualPending = undefined;
			})
			.catch(() => {});
		return work;
	}
	async function performCommand(command: WorkspaceCommand, retryFix = true): Promise<Status> {
		if (disposed || obscured) return "ignored" as const;
		if (command.kind !== "browse-center" && retryFix) manualInteraction?.();
		const request = ++manualEpoch;
		invalidate();
		const current = epoch;
		store.setState({ busy: true, error: "" });
		try {
			// Main can reconcile review/source changes while a picker or another turn is open.
			// Every manual intent must prepare against that current canonical snapshot.
			await reconcile(current);
			const before = getContext();
			if (!before || disposed || current !== epoch) return "ignored" as const;
			const action = AgentActionSchema.parse(
				await call("mutation", "workspace.prepare", {
					sessionId,
					requestId: crypto.randomUUID(),
					expectedSequence: before.sequence,
					command,
				})
			);
			const currentIntent = current === epoch;
			const status = await applyAction(
				action,
				() => !disposed && currentIntent && request === manualEpoch
			);
			if (
				retryFix &&
				status === "ignored" &&
				retryFixRequest === action.requestId &&
				command.kind === "open-center" &&
				command.section === "fixes" &&
				!disposed &&
				current + 1 === epoch &&
				request === manualEpoch
			) {
				retryFixRequest = undefined;
				return performCommand(command, false);
			}
			return status;
		} catch (error) {
			if (!disposed && current === epoch)
				store.setState({
					error:
						error instanceof Error && error.message === WORKSPACE_GITHUB_REQUIRED
							? WORKSPACE_GITHUB_REQUIRED
							: "The workspace change is unavailable. Try again.",
				});
			return "ignored" as const;
		} finally {
			if (!disposed && request === manualEpoch) store.setState({ busy: false });
		}
	}
	async function start() {
		const current = epoch;
		try {
			const observation = WorkspaceObservationSchema.parse(
				await call("query", "workspace.observe", { sessionId })
			);
			if (disposed || current !== epoch) return;
			validateWorkspace(observation.workspace);
			browser.adopt(observation.workspace.browser);
			store.setState({ workspace: observation.workspace, observation, error: "" });
		} catch {
			if (!disposed && current === epoch)
				store.setState({ error: "The workspace is unavailable. Try reopening the app." });
		}
	}
	return {
		store,
		readImage: async (id: string, signal: AbortSignal) => {
			signal.throwIfAborted();
			const result = ImageReadResultSchema.parse(await call("query", "images.read", { id }));
			signal.throwIfAborted();
			return result;
		},
		imageReady: (asset: ImageAsset, ready: boolean) => {
			const key = `${asset.id}:${asset.sha256}`;
			if (ready) {
				readyImages.add(key);
				pending?.images.delete(key);
			} else readyImages.delete(key);
			finishRender();
		},
		start,
		getContext,
		applyAction,
		command,
		rendered,
		presented,
		presentationFailed,
		setManualInteraction: (handler: () => void) => {
			manualInteraction = handler;
		},
		setObscured: (value: boolean) => {
			if (obscured === value) return;
			obscured = value;
			if (value) {
				// Obscuring may be an agent-opened composer, not manual navigation.
				// Reject underlying canvas effects without retiring the presenting turn.
				invalidate();
				store.setState({ busy: false });
				void browser.present(null).catch(() => {});
			}
		},
		dispose: () => {
			if (disposed) return;
			disposed = true;
			invalidate();
			void browser.present(null).catch(() => {});
		},
	};
}
export type WorkspaceController = ReturnType<typeof createWorkspaceController>;
