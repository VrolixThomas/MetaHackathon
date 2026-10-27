import assert from "node:assert/strict";
import { it } from "node:test";
import { createCaptureGate } from "./capture-gate";
import type { VoiceAdapter } from "./services";

function voice(overrides: Partial<VoiceAdapter> = {}) {
	const calls: string[] = [];
	const adapter: VoiceAdapter = {
		beginCapture: () => {
			calls.push("begin");
		},
		endCapture: () => {
			calls.push("end");
		},
		interrupt: () => {
			calls.push("interrupt");
		},
		getPhase: () => "idle",
		subscribe: () => () => {},
		...overrides,
	};
	return { calls, adapter };
}

it("serializes a delayed capture start with release and never leaves the microphone held", async () => {
	let ready = () => {};
	const { adapter, calls } = voice({
		beginCapture: () => {
			calls.push("begin");
			return new Promise<void>((resolve) => {
				ready = resolve;
			});
		},
	});
	const errors: string[] = [];
	const gate = createCaptureGate(adapter, (message) => errors.push(message));
	gate.press();
	await Promise.resolve();
	const release = gate.release();
	ready();
	await release;
	assert.deepEqual(calls, ["begin", "end"]);
	assert.deepEqual(errors, []);
});

it("deduplicates repeats from all activation sources and releases idempotently", async () => {
	const { adapter, calls } = voice();
	const gate = createCaptureGate(adapter, () => {});
	gate.press();
	gate.press();
	await gate.settled();
	await gate.release();
	await gate.release();
	assert.deepEqual(calls, ["begin", "end"]);
});

it("interrupts speech immediately without opening capture on that press", async () => {
	const { adapter, calls } = voice({ getPhase: () => "speaking" });
	const gate = createCaptureGate(adapter, () => {});
	gate.press();
	await Promise.resolve();
	await gate.release();
	assert.deepEqual(calls, ["interrupt"]);
});

it("cancels a capture queued before focus loss", async () => {
	const { adapter, calls } = voice();
	const gate = createCaptureGate(adapter, () => {});
	gate.press();
	await gate.release();
	assert.deepEqual(calls, []);
});
