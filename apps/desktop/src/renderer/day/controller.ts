import { createStore } from "zustand/vanilla";
import type { DayOperation, DayOperationResult, DaySnapshot } from "../../shared/contracts/day";

/** The API validates shared schemas; the controller never manufactures items or worker state. */
export interface DayApi {
	snapshot(): Promise<DaySnapshot>;
	operate(operation: DayOperation): Promise<DayOperationResult>;
}

export const DAY_LOAD_ERROR = "Your day could not be refreshed. Retry to check your saved work.";
export const DAY_ACTION_ERROR =
	"The action could not be confirmed. Refresh to check its saved state.";

export function createDayController(api: DayApi, options: { pollIntervalMs?: number } = {}) {
	const store = createStore<{
		snapshot: DaySnapshot | null;
		loading: boolean;
		busy: boolean;
		error: string;
	}>(() => ({ snapshot: null, loading: false, busy: false, error: "" }));
	let disposed = false;
	let started = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let reading: Promise<void> | undefined;
	let active: Promise<DayOperationResult | null> | undefined;
	let mutationEpoch = 0;

	function adopt(snapshot: DaySnapshot) {
		if (disposed) return;
		const previous = store.getState().snapshot;
		if (!previous || snapshot.sequence > previous.sequence) store.setState({ snapshot });
	}
	function schedule() {
		clearTimeout(timer);
		if (!started || disposed) return;
		timer = setTimeout(() => void refresh(), options.pollIntervalMs ?? 3000);
	}
	function refresh(): Promise<void> {
		if (disposed) return Promise.resolve();
		if (reading) return reading;
		clearTimeout(timer);
		const epoch = mutationEpoch;
		const duringMutation = !!active;
		store.setState({ loading: true });
		// Defer the call so reading is installed even if an injected API throws synchronously.
		reading = Promise.resolve()
			.then(() => api.snapshot())
			.then((snapshot) => {
				if (disposed) return;
				adopt(snapshot);
				if (epoch === mutationEpoch && !duringMutation && !active) store.setState({ error: "" });
			})
			.catch(() => {
				if (!disposed && epoch === mutationEpoch && !duringMutation && !active)
					store.setState({ error: DAY_LOAD_ERROR });
			})
			.finally(() => {
				reading = undefined;
				if (!disposed) {
					store.setState({ loading: false });
					schedule();
				}
			});
		return reading;
	}
	async function start() {
		if (disposed || started) return;
		started = true;
		await refresh();
	}
	function operate(operation: DayOperation): Promise<DayOperationResult | null> {
		if (disposed || active) return Promise.resolve(null);
		mutationEpoch++;
		store.setState({ busy: true, error: "" });
		active = Promise.resolve()
			.then(() => api.operate(operation))
			.then((result) => {
				if (disposed) return null;
				adopt(result.snapshot);
				return result;
			})
			.catch(() => {
				if (!disposed) store.setState({ error: DAY_ACTION_ERROR });
				return null;
			})
			.finally(() => {
				active = undefined;
				if (!disposed) store.setState({ busy: false });
			});
		return active;
	}
	return {
		store,
		start,
		refresh,
		operate,
		dispose() {
			disposed = true;
			started = false;
			clearTimeout(timer);
		},
	};
}
export type DayController = ReturnType<typeof createDayController>;
