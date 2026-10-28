import assert from "node:assert/strict";
import { test } from "node:test";
import { type SpeechFrame, VoiceActivityDetector } from "./activity";

function tone(frequency = 440, amplitude = 0.1): Float32Array {
	return Float32Array.from(
		{ length: 960 },
		(_, i) => amplitude * Math.sin((i * 2 * Math.PI * frequency) / 48000)
	);
}
function frame(
	samples: Float32Array = new Float32Array(960),
	reference: Float32Array = new Float32Array(960)
): SpeechFrame {
	return { samples, reference, sampleRate: 48000 };
}
test("detector requires sustained onset then endpoints after bounded silence", () => {
	const detector = new VoiceActivityDetector();
	for (let i = 0; i < 5; i++) assert.equal(detector.process(frame(tone()), false), "none");
	assert.equal(detector.process(frame(tone()), false), "start");
	for (let i = 0; i < 10; i++) detector.process(frame(tone()), false);
	for (let i = 0; i < 34; i++) assert.equal(detector.process(frame(), false), "none");
	assert.equal(detector.process(frame(), false), "end");
	assert.equal(detector.process(frame(), false), "none");
});
test("silence, DC, high-frequency noise and a transient do not create repeated speech", () => {
	const detector = new VoiceActivityDetector();
	for (let i = 0; i < 50; i++) {
		assert.equal(detector.process(frame(), false), "none");
		assert.equal(detector.process(frame(new Float32Array(960).fill(0.2)), false), "none");
		assert.equal(
			detector.process(
				frame(Float32Array.from({ length: 960 }, (_, j) => (j % 2 ? 0.1 : -0.1))),
				false
			),
			"none"
		);
	}
	for (let i = 0; i < 3; i++) assert.equal(detector.process(frame(tone(440, 0.2)), false), "none");
	for (let i = 0; i < 40; i++) assert.equal(detector.process(frame(), false), "none");
});
test("playback correlation rejects echo while independent near-end speech can interrupt", () => {
	const detector = new VoiceActivityDetector();
	const reference = tone(660, 0.2);
	const echo = Float32Array.from(reference, (sample) => sample * 0.3);
	for (let i = 0; i < 60; i++) assert.equal(detector.process(frame(echo, reference), true), "none");
	for (let i = 0; i < 11; i++)
		assert.equal(detector.process(frame(tone(440, 0.15), reference), true), "none");
	assert.equal(detector.process(frame(tone(440, 0.15), reference), true), "start");
});
test("short false onset and continuous sound are explicitly bounded", () => {
	const detector = new VoiceActivityDetector({ maxUtteranceMs: 1000 });
	for (let i = 0; i < 6; i++) detector.process(frame(tone()), false);
	let result = "none";
	for (let i = 0; i < 35; i++) result = detector.process(frame(), false);
	assert.equal(result, "noise");
	for (let i = 0; i < 50; i++) result = detector.process(frame(tone()), false);
	assert.equal(result, "limit");
	assert.throws(() => detector.process(frame(new Float32Array(960).fill(Number.NaN)), false));
});

test("longer echo window does not suppress independent near-pitch speech or its first frames", () => {
	const detector = new VoiceActivityDetector();
	let firstOnset = -1;
	for (let index = 0; index < 30; index++) {
		const chirp = (base: number, amplitude: number) =>
			Float32Array.from({ length: 960 }, (_, i) => {
				const time = (index * 960 + i) / 48000;
				return amplitude * Math.sin(2 * Math.PI * (base * time + 3 * time * time));
			});
		const result = detector.process(frame(chirp(188, 0.12), chirp(180, 0.2)), true);
		if (result === "start" && firstOnset < 0) firstOnset = index;
		assert.equal(detector.isPlaybackEcho, false, "Independent first-word PCM must stay in preroll");
	}
	assert.equal(firstOnset, 11, "240ms of independent voiced input should trigger barge-in");
});

test("brief phoneme gaps retain onset intent while delayed scaled playback remains rejected", () => {
	const speech = new VoiceActivityDetector();
	for (let i = 0; i < 6; i++) assert.equal(speech.process(frame(tone()), true), "none");
	for (let i = 0; i < 2; i++) assert.equal(speech.process(frame(), true), "none");
	for (let i = 0; i < 5; i++) assert.equal(speech.process(frame(tone()), true), "none");
	assert.equal(speech.process(frame(tone()), true), "start");
	const echo = new VoiceActivityDetector();
	const past: Float32Array[] = [];
	for (let index = 0; index < 60; index++) {
		const reference = Float32Array.from({ length: 960 }, (_, i) => {
			const time = (index * 960 + i) / 48000;
			return 0.2 * Math.sin(2 * Math.PI * (180 * time + 3 * time * time));
		});
		past.push(reference);
		const mic =
			index < 5
				? new Float32Array(960)
				: Float32Array.from(past[index - 5] ?? [], (sample) => sample * 0.3);
		assert.equal(echo.process(frame(mic, reference), true), "none");
	}
});
