import { createStore } from "zustand/vanilla";
import { GitHubRepositorySchema, type ReviewInbox } from "../../shared/contracts";
import type { PreparedApi } from "./api";

export function createPreparedController(api: PreparedApi, sessionId: string, pollInterval = 2000) {
	const store = createStore<{ inbox: ReviewInbox | null; busy: boolean; error: string }>(() => ({
		inbox: null,
		busy: false,
		error: "",
	}));
	let disposed = false;
	let epoch = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let active = false;
	function schedule() {
		clearTimeout(timer);
		if (active && !disposed) timer = setTimeout(() => void poll(), pollInterval);
	}
	async function poll() {
		if (disposed) return;
		const current = epoch;
		try {
			const inbox = await api.inbox();
			if (!disposed && current === epoch) store.setState({ inbox, error: "" });
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
			if (!disposed && current === epoch) store.setState({ inbox });
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
		refresh: () => change(() => api.refresh()),
		prepare: (prId: string) =>
			change(async () => {
				await api.prepare(prId);
				return api.inbox();
			}),
		dispose: () => {
			disposed = true;
			active = false;
			epoch++;
			clearTimeout(timer);
		},
	};
}
export type PreparedController = ReturnType<typeof createPreparedController>;
