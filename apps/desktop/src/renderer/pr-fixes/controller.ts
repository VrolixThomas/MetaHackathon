import { z } from "zod";
import { createStore } from "zustand/vanilla";
import {
	IdSchema,
	type PRFixDetail,
	PRFixDetailSchema,
	PRFixReviewInputSchema,
	type PRFixStartInput,
	PRFixStartInputSchema,
	type PRFixSummary,
	PRFixSummarySchema,
	decodePRFixViewTarget,
	encodePRFixViewTarget,
} from "../../shared/contracts";
import type { ConversationApi } from "../conversation/api";
import { fixSourceKey, loadedReviewMatchesFix, validateDetail, validateFix } from "./model";

export type PRFixState = {
	items: PRFixSummary[];
	listLoaded: boolean;
	listLoading: boolean;
	error: string;
	target: string | null;
	loadedTarget: string | null;
	selectedPath: string | null;
	detail: PRFixDetail | null;
	detailLoading: boolean;
	detailError: string;
	busy: boolean;
};
const initial = (): PRFixState => ({
	items: [],
	listLoaded: false,
	listLoading: false,
	error: "",
	target: null,
	loadedTarget: null,
	selectedPath: null,
	detail: null,
	detailLoading: false,
	detailError: "",
	busy: false,
});
type StartInput = Omit<PRFixStartInput, "requestId"> & { requestId?: string };
export type PRFixOptions = {
	actor?: () => string | null;
	pollInterval?: number;
	requestId?: () => string;
};

/** IPC observations only. Main owns fresh source authorization and durable worker lifetime. */
export function createPRFixController(call: ConversationApi["call"], options: PRFixOptions = {}) {
	const store = createStore<PRFixState>(initial);
	let disposed = false;
	let epoch = 0;
	let listVersion = 0;
	let detailVersion = 0;
	let started = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let actor = options.actor?.();
	let listing: Promise<void> | undefined;
	let reading: { id: string; promise: Promise<void> } | undefined;
	const starts = new Map<string, string>();
	const retired = () => new Error("This fix read was retired. Reopen it from the current account.");
	function reset() {
		epoch++;
		listVersion++;
		detailVersion++;
		clearTimeout(timer);
		started = false;
		listing = undefined;
		reading = undefined;
		starts.clear();
		actor = options.actor?.();
		store.setState(initial());
	}
	function capture() {
		if (disposed) throw retired();
		if (options.actor && options.actor() !== actor) {
			reset();
			throw retired();
		}
		return epoch;
	}
	function live(operation: number) {
		if (disposed || operation !== epoch) return false;
		if (options.actor && options.actor() !== actor) {
			reset();
			return false;
		}
		return true;
	}
	function checkedSummary(raw: unknown) {
		return validateFix(PRFixSummarySchema.parse(raw));
	}
	function checkPrevious(next: PRFixSummary, previous?: PRFixSummary) {
		if (previous && fixSourceKey(previous) !== fixSourceKey(next))
			throw new Error("The fix's original source changed");
		if (previous && next.updatedAt < previous.updatedAt) throw new Error("Stale fix observation");
	}
	function adopt(next: PRFixSummary) {
		const state = store.getState();
		checkPrevious(
			next,
			state.items.find((item) => item.id === next.id)
		);
		store.setState({
			items: [...state.items.filter((item) => item.id !== next.id), next].sort((a, b) =>
				b.updatedAt.localeCompare(a.updatedAt)
			),
		});
	}
	function pollList(): Promise<void> {
		let operation: number;
		try {
			operation = capture();
		} catch {
			return Promise.resolve();
		}
		if (listing) return listing;
		const version = ++listVersion;
		store.setState({ listLoading: true });
		const promise = (async () => {
			try {
				const items = z
					.array(PRFixSummarySchema)
					.max(1000)
					.parse(
						await Promise.resolve().then(() => {
							if (!live(operation)) throw retired();
							return call("query", "prFixes.list", {});
						})
					)
					.map(validateFix);
				if (!live(operation) || version !== listVersion) return;
				if (new Set(items.map((item) => item.id)).size !== items.length)
					throw new Error("Duplicate fix identity");
				for (const item of items)
					checkPrevious(
						item,
						store.getState().items.find((previous) => previous.id === item.id)
					);
				const detail = store.getState().detail;
				const current = detail && items.find((item) => item.id === detail.fix.id);
				const invalidated =
					!!detail &&
					(!current ||
						current.headSha !== detail.fix.headSha ||
						current.updatedAt !== detail.fix.updatedAt);
				store.setState({
					items,
					listLoaded: true,
					error: "",
					...(invalidated
						? {
								detail: null,
								loadedTarget: null,
								selectedPath: null,
							}
						: {}),
				});
			} catch {
				if (live(operation) && version === listVersion)
					store.setState({
						error: "Suggested fixes could not be refreshed. Check the source connection and retry.",
						detail: null,
						loadedTarget: null,
						selectedPath: null,
					});
			} finally {
				if (live(operation) && version === listVersion) {
					listing = undefined;
					store.setState({ listLoading: false });
				}
			}
		})();
		listing = promise;
		return promise;
	}
	function readDetail(target: string, quiet = false): Promise<void> {
		const operation = capture();
		const { id, path } = decodePRFixViewTarget(target);
		if (encodePRFixViewTarget({ id, path }) !== target) throw new Error("Noncanonical fix target");
		if (reading?.id === target) {
			if (!quiet)
				store.setState({
					target,
					detail: null,
					loadedTarget: null,
					selectedPath: null,
					detailLoading: true,
				});
			return reading.promise;
		}
		const version = ++detailVersion;
		store.setState({
			target,
			detailError: "",
			...(quiet
				? {}
				: {
						detail: null,
						loadedTarget: null,
						selectedPath: null,
						detailLoading: true,
					}),
		});
		const promise = (async () => {
			try {
				const detail = validateDetail(
					PRFixDetailSchema.parse(
						await Promise.resolve().then(() => {
							if (!live(operation)) throw retired();
							return call("query", "prFixes.detail", { id });
						})
					)
				);
				if (!live(operation) || version !== detailVersion || store.getState().target !== target)
					throw retired();
				if (detail.fix.id !== id) throw new Error("Wrong fix returned");
				if (path && !detail.review?.files.some((file) => file.path === path))
					throw new Error("Candidate file not found");
				checkPrevious(
					detail.fix,
					store.getState().items.find((item) => item.id === id)
				);
				adopt(detail.fix);
				const previous = store.getState().detail;
				store.setState({
					detail:
						previous && JSON.stringify(previous) === JSON.stringify(detail) ? previous : detail,
					loadedTarget: target,
					selectedPath: path ?? detail.review?.files[0]?.path ?? null,
					detailError: "",
				});
			} catch (error) {
				if (live(operation) && version === detailVersion)
					store.setState({
						detail: null,
						loadedTarget: null,
						selectedPath: null,
						detailError:
							"This candidate could not be loaded at its exact source revisions. Refresh to retry.",
					});
				throw error;
			} finally {
				if (live(operation) && version === detailVersion) reading = undefined;
				if (live(operation) && version === detailVersion) store.setState({ detailLoading: false });
			}
		})();
		reading = { id: target, promise };
		return promise;
	}
	async function poll() {
		let operation: number;
		try {
			operation = capture();
		} catch {
			return;
		}
		await pollList();
		if (!live(operation)) return;
		const target = store.getState().target;
		if (target) await readDetail(target, true).catch(() => {});
	}
	function schedule() {
		if (!started || disposed || options.pollInterval === 0) return;
		timer = setTimeout(() => {
			void poll().finally(schedule);
		}, options.pollInterval ?? 3000);
	}
	async function prepare(input: StartInput): Promise<PRFixSummary | null> {
		let operation: number;
		try {
			operation = capture();
		} catch {
			return null;
		}
		if (store.getState().busy) return null;
		const key = JSON.stringify([input.prId, input.feedbackId]);
		const requestId =
			input.requestId ?? starts.get(key) ?? options.requestId?.() ?? crypto.randomUUID();
		const request = PRFixStartInputSchema.parse({ ...input, requestId });
		starts.set(key, requestId);
		store.setState({ busy: true, error: "" });
		try {
			if (!live(operation)) return null;
			const result = checkedSummary(await call("mutation", "prFixes.start", request));
			if (!live(operation)) return null;
			if (result.pr.id !== request.prId || result.feedback.id !== request.feedbackId)
				throw new Error("Fix admission identity mismatch");
			++listVersion;
			listing = undefined;
			adopt(result);
			// Main may return an existing canonical candidate for this exact source.
			// Once admission is known, a later user action may start a fresh attempt.
			starts.delete(key);
			store.setState({ listLoaded: true, listLoading: false });
			return result;
		} catch {
			if (live(operation))
				store.setState({
					error:
						"Fix preparation was not confirmed. Refresh before retrying; the same request ID is retained.",
				});
			return null;
		} finally {
			if (live(operation)) store.setState({ busy: false });
		}
	}
	function start(): Promise<void>;
	function start(input: StartInput): Promise<PRFixSummary | null>;
	function start(input?: StartInput): Promise<void> | Promise<PRFixSummary | null> {
		return input ? prepare(input) : beginPolling();
	}
	async function beginPolling() {
		if (disposed || started) return;
		try {
			capture();
		} catch {
			return;
		}
		started = true;
		await poll();
		schedule();
	}
	async function markReviewed(id: string, headSha: string): Promise<PRFixSummary | null> {
		let operation: number;
		try {
			operation = capture();
		} catch {
			return null;
		}
		const state = store.getState();
		const detail = state.detail;
		if (
			state.busy ||
			state.detailLoading ||
			state.loadedTarget !== state.target ||
			!loadedReviewMatchesFix(detail) ||
			!detail?.review?.files.length ||
			!detail ||
			detail.fix.id !== id ||
			detail.fix.headSha !== headSha ||
			detail.fix.phase !== "ready"
		)
			return null;
		const input = PRFixReviewInputSchema.parse({ id, headSha, confirmed: true });
		store.setState({ busy: true, error: "" });
		try {
			if (!live(operation)) return null;
			const result = checkedSummary(await call("mutation", "prFixes.reviewed", input));
			if (!live(operation)) return null;
			checkPrevious(result, detail.fix);
			if (result.id !== id || result.headSha !== headSha || !result.reviewedAt)
				throw new Error("Review receipt mismatch");
			++listVersion;
			listing = undefined;
			adopt(result);
			if (store.getState().detail === detail)
				store.setState({ detail: { ...detail, fix: result } });
			return result;
		} catch {
			if (live(operation))
				store.setState({
					error:
						"The local review marker was not confirmed. Refresh and inspect the current candidate.",
				});
			return null;
		} finally {
			if (live(operation)) store.setState({ busy: false, listLoading: false });
		}
	}
	async function cancel(id: string) {
		let operation: number;
		try {
			operation = capture();
		} catch {
			return;
		}
		if (store.getState().busy) return;
		IdSchema.max(200).parse(id);
		store.setState({ busy: true, error: "" });
		try {
			if (!live(operation)) return;
			z.void().parse(await call("mutation", "prFixes.cancel", { id }));
			if (!live(operation)) return;
			await poll();
		} catch {
			if (live(operation))
				store.setState({
					error: "Cancellation was not confirmed. Refresh to check the candidate's actual state.",
				});
		} finally {
			if (live(operation)) store.setState({ busy: false });
		}
	}
	return {
		store,
		start,
		prepare,
		poll,
		reset,
		ensureTarget: async (id: string) => readDetail(id),
		markReviewed,
		cancel,
		dispose() {
			reset();
			disposed = true;
		},
	};
}
export type PRFixController = ReturnType<typeof createPRFixController>;
