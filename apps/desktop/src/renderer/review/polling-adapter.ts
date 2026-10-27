import {
	type AgentTurnInput,
	type PollTurn,
	PollTurnResultSchema,
	type TurnIdentity,
} from "../../shared/contracts";
import { reviewErrorMessage } from "./errors";
import type { AgentAdapter } from "./services";

export type AgentPollingPorts = Omit<AgentAdapter, "ask"> & {
	start: (input: AgentTurnInput) => Promise<TurnIdentity>;
	poll: (input: PollTurn) => Promise<unknown>;
};

function sameTurn(a: TurnIdentity, b: TurnIdentity) {
	return a.sessionId === b.sessionId && a.turnId === b.turnId && a.generation === b.generation;
}
function pause(ms: number, signal: AbortSignal) {
	signal.throwIfAborted();
	return new Promise<void>((resolve, reject) => {
		const finish = () => {
			signal.removeEventListener("abort", aborted);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		const aborted = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", aborted);
			reject(signal.reason);
		};
		signal.addEventListener("abort", aborted, { once: true });
	});
}

/** The composition layer supplies typed IPC procedures; no process wiring is owned here. */
export function createPollingAgentAdapter(
	ports: AgentPollingPorts,
	pollIntervalMs = 150
): AgentAdapter {
	return {
		...ports,
		async ask(input, observer, signal) {
			signal.throwIfAborted();
			const started = await ports.start(input);
			signal.throwIfAborted();
			if (!sameTurn(input, started)) throw new Error("Unexpected started turn");
			let cursor = 0;
			const applied = new Set<string>();
			const identity = {
				sessionId: input.sessionId,
				turnId: input.turnId,
				generation: input.generation,
			};
			while (!signal.aborted) {
				const result = PollTurnResultSchema.parse(
					await ports.poll({ ...identity, afterSequence: cursor, limit: 100 })
				);
				signal.throwIfAborted();
				if (!sameTurn(input, result) || result.status === "stale")
					throw new Error("Turn is no longer available");
				if (result.sequence < cursor) throw new Error("Turn sequence regressed");
				const events = result.events.filter((event) => event.sequence > cursor);
				const compacted =
					(events[0] && events[0].sequence > cursor + 1) ||
					(!events.length && result.sequence > cursor);
				if (compacted) {
					observer.replaceText(result.text);
					for (const action of result.actions) {
						signal.throwIfAborted();
						if (!applied.has(action.requestId)) {
							await observer.action(action);
							applied.add(action.requestId);
						}
					}
					cursor = result.sequence;
				} else {
					for (const event of events) {
						signal.throwIfAborted();
						if (event.kind === "text-delta") observer.text(event.delta);
						if (event.kind === "action" && !applied.has(event.action.requestId)) {
							await observer.action(event.action);
							applied.add(event.action.requestId);
						}
						cursor = event.sequence;
					}
					if (cursor === result.sequence) observer.replaceText(result.text);
				}
				if (cursor < result.sequence) continue;
				if (result.status === "completed") return;
				if (result.status === "error") {
					const errorEvent = result.events.find((event) => event.kind === "error");
					throw new Error(
						reviewErrorMessage(
							errorEvent?.kind === "error" ? errorEvent.message : "Check model credentials"
						)
					);
				}
				if (result.status === "cancelled") throw new DOMException("Turn cancelled", "AbortError");
				await pause(pollIntervalMs, signal);
			}
			signal.throwIfAborted();
		},
	};
}
