/* Dedicated audio thread: 20ms capture frames and a bounded, paced per-turn PCM FIFO.
 * Capture and playback buffers remain local; no network, storage or logging is used here.
 * Port credits bound queued capture messages if the renderer becomes unresponsive.
 */
class HandsFreeProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.live = true;
		this.frameSize = Math.round(sampleRate * 0.02);
		this.mic = new Float32Array(this.frameSize);
		this.reference = new Float32Array(this.frameSize);
		this.position = 0;
		this.sequence = 0;
		this.acknowledged = 0;
		this.epoch = 0;
		this.turnActive = false;
		this.queue = [];
		this.queued = 0;
		this.offset = 0;
		this.playing = false;
		this.ended = false;
		this.port.onmessage = ({ data }) => {
			if (!this.live || !data || typeof data !== "object") return;
			if (data.type === "stop") {
				this.live = false;
				this.clear();
				return;
			}
			if (data.type === "ack" && Number.isSafeInteger(data.sequence)) {
				this.acknowledged = Math.max(this.acknowledged, Math.min(data.sequence, this.sequence));
				return;
			}
			if (data.type === "begin" && Number.isSafeInteger(data.epoch) && data.epoch > this.epoch) {
				this.clear();
				this.epoch = data.epoch;
				this.turnActive = true;
				return;
			}
			if (data.epoch !== this.epoch || !this.turnActive) return;
			if (data.type === "cancel") {
				this.clear();
				return;
			}
			if (data.type === "play") {
				this.playing = true;
				return;
			}
			if (data.type === "end") {
				this.ended = true;
				return;
			}
			if (data.type !== "append") return;
			const pcm = data.samples;
			if (
				this.ended ||
				!(pcm instanceof Float32Array) ||
				pcm.length === 0 ||
				pcm.length > this.frameSize * 5
			)
				return this.fail("protocol");
			if (this.queued + pcm.length > sampleRate * 15) return this.fail("overflow");
			this.queue.push(pcm);
			this.queued += pcm.length;
		};
	}
	clear() {
		this.turnActive = false;
		this.queue = [];
		this.offset = 0;
		this.queued = 0;
		this.playing = false;
		this.ended = false;
	}
	fail(code) {
		this.live = false;
		this.clear();
		this.port.postMessage({ type: "error", code });
	}
	process(inputs, outputs) {
		const output = outputs[0]?.[0];
		if (!output) return this.live;
		output.fill(0);
		if (!this.live) return false;
		const mic = inputs[0]?.[0];
		const reference = inputs[1]?.[0];
		for (let i = 0; i < output.length; i++) {
			this.mic[this.position] = mic?.[i] ?? 0;
			this.reference[this.position++] = reference?.[i] ?? 0;
			if (this.position === this.frameSize) {
				if (this.sequence - this.acknowledged >= 100) {
					this.fail("stalled");
					return false;
				}
				this.port.postMessage(
					{
						type: "frame",
						sequence: ++this.sequence,
						sampleRate,
						samples: this.mic,
						reference: this.reference,
					},
					[this.mic.buffer, this.reference.buffer]
				);
				this.position = 0;
				this.mic = new Float32Array(this.frameSize);
				this.reference = new Float32Array(this.frameSize);
			}
			if (this.playing && this.queue.length) {
				output[i] = this.queue[0][this.offset++];
				this.queued--;
				if (this.offset === this.queue[0].length) {
					this.queue.shift();
					this.offset = 0;
				}
			}
		}
		if (this.playing && this.ended && this.queued === 0) {
			this.playing = false;
			this.port.postMessage({ type: "drained", epoch: this.epoch });
		}
		return this.live;
	}
}
registerProcessor("voice-hands-free", HandsFreeProcessor);
