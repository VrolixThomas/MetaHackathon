import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrowserHandsFreeAudioFactory } from "./hands-free-audio";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { resolve, promise };
}
function track() {
	return Object.assign(new EventTarget(), {
		stopped: false,
		stop() {
			this.stopped = true;
		},
	});
}
function environment() {
	const hardware = track();
	const base = track();
	const cloned: ReturnType<typeof track>[] = [];
	const messages: unknown[] = [];
	const node = {
		port: {
			onmessage: null,
			postMessage: (message: unknown) => messages.push(message),
			close() {},
		},
		onprocessorerror: null,
		connect() {},
		disconnect() {},
	};
	const hardwareStream = {
		getTracks: () => [hardware],
		getAudioTracks: () => [hardware],
	} as unknown as MediaStream;
	const outputStream = {
		getTracks: () => [base],
		clone: () => {
			const copy = track();
			cloned.push(copy);
			return { getTracks: () => [copy], getAudioTracks: () => [copy] };
		},
	};
	const context = {
		state: "running",
		sampleRate: 48000,
		destination: {},
		onstatechange: null,
		resume: async () => {},
		close: async () => {
			context.state = "closed";
		},
		createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
		createMediaStreamDestination: () => ({ stream: outputStream }),
		createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }),
	};
	let opens = 0;
	let permission = async () => hardwareStream;
	const errors: Error[] = [];
	const audio = createBrowserHandsFreeAudioFactory({
		getUserMedia: (constraints) => {
			opens++;
			assert.deepEqual(constraints, {
				audio: {
					echoCancellation: true,
					noiseSuppression: true,
					autoGainControl: true,
					channelCount: 1,
				},
				video: false,
			});
			return permission();
		},
		createAudioContext: () => context as unknown as AudioContext,
		createWorklet: () => node as unknown as AudioWorkletNode,
		loadWorklet: async () => {},
	})({ frame() {}, failed: (error) => errors.push(error) });
	return {
		audio,
		hardware,
		hardwareStream,
		base,
		cloned,
		context,
		messages,
		errors,
		opens: () => opens,
		setPermission: (get: typeof permission) => {
			permission = get;
		},
	};
}
test("persistent audio opens hardware once and retires only virtual tracks between turns", async () => {
	const e = environment();
	await e.audio.start(new AbortController().signal);
	const first = e.audio.createTurn({ pcm() {}, disconnected() {} });
	first.append(new Float32Array(960));
	first.close();
	const second = e.audio.createTurn({ pcm() {}, disconnected() {} });
	assert.equal(e.opens(), 1);
	assert.equal(e.hardware.stopped, false);
	assert.equal(e.context.state, "running");
	assert.equal(e.cloned[0]?.stopped, true);
	assert.equal(e.cloned[1]?.stopped, false);
	second.close();
	e.audio.close();
	assert.equal(e.hardware.stopped, true);
	assert.equal(e.base.stopped, true);
	assert.equal(e.context.state, "closed");
});
test("late hardware permission after stop is reclaimed without constructing a turn", async () => {
	const e = environment();
	const permission = deferred<MediaStream>();
	e.setPermission(() => permission.promise);
	const abort = new AbortController();
	const pending = e.audio.start(abort.signal);
	const rejected = assert.rejects(pending, { name: "AbortError" });
	abort.abort();
	permission.resolve(e.hardwareStream);
	await rejected;
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(e.hardware.stopped, true);
	assert.equal(e.cloned.length, 0);
	assert.equal(e.context.state, "closed");
});
test("device-ended event closes the persistent session rather than silently reacquiring hardware", async () => {
	const e = environment();
	await e.audio.start(new AbortController().signal);
	e.hardware.dispatchEvent(new Event("ended"));
	assert.equal(e.errors.length, 1);
	assert.equal(e.hardware.stopped, true);
	assert.equal(e.context.state, "closed");
	assert.equal(e.opens(), 1);
	assert.throws(() => e.audio.createTurn({ pcm() {}, disconnected() {} }));
});
