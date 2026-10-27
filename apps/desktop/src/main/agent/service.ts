import { z } from "zod";
import {
	type AgentAction,
	type AgentActionReceipt,
	type AgentActionReceiptResult,
	AgentActionReceiptSchema,
	AgentTurnInputSchema,
	type AgentTurnStatus,
	CancelTurnInputSchema,
	CancelTurnResultSchema,
	IdSchema,
	PollTurnResultSchema,
	PollTurnSchema,
	type ScreenContext,
} from "../../shared/contracts";
import { ActionReceiptError } from "./action-receipts";
import { type AgentEvent, AgentEventSchema } from "./events";
import type { AgentModelClient } from "./meta-client";
import { type AgentPorts, runToolLoop } from "./tool-loop";

// Workload is a local execution preference; turn identity and polling use MET-8 contracts.
export const StartTurnSchema = AgentTurnInputSchema.extend({
	workload: z.enum(["quick", "deep"]).default("quick"),
});
export type StartTurn = z.infer<typeof StartTurnSchema>;
export { PollTurnSchema } from "../../shared/contracts";
type EventPayload =
	| { kind: "acknowledgement"; text: string }
	| { kind: "text-delta"; delta: string }
	| { kind: "action"; action: AgentAction }
	| { kind: "completed" }
	| { kind: "cancelled" }
	| { kind: "error"; message: string };
export type { AgentEvent } from "./events";
type TurnStatus = AgentTurnStatus;
export interface AgentServiceOptions {
	actionReceipts?: {
		timeoutMs?: number;
		/** Synchronously commit to the canonical screen store before releasing the barrier. */
		updateScreen: (receipt: AgentActionReceipt) => void;
	};
}
interface PendingAction {
	action: AgentAction;
	resolve: (screen: ScreenContext) => void;
	reject: (error: Error) => void;
	cleanup: () => void;
}
interface TurnState {
	input: StartTurn;
	fingerprint: string;
	controller: AbortController;
	status: TurnStatus;
	sequence: number;
	events: AgentEvent[];
	text: string;
	actions: AgentAction[];
	pendingAction?: PendingAction;
}

/** Main-process singleton per application. Poll via existing IPC; cancellation must call cancel(). */
export class AgentService {
	private readonly sessions = new Map<string, TurnState>();
	private readonly requests = new Map<string, TurnState>();
	private readonly jobs = new Set<Promise<void>>();
	private disposed = false;
	constructor(
		private readonly client: AgentModelClient,
		private readonly ports: AgentPorts,
		private readonly options: AgentServiceOptions = {}
	) {
		const timeout = options.actionReceipts?.timeoutMs;
		if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 1 || timeout > 10_000))
			throw new Error("Action receipt timeout must be between 1 and 10000 ms");
	}

	actionApplied(raw: unknown): AgentActionReceiptResult {
		const receipt = AgentActionReceiptSchema.parse(raw);
		const state = this.sessions.get(receipt.sessionId);
		const pending = state?.pendingAction;
		const config = this.options.actionReceipts;
		if (
			!config ||
			!state ||
			!pending ||
			!this.active(state) ||
			receipt.turnId !== state.input.turnId ||
			receipt.generation !== state.input.generation ||
			receipt.requestId !== pending.action.requestId ||
			(receipt.status === "applied" &&
				receipt.screenContext.prId !== state.input.screenContext.prId) ||
			receipt.screenContext.sequence < pending.action.screenSequence ||
			(receipt.screenContext.browser &&
				receipt.screenContext.browser.sessionId !== receipt.sessionId)
		)
			return { status: "stale" };
		try {
			config.updateScreen(structuredClone(receipt));
		} catch {
			pending.cleanup();
			pending.reject(new ActionReceiptError("failed"));
			throw new ActionReceiptError("failed");
		}
		if (!this.active(state) || state.pendingAction !== pending) return { status: "stale" };
		pending.cleanup();
		if (receipt.status === "ignored") pending.reject(new ActionReceiptError("ignored"));
		else pending.resolve(receipt.screenContext);
		return { status: "accepted" };
	}

	start(raw: unknown): {
		sessionId: string;
		turnId: string;
		generation: number;
		status: TurnStatus;
	} {
		if (this.disposed) throw new Error("Agent service is disposed");
		const input = StartTurnSchema.parse(raw);
		const fingerprint = JSON.stringify(input);
		const existingRequest = this.requests.get(input.requestId);
		if (existingRequest) {
			if (existingRequest.fingerprint !== fingerprint)
				throw new Error("Turn request ID reused with different input");
			return this.identity(existingRequest);
		}
		const previous = this.sessions.get(input.sessionId);
		if (
			previous &&
			(input.generation <= previous.input.generation || input.turnId === previous.input.turnId)
		) {
			throw new Error("Turn identity is stale; increment generation and use a new turn ID");
		}
		if (!previous && this.sessions.size >= 100)
			throw new Error("Session limit reached; release inactive sessions");
		if (previous?.status === "running") this.cancelState(previous);
		if (previous) this.requests.delete(previous.input.requestId);
		const state: TurnState = {
			input,
			fingerprint,
			controller: new AbortController(),
			status: "running",
			sequence: 0,
			events: [],
			text: "",
			actions: [],
		};
		this.sessions.set(input.sessionId, state);
		this.requests.set(input.requestId, state);
		this.emit(state, { kind: "acknowledgement", text: "I’m checking that." });
		const job = this.run(state);
		this.jobs.add(job);
		void job.finally(() => this.jobs.delete(job));
		return this.identity(state);
	}

	poll(raw: unknown) {
		const input = PollTurnSchema.parse(raw);
		const state = this.sessions.get(input.sessionId);
		if (
			!state ||
			state.input.turnId !== input.turnId ||
			state.input.generation !== input.generation
		) {
			return PollTurnResultSchema.parse({
				sessionId: input.sessionId,
				turnId: input.turnId,
				generation: input.generation,
				status: "stale" as const,
				sequence: 0,
				events: [] as AgentEvent[],
				text: "",
				actions: [] as AgentAction[],
			});
		}
		if (input.afterSequence > state.sequence)
			throw new Error("Event cursor is ahead of the current turn");
		return PollTurnResultSchema.parse({
			...this.identity(state),
			sequence: state.sequence,
			events: state.events
				.filter((event) => event.sequence > input.afterSequence)
				.slice(0, input.limit),
			// Full snapshots let clients recover after the bounded event window is compacted.
			text: state.text,
			actions: state.actions,
		});
	}

	cancel(raw: unknown) {
		const input = CancelTurnInputSchema.parse(raw);
		const state = this.sessions.get(input.sessionId);
		let status: "cancelled" | "stale" | "not-found" = "not-found";
		if (state) {
			if (
				state.input.turnId !== input.turnId ||
				state.input.generation !== input.generation ||
				state.status === "completed" ||
				state.status === "error"
			)
				status = "stale";
			else {
				this.cancelState(state);
				status = "cancelled";
			}
		}
		return CancelTurnResultSchema.parse({
			requestId: input.requestId,
			sessionId: input.sessionId,
			turnId: input.turnId,
			generation: input.generation,
			status,
		});
	}

	releaseSession(rawSessionId: string) {
		const sessionId = IdSchema.parse(rawSessionId);
		const state = this.sessions.get(sessionId);
		if (state) this.cancelState(state);
		this.sessions.delete(sessionId);
		for (const [requestId, value] of this.requests) {
			if (value.input.sessionId === sessionId) this.requests.delete(requestId);
		}
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		for (const state of this.sessions.values()) this.cancelState(state);
		await Promise.allSettled([...this.jobs]);
		this.sessions.clear();
		this.requests.clear();
	}

	private identity(state: TurnState) {
		return {
			sessionId: state.input.sessionId,
			turnId: state.input.turnId,
			generation: state.input.generation,
			status: state.status,
		};
	}
	private active(state: TurnState) {
		return (
			this.sessions.get(state.input.sessionId) === state &&
			state.status === "running" &&
			!state.controller.signal.aborted
		);
	}
	private emit(state: TurnState, payload: EventPayload) {
		const event = AgentEventSchema.parse({
			sessionId: state.input.sessionId,
			turnId: state.input.turnId,
			generation: state.input.generation,
			sequence: ++state.sequence,
			...payload,
		});
		state.events.push(event);
		if (state.events.length > 512) state.events.splice(0, state.events.length - 512);
	}
	private cancelState(state: TurnState) {
		if (state.status !== "running") return;
		state.status = "cancelled";
		state.controller.abort();
		this.emit(state, { kind: "cancelled" });
	}
	private publishAction(state: TurnState, action: AgentAction): undefined | Promise<ScreenContext> {
		state.controller.signal.throwIfAborted();
		if (!this.active(state)) throw new Error("Turn is no longer active");
		let receipt: Promise<ScreenContext> | undefined;
		if (this.options.actionReceipts) {
			if (state.pendingAction) throw new Error("Previous action is still pending");
			receipt = new Promise<ScreenContext>((resolve, reject) => {
				const signal = state.controller.signal;
				const cleanup = () => {
					clearTimeout(timer);
					signal.removeEventListener("abort", abort);
					state.pendingAction = undefined;
				};
				const abort = () => {
					cleanup();
					reject(new DOMException("Operation cancelled", "AbortError"));
				};
				const timer = setTimeout(() => {
					cleanup();
					reject(new ActionReceiptError("timeout"));
				}, this.options.actionReceipts?.timeoutMs ?? 10_000);
				state.pendingAction = { action, resolve, reject, cleanup };
				signal.addEventListener("abort", abort, { once: true });
			});
		}
		// The receipt must already be registered when polling can expose this event.
		state.actions.push(action);
		this.emit(state, { kind: "action", action });
		return receipt;
	}
	private async run(state: TurnState) {
		try {
			await runToolLoop(this.client, this.ports, {
				turn: state.input,
				sessionId: state.input.sessionId,
				workload: state.input.workload,
				signal: state.controller.signal,
				onText: (delta) => {
					if (!this.active(state)) return;
					if (state.text.length + delta.length > 100_000)
						throw new Error("Turn text limit reached");
					state.text += delta;
					this.emit(state, { kind: "text-delta", delta });
				},
				onAction: (action) => this.publishAction(state, action),
			});
			if (this.active(state)) {
				state.status = "completed";
				this.emit(state, { kind: "completed" });
			}
		} catch (error) {
			if (this.active(state)) {
				state.status = "error";
				this.emit(state, {
					kind: "error",
					message:
						error instanceof ActionReceiptError
							? "Workspace did not acknowledge the action; retry the review."
							: "Agent turn failed; check model credentials, runtime availability and current PR context.",
				});
			}
		}
	}
}
