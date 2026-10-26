import { z } from "zod";
import {
	type AgentAction,
	AgentTurnInputSchema,
	CancelTurnInputSchema,
	CancelTurnResultSchema,
	IdSchema,
} from "../../shared/contracts";
import { type AgentEvent, AgentEventSchema } from "./events";
import type { MetaClient } from "./meta-client";
import { type AgentPorts, runToolLoop } from "./tool-loop";

// Event polling and workload stay module-owned until the MET-8 event contract lands.
export const StartTurnSchema = AgentTurnInputSchema.extend({
	workload: z.enum(["quick", "deep"]).default("quick"),
});
export type StartTurn = z.infer<typeof StartTurnSchema>;
export const PollTurnSchema = z.strictObject({
	sessionId: IdSchema,
	turnId: IdSchema,
	generation: z.int().nonnegative(),
	afterSequence: z.int().nonnegative().default(0),
});
type EventPayload =
	| { kind: "acknowledgement"; text: string }
	| { kind: "text-delta"; delta: string }
	| { kind: "action"; action: AgentAction }
	| { kind: "completed" }
	| { kind: "cancelled" }
	| { kind: "error"; message: string };
export type { AgentEvent } from "./events";
type TurnStatus = "running" | "completed" | "cancelled" | "error";
interface TurnState {
	input: StartTurn;
	fingerprint: string;
	controller: AbortController;
	status: TurnStatus;
	sequence: number;
	events: AgentEvent[];
	text: string;
	actions: AgentAction[];
}

/** Main-process singleton per application. Poll via existing IPC; cancellation must call cancel(). */
export class AgentService {
	private readonly sessions = new Map<string, TurnState>();
	private readonly requests = new Map<string, TurnState>();
	private readonly jobs = new Set<Promise<void>>();
	private disposed = false;
	constructor(
		private readonly client: MetaClient,
		private readonly ports: AgentPorts
	) {}

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
			return {
				sessionId: input.sessionId,
				turnId: input.turnId,
				generation: input.generation,
				status: "stale" as const,
				sequence: 0,
				events: [] as AgentEvent[],
				text: "",
				actions: [] as AgentAction[],
			};
		}
		if (input.afterSequence > state.sequence)
			throw new Error("Event cursor is ahead of the current turn");
		return structuredClone({
			...this.identity(state),
			sequence: state.sequence,
			events: state.events.filter((event) => event.sequence > input.afterSequence),
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

	releaseSession(sessionId: string) {
		const state = this.sessions.get(IdSchema.parse(sessionId));
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
				onAction: (action) => {
					if (!this.active(state)) return;
					state.actions.push(action);
					this.emit(state, { kind: "action", action });
				},
			});
			if (this.active(state)) {
				state.status = "completed";
				this.emit(state, { kind: "completed" });
			}
		} catch {
			if (this.active(state)) {
				state.status = "error";
				this.emit(state, {
					kind: "error",
					message:
						"Agent turn failed; check model credentials, runtime availability and current PR context.",
				});
			}
		}
	}
}
