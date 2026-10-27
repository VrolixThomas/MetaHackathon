import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

type Message = {
	type: string;
	code?: string;
	sequence?: number;
	epoch?: number;
	samples?: Float32Array;
};
function worklet() {
	const messages: Message[] = [];
	const port = {
		onmessage: undefined as ((event: { data: unknown }) => void) | undefined,
		postMessage: (message: Message) => messages.push(message),
	};
	let Processor:
		| (new () => { process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean })
		| undefined;
	runInNewContext(readFileSync(new URL("./hands-free-worklet.js", import.meta.url), "utf8"), {
		AudioWorkletProcessor: class {
			port = port;
		},
		Float32Array,
		sampleRate: 8000,
		registerProcessor: (_name: string, processorClass: typeof Processor) => {
			Processor = processorClass;
		},
	});
	assert.ok(Processor);
	const processor = new Processor();
	return {
		messages,
		send: (data: unknown) => port.onmessage?.({ data }),
		process(length = 128, acknowledge = true) {
			const output = new Float32Array(length);
			const active = processor.process(
				[[new Float32Array(length)], [new Float32Array(length)]],
				[[output]]
			);
			if (acknowledge) {
				const last = messages.filter((message) => message.type === "frame").at(-1);
				if (last) port.onmessage?.({ data: { type: "ack", sequence: last.sequence } });
			}
			return { output, active };
		},
	};
}
test("worklet retains the entire onset while unconnected and drains FIFO at the render clock", () => {
	const w = worklet();
	w.send({ type: "begin", epoch: 1 });
	const a = Float32Array.from({ length: 160 }, (_, i) => i / 1000);
	const b = new Float32Array(160).fill(0.8);
	w.send({ type: "append", epoch: 1, samples: a });
	w.send({ type: "append", epoch: 1, samples: b });
	w.send({ type: "end", epoch: 1 });
	for (let i = 0; i < 50; i++) assert.ok(w.process().output.every((sample) => sample === 0));
	assert.equal(
		w.messages.some((message) => message.type === "drained"),
		false
	);
	w.send({ type: "play", epoch: 1 });
	const heard = [...w.process(128).output, ...w.process(128).output, ...w.process(128).output];
	assert.deepEqual(heard.slice(0, 320), [...a, ...b]);
	assert.ok(heard.slice(320).every((sample) => sample === 0));
	assert.deepEqual(
		w.messages.filter((message) => message.type === "drained"),
		[{ type: "drained", epoch: 1 }]
	);
});
test("cancel/new epoch removes old PCM and ignores late old commands", () => {
	const w = worklet();
	w.send({ type: "begin", epoch: 1 });
	w.send({ type: "append", epoch: 1, samples: new Float32Array(160).fill(0.1) });
	w.send({ type: "cancel", epoch: 1 });
	w.send({ type: "append", epoch: 1, samples: new Float32Array(160).fill(0.1) });
	w.send({ type: "play", epoch: 1 });
	assert.ok(w.process().output.every((sample) => sample === 0));
	w.send({ type: "begin", epoch: 2 });
	w.send({ type: "append", epoch: 2, samples: new Float32Array(160).fill(0.7) });
	w.send({ type: "cancel", epoch: 1 });
	w.send({ type: "play", epoch: 2 });
	assert.ok(w.process().output.every((sample) => Math.abs(sample - 0.7) < 0.00001));
	w.send({ type: "stop" });
	assert.equal(w.process().active, false);
});
test("PCM queue overflow and stalled renderer credit exhaust fail closed", () => {
	const w = worklet();
	w.send({ type: "begin", epoch: 1 });
	for (let i = 0; i < 151; i++)
		w.send({ type: "append", epoch: 1, samples: new Float32Array(800) });
	assert.deepEqual(w.messages, [{ type: "error", code: "overflow" }]);
	assert.equal(w.process().active, false);
	const blocked = worklet();
	for (let i = 0; i < 101; i++) blocked.process(160, false);
	assert.equal(blocked.messages.filter((message) => message.type === "frame").length, 100);
	assert.equal(blocked.messages.at(-1)?.code, "stalled");
});
