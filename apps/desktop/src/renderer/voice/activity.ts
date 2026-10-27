/** Local, bounded signal detector. PCM never leaves the active microphone session except via its RTC turn. */
export type SpeechFrame = {
	samples: Float32Array;
	reference: Float32Array;
	sampleRate: number;
};
export type ActivityOptions = {
	onsetMs?: number;
	playbackOnsetMs?: number;
	silenceMs?: number;
	maxUtteranceMs?: number;
};
export type ActivityDecision = "none" | "start" | "end" | "noise" | "limit";

function limit(value: number | undefined, fallback: number, min: number, max: number) {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value < min || value > max)
		throw new Error("Invalid voice activity limit");
	return value;
}

/** Energy/ZCR gating with adaptive noise floor and delayed playback-reference correlation, not semantic VAD. */
export class VoiceActivityDetector {
	private candidateMs = 0;
	private quietMs = 0;
	private voiceMs = 0;
	private durationMs = 0;
	private noiseFloor = 0.003;
	private active = false;
	private reference: number[] = [];
	private playbackTail = 0;
	private rate = 0;
	private echoOnly = false;
	/** High-confidence correlated playback may be zeroed in preroll, never mistaken for new user PCM. */
	get isPlaybackEcho() {
		return this.echoOnly;
	}
	private readonly onset: number;
	private readonly playbackOnset: number;
	private readonly silence: number;
	private readonly maximum: number;
	constructor(options: ActivityOptions = {}) {
		this.onset = limit(options.onsetMs, 120, 60, 300);
		this.playbackOnset = limit(options.playbackOnsetMs, 240, 180, 500);
		this.silence = limit(options.silenceMs, 700, 400, 1500);
		this.maximum = limit(options.maxUtteranceMs, 30_000, 1000, 45_000);
	}
	reset() {
		this.active = false;
		this.candidateMs = this.quietMs = this.voiceMs = this.durationMs = 0;
	}
	process(frame: SpeechFrame, playing: boolean): ActivityDecision {
		const { samples, reference, sampleRate } = frame;
		const ms = (samples.length / sampleRate) * 1000;
		if (
			!Number.isFinite(sampleRate) ||
			sampleRate < 8000 ||
			sampleRate > 192000 ||
			ms < 5 ||
			ms > 100 ||
			reference.length !== samples.length
		)
			throw new Error("Invalid microphone signal frame");
		if (this.rate !== sampleRate) {
			this.reference = [];
			this.rate = sampleRate;
		}
		let energy = 0;
		let output = 0;
		let crossings = 0;
		for (let i = 0; i < samples.length; i++) {
			const value = samples[i] ?? 0;
			const ref = reference[i] ?? 0;
			if (!Number.isFinite(value) || !Number.isFinite(ref))
				throw new Error("Invalid microphone samples");
			energy += value * value;
			output += ref * ref;
			if (i > 0 && value >= 0 !== (samples[i - 1] ?? 0) >= 0) crossings++;
		}
		const rms = Math.sqrt(energy / samples.length);
		this.playbackTail =
			playing || output / samples.length > 0.000001 ? 300 : Math.max(0, this.playbackTail - ms);
		const playback = this.playbackTail > 0;
		const stride = Math.max(1, Math.floor(sampleRate / 4000));
		const mic: number[] = [];
		for (let i = 0; i < samples.length; i += stride) {
			mic.push(samples[i] ?? 0);
			this.reference.push(reference[i] ?? 0);
		}
		const history = Math.ceil((sampleRate / stride) * 0.35);
		if (this.reference.length > history) this.reference.splice(0, this.reference.length - history);
		let correlation = 0;
		if (playback && rms > 0.008) {
			const micEnergy = mic.reduce((sum, sample) => sum + sample * sample, 0);
			const maxLag = Math.min(
				this.reference.length - mic.length,
				Math.floor((sampleRate / stride) * 0.25)
			);
			for (let lag = 0; lag <= maxLag; lag += 4) {
				let dot = 0;
				let refEnergy = 0;
				const start = this.reference.length - mic.length - lag;
				for (let i = 0; i < mic.length; i++) {
					const ref = this.reference[start + i] ?? 0;
					dot += (mic[i] ?? 0) * ref;
					refEnergy += ref * ref;
				}
				if (refEnergy > 0.00001)
					correlation = Math.max(correlation, Math.abs(dot) / Math.sqrt(micEnergy * refEnergy));
			}
		}
		const zcr = crossings / samples.length;
		this.echoOnly = playback && correlation >= 0.85;
		const threshold = Math.max(
			this.active ? 0.008 : playback ? 0.025 : 0.012,
			this.noiseFloor * (this.active ? 2 : 3)
		);
		const voiced =
			rms >= threshold && zcr >= 0.005 && zcr < 0.35 && !(playback && correlation >= 0.65);
		if (!this.active && !playback && !voiced)
			this.noiseFloor = this.noiseFloor * 0.95 + Math.min(rms, 0.02) * 0.05;
		if (!this.active) {
			this.candidateMs = voiced ? this.candidateMs + ms : 0;
			if (this.candidateMs < (playback ? this.playbackOnset : this.onset)) return "none";
			this.active = true;
			this.voiceMs = this.durationMs = this.candidateMs;
			this.quietMs = 0;
			return "start";
		}
		this.durationMs += ms;
		if (voiced) {
			this.voiceMs += ms;
			this.quietMs = 0;
		} else this.quietMs += ms;
		if (this.durationMs >= this.maximum) {
			this.reset();
			return "limit";
		}
		if (this.quietMs < this.silence) return "none";
		const decision = this.voiceMs >= 160 ? "end" : "noise";
		this.reset();
		return decision;
	}
}
