import { z } from "zod";
import { createStore } from "zustand/vanilla";
import {
	type CodingProvider,
	CodingProviderSchema,
	type CodingProviderSettings,
	type CodingProviderStatus,
	CodingProviderStatusSchema,
} from "../../shared/contracts/coding-provider";
import type { ConversationApi } from "../conversation/api";
import { type CODING_ERRORS, parseCodingSettings, sameSettings } from "./model";

type OperationKind = "status" | "refresh" | "configure" | "login";
export type CodingProviderState = {
	status: CodingProviderStatus | null;
	draft: CodingProviderSettings | null;
	verified: boolean;
	pending: OperationKind | null;
	error: keyof typeof CODING_ERRORS | null;
	notice: string;
};
export type CodingProviderClock = { schedule(callback: () => void, ms: number): () => void };
type Options = { pollIntervalMs?: number; timeoutMs?: number; clock?: CodingProviderClock };
const clock: CodingProviderClock = {
	schedule(callback, ms) {
		const timer = setTimeout(callback, ms);
		return () => clearTimeout(timer);
	},
};
const initial = (): CodingProviderState => ({
	status: null,
	draft: null,
	verified: false,
	pending: null,
	error: null,
	notice: "",
});
type Operation = {
	kind: OperationKind;
	generation: number;
	abort: AbortController;
	timedOut: boolean;
	promise: Promise<CodingProviderStatus | null>;
};

/** Local wait cancellation retires UI observations; it never undoes a main-process configuration. */
export function createCodingProviderController(
	call: ConversationApi["call"],
	options: Options = {}
) {
	const store = createStore<CodingProviderState>(initial);
	const timers = options.clock ?? clock;
	let mounted = false;
	let disposed = false;
	let generation = 0;
	let draftRevision = 0;
	let active: Operation | null = null;
	let cancelPoll: (() => void) | undefined;
	function current(operation: Operation) {
		return !disposed && active === operation && operation.generation === generation;
	}
	function schedulePoll() {
		cancelPoll?.();
		cancelPoll = undefined;
		if (!mounted || disposed || options.pollIntervalMs === 0) return;
		cancelPoll = timers.schedule(() => {
			cancelPoll = undefined;
			void observe();
		}, options.pollIntervalMs ?? 5000);
	}
	function retire() {
		++generation;
		active?.abort.abort();
		active = null;
		cancelPoll?.();
		cancelPoll = undefined;
	}
	function wait<T>(operation: Operation, work: () => Promise<T>): Promise<T> {
		return new Promise((resolve, reject) => {
			const signal = operation.abort.signal;
			const cancelled = () => {
				cleanup();
				reject(new Error("Coding operation retired"));
			};
			const cancelDeadline = timers.schedule(() => {
				operation.timedOut = true;
				operation.abort.abort();
			}, options.timeoutMs ?? 20000);
			const cleanup = () => {
				cancelDeadline();
				signal.removeEventListener("abort", cancelled);
			};
			if (signal.aborted) {
				cancelled();
				return;
			}
			signal.addEventListener("abort", cancelled, { once: true });
			Promise.resolve()
				.then(() => {
					if (!current(operation) || signal.aborted) throw new Error("Coding operation retired");
					return work();
				})
				.then(
					(value) => {
						cleanup();
						resolve(value);
					},
					(error: unknown) => {
						cleanup();
						reject(error);
					}
				);
		});
	}
	function run(
		kind: OperationKind,
		settings?: CodingProviderSettings
	): Promise<CodingProviderStatus | null> {
		if (disposed) return Promise.resolve(null);
		if (active) {
			if (kind === "status" || kind === active.kind) return active.promise;
			if (active.kind !== "status") return Promise.resolve(null);
			retire(); // A saved choice or explicit refresh outranks an older status read.
		}
		const operation: Operation = {
			kind,
			generation: ++generation,
			abort: new AbortController(),
			timedOut: false,
			promise: Promise.resolve(null),
		};
		const revision = draftRevision;
		active = operation;
		cancelPoll?.();
		cancelPoll = undefined;
		store.setState({
			pending: kind,
			error: null,
			notice: "",
			...(kind !== "status" ? { verified: false } : {}),
		});
		operation.promise = (async () => {
			try {
				if (kind === "login") {
					z.void().parse(
						await wait(operation, () => call("mutation", "codingProvider.openLogin", {}))
					);
					if (current(operation))
						store.setState({
							notice:
								"Sign-in was requested. Continue in the official Muse Code flow, then refresh status.",
						});
					return null;
				}
				const raw = await wait(operation, () =>
					kind === "configure"
						? call("mutation", "codingProvider.configure", settings)
						: call(
								kind === "status" ? "query" : "mutation",
								kind === "status" ? "codingProvider.status" : "codingProvider.refresh",
								{}
							)
				);
				if (!current(operation)) return null;
				const status = CodingProviderStatusSchema.parse(raw);
				if (!sameSettings(status.settings, parseCodingSettings(status.settings)))
					throw new Error("Invalid saved coding settings");
				if (kind === "configure" && (!settings || !sameSettings(settings, status.settings)))
					throw new Error("Saved coding provider does not match the explicit selection");
				const state = store.getState();
				const keepDraft =
					revision !== draftRevision ||
					(kind !== "configure" &&
						state.draft !== null &&
						state.status !== null &&
						!sameSettings(state.draft, state.status.settings));
				store.setState({
					status,
					verified: true,
					...(!keepDraft ? { draft: { ...status.settings } } : {}),
					...(kind === "configure" ? { notice: "Coding provider selection saved." } : {}),
				});
				return status;
			} catch {
				if (current(operation))
					store.setState({
						verified: false,
						error: operation.timedOut
							? "timeout"
							: kind === "configure"
								? "configure"
								: kind === "login"
									? "login"
									: "status",
					});
				return null;
			} finally {
				if (current(operation)) {
					active = null;
					store.setState({ pending: null });
					schedulePoll();
				}
			}
		})();
		return operation.promise;
	}
	function observe() {
		return run("status");
	}
	function setProvider(provider: CodingProvider) {
		if (disposed || !store.getState().draft) return;
		CodingProviderSchema.parse(provider);
		draftRevision++;
		store.setState((state) => ({
			draft: state.draft ? { ...state.draft, provider } : null,
			error: null,
			notice: "",
		}));
	}
	function setMusePath(path: string) {
		if (disposed || !store.getState().draft) return;
		draftRevision++;
		store.setState((state) => ({
			draft: state.draft ? { ...state.draft, musePath: path.trim() ? path : null } : null,
			error: null,
			notice: "",
		}));
	}
	function save() {
		const draft = store.getState().draft;
		if (!draft || disposed) return Promise.resolve(null);
		let settings: CodingProviderSettings;
		try {
			settings = parseCodingSettings(draft);
		} catch {
			store.setState({ error: "path" });
			return Promise.resolve(null);
		}
		return run("configure", settings);
	}
	function canOpenLogin() {
		const state = store.getState();
		return (
			!disposed &&
			state.verified &&
			!state.pending &&
			state.status?.settings.provider === "muse-code" &&
			state.status.museCode.installed &&
			state.status.museCode.error !== "unsupported-cli" &&
			sameSettings(state.draft, state.status.settings)
		);
	}
	function stop() {
		mounted = false;
		retire();
		store.setState({ pending: null, verified: false });
	}
	return {
		store,
		observe,
		refresh: () => run("refresh"),
		setProvider,
		setMusePath,
		save,
		canOpenLogin,
		openLogin: () => (canOpenLogin() ? run("login") : Promise.resolve(null)),
		start() {
			if (disposed) return Promise.resolve(null);
			mounted = true;
			return observe();
		},
		stop,
		reset() {
			stop();
			draftRevision++;
			store.setState(initial());
		},
		dispose() {
			stop();
			disposed = true;
		},
	};
}
export type CodingProviderController = ReturnType<typeof createCodingProviderController>;
