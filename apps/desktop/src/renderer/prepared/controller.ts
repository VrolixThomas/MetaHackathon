import { createStore } from "zustand/vanilla";
import {
	type AgentAction,
	AgentActionSchema,
	type CodeLocation,
	GitHubRepositorySchema,
	type PreparedReview,
	type ReviewDetail,
	ReviewDetailSchema,
	type ReviewFile,
	ReviewFileSchema,
	type ReviewInbox,
	ReviewProgressSchema,
	type ReviewScreen,
	ReviewScreenSchema,
} from "../../shared/contracts";
import type { PreparedApi } from "./api";

export function createPreparedController(api: PreparedApi, sessionId: string, pollInterval = 2000) {
	const store = createStore<{
		inbox: ReviewInbox | null;
		busy: boolean;
		error: string;
		detail: ReviewDetail | null;
		file: ReviewFile | null;
		fileBusy: boolean;
		paused: boolean;
		stale: boolean;
		reviewError: string;
		highlight: CodeLocation | null;
		screen: ReviewScreen;
	}>(() => ({
		inbox: null,
		busy: false,
		error: "",
		detail: null,
		file: null,
		fileBusy: false,
		paused: false,
		stale: false,
		reviewError: "",
		highlight: null,
		screen: { sequence: 0, mode: "conversation", prId: null },
	}));
	let disposed = false;
	let epoch = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let active = false;
	let navigationEpoch = 0;
	let inboxRead = 0;
	let progressQueue: Promise<unknown> = Promise.resolve();
	const deliveries = new Map<string, Promise<"applied" | "ignored">>();
	const currentScreen = () => ReviewScreenSchema.parse(store.getState().screen);
	function screen(next: Omit<ReviewScreen, "sequence"> = store.getState().screen) {
		const value = ReviewScreenSchema.parse({
			...next,
			...(next.mode === "review" ? { paused: store.getState().paused } : {}),
			sequence: store.getState().screen.sequence + 1,
		});
		store.setState({ screen: value });
		return value;
	}
	async function publishScreen() {
		await api.screen(sessionId, currentScreen());
	}
	function planScreen(plan: PreparedReview, path?: string): Omit<ReviewScreen, "sequence"> {
		return {
			mode: "review",
			prId: plan.pr.id,
			reviewId: plan.id,
			baseSha: plan.pr.baseSha,
			headSha: plan.pr.headSha,
			...(path ? { path } : {}),
		};
	}
	function samePlan(plan: PreparedReview) {
		const current = store.getState();
		return (
			!disposed &&
			!current.stale &&
			current.detail?.prepared?.id === plan.id &&
			current.detail.pr.id === plan.pr.id &&
			current.detail.pr.baseSha === plan.pr.baseSha &&
			current.detail.pr.headSha === plan.pr.headSha
		);
	}
	function validateDetail(input: ReviewDetail, prId: string) {
		const detail = ReviewDetailSchema.parse(input);
		const plan = detail.prepared;
		if (
			detail.pr.id !== prId ||
			!plan ||
			detail.status !== "ready" ||
			plan.pr.id !== prId ||
			plan.pr.repository !== detail.pr.repository ||
			plan.pr.baseSha !== detail.pr.baseSha ||
			plan.pr.headSha !== detail.pr.headSha
		)
			throw new Error("Review is not ready at this revision");
		const progress = detail.progress;
		if (
			progress &&
			(progress.reviewId !== plan.id ||
				progress.prId !== prId ||
				progress.baseSha !== plan.pr.baseSha ||
				progress.headSha !== plan.pr.headSha ||
				(progress.path && !plan.files.some((file) => file.path === progress.path)))
		)
			detail.progress = null;
		return detail;
	}
	function validateFile(
		input: ReviewFile,
		plan: PreparedReview,
		path: string,
		highlight?: CodeLocation
	) {
		const file = ReviewFileSchema.parse(input);
		if (
			file.prId !== plan.pr.id ||
			file.path !== path ||
			file.base.path !== path ||
			file.head.path !== path ||
			file.base.commitSha !== plan.pr.baseSha ||
			file.head.commitSha !== plan.pr.headSha
		)
			throw new Error("Source revision mismatch");
		for (const side of [file.base, file.head])
			if ((side.status === "available") !== (side.content !== null))
				throw new Error("Unavailable source content mismatch");
		if (highlight) {
			const source = file[highlight.revision];
			const lines = source.content ? source.content.replace(/\n$/, "").split("\n").length : 0;
			if (
				highlight.repository !== plan.pr.repository ||
				highlight.path !== path ||
				highlight.commitSha !== source.commitSha ||
				highlight.endLine > lines
			)
				throw new Error("Highlight outside pinned source");
		}
		return file;
	}
	function persist(plan: PreparedReview, path: string, paused: boolean) {
		const save = progressQueue
			.catch(() => {})
			.then(() => api.progress({ prId: plan.pr.id, reviewId: plan.id, path, paused }))
			.then((input) => {
				const value = ReviewProgressSchema.parse(input);
				if (
					value.prId !== plan.pr.id ||
					value.reviewId !== plan.id ||
					value.baseSha !== plan.pr.baseSha ||
					value.headSha !== plan.pr.headSha ||
					value.path !== path ||
					value.paused !== paused
				)
					throw new Error("Progress revision mismatch");
				if (
					samePlan(plan) &&
					store.getState().file?.path === path &&
					store.getState().paused === paused
				)
					store.setState((state) => ({
						detail: state.detail ? { ...state.detail, progress: value } : null,
					}));
				return value;
			});
		progressQueue = save;
		return save;
	}
	function installFile(
		plan: PreparedReview,
		file: ReviewFile,
		paused: boolean,
		highlight?: CodeLocation
	) {
		store.setState({
			file,
			fileBusy: false,
			paused,
			highlight: highlight ?? null,
			reviewError: "",
		});
		screen(planScreen(plan, file.path));
	}
	async function showPath(path: string) {
		const state = store.getState();
		const plan = state.detail?.prepared;
		if (!plan || state.stale || !plan.files.some((file) => file.path === path)) return;
		const operation = ++navigationEpoch;
		screen();
		void publishScreen().catch(() => {});
		store.setState({ fileBusy: true, reviewError: "" });
		try {
			const file = validateFile(
				await api.file({ prId: plan.pr.id, reviewId: plan.id, path }),
				plan,
				path
			);
			if (operation !== navigationEpoch || !samePlan(plan)) return;
			installFile(plan, file, state.paused);
			await publishScreen();
			await persist(plan, path, state.paused);
		} catch {
			if (!disposed && operation === navigationEpoch)
				store.setState({
					reviewError:
						"Could not load or save this review position. Refresh the review and try again.",
				});
		} finally {
			if (!disposed && operation === navigationEpoch) store.setState({ fileBusy: false });
		}
	}
	async function open(prId: string) {
		const operation = ++navigationEpoch;
		store.setState({
			detail: null,
			file: null,
			fileBusy: true,
			stale: false,
			reviewError: "",
			highlight: null,
		});
		screen({ mode: "review", prId });
		void publishScreen().catch(() => {});
		try {
			const detail = validateDetail(await api.get(prId), prId);
			if (disposed || operation !== navigationEpoch) return;
			store.setState({ detail, paused: detail.progress?.paused ?? false });
			const plan = detail.prepared;
			if (!plan) return;
			screen(planScreen(plan));
			const path = detail.progress?.path ?? plan.files[0]?.path;
			if (path) await showPath(path);
			else await publishScreen();
		} catch {
			if (!disposed && operation === navigationEpoch)
				store.setState({
					reviewError:
						"The prepared review is unavailable or has changed. Refresh the inbox and reopen it.",
				});
		} finally {
			if (!disposed && operation === navigationEpoch) store.setState({ fileBusy: false });
		}
	}
	function close() {
		navigationEpoch++;
		store.setState({
			detail: null,
			file: null,
			fileBusy: false,
			stale: false,
			reviewError: "",
			highlight: null,
		});
		screen({ mode: "conversation", prId: null });
		void publishScreen().catch(() => {});
	}
	async function pause(paused: boolean) {
		const state = store.getState();
		const plan = state.detail?.prepared;
		if (!plan || !state.file || state.stale || state.fileBusy) return;
		navigationEpoch++;
		store.setState({ paused });
		screen();
		try {
			await publishScreen();
			await persist(plan, state.file.path, paused);
		} catch {
			if (samePlan(plan))
				store.setState({ reviewError: "Your position could not be saved. Try again." });
		}
	}
	function applyAction(
		input: AgentAction,
		live: () => boolean,
		signal?: AbortSignal
	): Promise<"applied" | "ignored"> {
		const action = AgentActionSchema.parse(input);
		const key = JSON.stringify([
			action.sessionId,
			action.turnId,
			action.generation,
			action.requestId,
		]);
		const previous = deliveries.get(key);
		if (previous) return previous;
		const work = Promise.resolve().then(async () => {
			let status: "applied" | "ignored" = "ignored";
			const before = store.getState();
			const plan = before.detail?.prepared;
			if (
				action.kind === "review-navigation" &&
				action.sessionId === sessionId &&
				live() &&
				plan &&
				!before.stale &&
				!before.fileBusy &&
				action.screenSequence === before.screen.sequence
			) {
				const nav = action.navigation;
				if (
					nav.prId === plan.pr.id &&
					nav.reviewId === plan.id &&
					nav.baseSha === plan.pr.baseSha &&
					nav.headSha === plan.pr.headSha &&
					plan.files.some((file) => file.path === nav.path)
				) {
					const operation = ++navigationEpoch;
					const interrupted = () => {
						if (!disposed && operation === navigationEpoch) {
							navigationEpoch++;
							store.setState({ fileBusy: false });
						}
					};
					signal?.addEventListener("abort", interrupted, { once: true });
					store.setState({ fileBusy: true });
					try {
						const file = validateFile(
							await api.file({ prId: nav.prId, reviewId: nav.reviewId, path: nav.path }),
							plan,
							nav.path,
							nav.highlight
						);
						if (
							live() &&
							samePlan(plan) &&
							operation === navigationEpoch &&
							store.getState().screen.sequence === before.screen.sequence
						) {
							installFile(plan, file, nav.paused, nav.highlight);
							const settledSequence = store.getState().screen.sequence;
							await persist(plan, file.path, nav.paused);
							if (
								live() &&
								samePlan(plan) &&
								operation === navigationEpoch &&
								store.getState().screen.sequence === settledSequence
							)
								status = "applied";
						}
					} catch {
						if (!disposed && live() && operation === navigationEpoch)
							store.setState({
								reviewError:
									"The guided navigation could not complete. Try again after refreshing the review.",
							});
					} finally {
						signal?.removeEventListener("abort", interrupted);
						if (!disposed && operation === navigationEpoch) store.setState({ fileBusy: false });
					}
				}
			}
			if (live() && action.sessionId === sessionId) screen();
			await api.actionApplied({
				sessionId: action.sessionId,
				turnId: action.turnId,
				generation: action.generation,
				requestId: action.requestId,
				status,
				screen: currentScreen(),
			});
			return status;
		});
		deliveries.set(key, work);
		if (deliveries.size > 400) {
			const oldest = deliveries.keys().next().value;
			if (oldest) deliveries.delete(oldest);
		}
		return work;
	}
	function acceptInbox(inbox: ReviewInbox) {
		const current = store.getState();
		if (
			current.inbox &&
			(current.inbox.repository !== inbox.repository || current.inbox.localPath !== inbox.localPath)
		)
			close();
		const detail = store.getState().detail;
		const item = detail && inbox.items.find((entry) => entry.pr.id === detail.pr.id);
		if (
			!current.stale &&
			detail &&
			item &&
			(item.pr.baseSha !== detail.pr.baseSha ||
				item.pr.headSha !== detail.pr.headSha ||
				(item.prepared && item.prepared.id !== detail.prepared?.id))
		) {
			navigationEpoch++;
			store.setState({
				stale: true,
				paused: true,
				fileBusy: false,
				reviewError: "This pull request changed. Reopen its prepared review from the inbox.",
			});
			screen();
			void publishScreen().catch(() => {});
		}
		store.setState({ inbox });
	}
	function schedule() {
		clearTimeout(timer);
		if (active && !disposed) timer = setTimeout(() => void poll(), pollInterval);
	}
	async function poll() {
		if (disposed || store.getState().busy) {
			schedule();
			return;
		}
		const current = epoch;
		const read = ++inboxRead;
		try {
			const inbox = await api.inbox();
			if (!disposed && current === epoch && read === inboxRead && !store.getState().busy) {
				acceptInbox(inbox);
				store.setState({ error: "" });
			}
		} catch {
			if (!disposed && current === epoch)
				store.setState({ error: "The repository inbox is unavailable. Try Refresh." });
		} finally {
			schedule();
		}
	}
	async function change(work: () => Promise<ReviewInbox>) {
		if (store.getState().busy || disposed) return;
		const current = ++epoch;
		store.setState({ busy: true, error: "" });
		try {
			const inbox = await work();
			if (!disposed && current === epoch) acceptInbox(inbox);
		} catch {
			if (!disposed && current === epoch)
				store.setState({
					error: "Could not update the repository inbox. Check GitHub access and try again.",
				});
		} finally {
			if (!disposed && current === epoch) store.setState({ busy: false });
			schedule();
		}
	}
	return {
		store,
		sessionId,
		open,
		close,
		showPath,
		pause,
		applyAction,
		getContext: () => {
			const value = store.getState().screen;
			return value.prId ? { prId: value.prId, screen: currentScreen() } : {};
		},
		move: (delta: number) => {
			const state = store.getState();
			const files = state.detail?.prepared?.files ?? [];
			const index = files.findIndex((file) => file.path === state.file?.path);
			const next = files[index + delta];
			if (next) return showPath(next.path);
		},
		start: () => {
			active = true;
			void poll();
		},
		poll,
		connect: (input: string) => {
			const parsed = GitHubRepositorySchema.safeParse(input.trim());
			if (!parsed.success) {
				store.setState({ error: "Enter a GitHub repository as owner/repo." });
				return Promise.resolve();
			}
			return change(() => api.connect(parsed.data));
		},
		chooseRepository: () =>
			change(async () => {
				const chosen = await api.chooseRepository();
				return chosen ? api.connect(chosen.repository, chosen.localPath) : api.inbox();
			}),
		refresh: () => change(() => api.refresh()),
		prepare: (prId: string) =>
			change(async () => {
				await api.prepare(prId);
				return api.inbox();
			}),
		dispose: () => {
			disposed = true;
			navigationEpoch++;
			active = false;
			epoch++;
			clearTimeout(timer);
		},
	};
}
export type PreparedController = ReturnType<typeof createPreparedController>;
