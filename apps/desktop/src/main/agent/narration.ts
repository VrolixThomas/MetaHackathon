import {
	type AgentAction,
	type AgentActionReceiptResult,
	NarrationReceiptSchema,
} from "../../shared/contracts";
import { throwIfAborted } from "./cancellation";
import { GuidedReviewError } from "./guided-review";

export class NarrationRetiredError extends GuidedReviewError {}

type Checkpoint = Extract<AgentAction, { kind: "narration-checkpoint" }>;
export interface NarrationReceiptOptions {
	timeoutMs?: number;
}

/** A checkpoint identifies one exact cumulative prefix of one turn, never another generation. */
export class NarrationReceiptGate {
	private readonly pending = new Map<
		string,
		{
			action: Checkpoint;
			signal: AbortSignal;
			finish: (error?: Error) => void;
		}
	>();
	private readonly timeoutMs: number;
	constructor(options: NarrationReceiptOptions = {}) {
		this.timeoutMs = options.timeoutMs ?? 120_000;
		if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000)
			throw new Error("Narration timeout must be 1–120000 ms");
	}
	publish(action: Checkpoint, signal: AbortSignal, emit: () => void): Promise<void> {
		throwIfAborted(signal);
		if (this.pending.has(action.requestId)) throw new Error("Duplicate narration checkpoint ID");
		const promise = new Promise<void>((resolve, reject) => {
			let settled = false;
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal.removeEventListener("abort", abort);
				this.pending.delete(action.requestId);
				if (error) reject(error);
				else resolve();
			};
			const abort = () => finish(new DOMException("Operation cancelled", "AbortError"));
			const timer = setTimeout(
				() =>
					finish(
						new GuidedReviewError("Narration was not acknowledged. Continue from the current file.")
					),
				this.timeoutMs
			);
			this.pending.set(action.requestId, { action, signal, finish });
			signal.addEventListener("abort", abort, { once: true });
		});
		try {
			emit();
		} catch {
			this.pending
				.get(action.requestId)
				?.finish(
					new GuidedReviewError("Narration could not be displayed. Continue from the current file.")
				);
		}
		return promise;
	}
	accept(raw: unknown): AgentActionReceiptResult {
		const receipt = NarrationReceiptSchema.parse(raw);
		const pending = this.pending.get(receipt.requestId);
		if (
			!pending ||
			pending.signal.aborted ||
			receipt.sessionId !== pending.action.sessionId ||
			receipt.turnId !== pending.action.turnId ||
			receipt.generation !== pending.action.generation
		)
			return { status: "stale" };
		pending.finish(
			receipt.status === "ignored"
				? new NarrationRetiredError("Narration effects were retired.")
				: undefined
		);
		return { status: "accepted" };
	}
}
