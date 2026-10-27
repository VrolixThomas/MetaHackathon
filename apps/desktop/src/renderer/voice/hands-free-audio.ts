import { VoiceDiagnosticError } from "../../main/voice/diagnostics";
import { aborted, bounded } from "./async";
import { createBrowserMediaFactory, microphoneError } from "./browser-media";
import type { BufferedVoiceMedia, HandsFreeAudioFactory } from "./hands-free-types";

export type HandsFreeAudioOptions = {
	getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
	createAudioContext?: () => AudioContext;
	createWorklet?: (context: AudioContext) => AudioWorkletNode;
	loadWorklet?: (context: AudioContext) => Promise<void>;
};
const mediaError = (code: "failed" | "timeout" | "protocol" = "failed") =>
	new VoiceDiagnosticError({ stage: "media", code });

/** One physical microphone and worklet per explicit session, one buffered virtual track per turn. */
export function createBrowserHandsFreeAudioFactory(
	options: HandsFreeAudioOptions = {}
): HandsFreeAudioFactory {
	return (observer) => {
		let closed = false;
		let started = false;
		let sequence = 0;
		let epoch = 0;
		let context: AudioContext | undefined;
		let microphone: MediaStream | undefined;
		let source: MediaStreamAudioSourceNode | undefined;
		let node: AudioWorkletNode | undefined;
		let destination: MediaStreamAudioDestinationNode | undefined;
		let muted: GainNode | undefined;
		let reference: MediaStreamAudioSourceNode | undefined;
		let removeAbort = () => {};
		let drained: (() => void) | undefined;
		const turns = new Set<BufferedVoiceMedia>();
		const send = (message: unknown, transfer: Transferable[] = []) =>
			node?.port.postMessage(message, transfer);
		const cleanup = (work: () => void) => {
			try {
				work();
			} catch {
				/* Continue releasing every resource. */
			}
		};
		function close() {
			if (closed) return;
			closed = true;
			removeAbort();
			for (const track of microphone?.getTracks() ?? []) cleanup(() => track.stop());
			for (const turn of [...turns]) cleanup(() => turn.close());
			for (const track of destination?.stream.getTracks() ?? []) cleanup(() => track.stop());
			if (node) {
				node.onprocessorerror = null;
				node.port.onmessage = null;
				cleanup(() => send({ type: "stop" }));
				cleanup(() => node?.port.close());
				cleanup(() => node?.disconnect());
			}
			cleanup(() => source?.disconnect());
			cleanup(() => reference?.disconnect());
			cleanup(() => muted?.disconnect());
			if (context) {
				context.onstatechange = null;
				void context.close().catch(() => {});
			}
			drained = undefined;
		}
		function fail(error: Error) {
			if (closed) return;
			close();
			observer.failed(error);
		}
		return {
			async start(signal) {
				if (closed || context || signal.aborted) throw aborted();
				signal.addEventListener("abort", close, { once: true });
				removeAbort = () => signal.removeEventListener("abort", close);
				try {
					// These calls occur synchronously inside the user's Start gesture.
					context = options.createAudioContext?.() ?? new AudioContext();
					const audioContext = context;
					const resumed = audioContext.resume();
					void resumed.catch(() => {});
					const permission = (async () => {
						try {
							return await (
								options.getUserMedia ?? ((input) => navigator.mediaDevices.getUserMedia(input))
							)({
								audio: {
									echoCancellation: true,
									noiseSuppression: true,
									autoGainControl: true,
									channelCount: 1,
								},
								video: false,
							});
						} catch (error) {
							throw microphoneError(error);
						}
					})();
					void permission.then(
						(stream) => {
							if (closed) for (const track of stream.getTracks()) track.stop();
							else microphone = stream;
						},
						() => {}
					);
					const module = options.loadWorklet
						? options.loadWorklet(audioContext)
						: audioContext.audioWorklet.addModule(
								new URL("./hands-free-worklet.js?no-inline", import.meta.url).href
							);
					const [stream] = await Promise.all([
						bounded(
							permission,
							signal,
							60_000,
							new VoiceDiagnosticError({ stage: "microphone", code: "timeout" })
						),
						bounded(module, signal, 10_000, mediaError("timeout")),
						bounded(resumed, signal, 5000, mediaError("timeout")),
					]);
					if (closed || signal.aborted) throw aborted();
					microphone = stream;
					if (stream.getAudioTracks().length !== 1) throw microphoneError(new Error());
					for (const track of stream.getTracks())
						track.addEventListener("ended", () => {
							if (!closed) fail(new VoiceDiagnosticError({ stage: "microphone", code: "failed" }));
						});
					node =
						options.createWorklet?.(audioContext) ??
						new AudioWorkletNode(audioContext, "voice-hands-free", {
							numberOfInputs: 2,
							numberOfOutputs: 1,
							outputChannelCount: [1],
							channelCount: 1,
							channelCountMode: "explicit",
						});
					node.onprocessorerror = () => fail(mediaError());
					node.port.onmessage = ({ data }) => {
						if (closed) return;
						if (data?.type === "error") {
							fail(mediaError(data.code === "protocol" ? "protocol" : "timeout"));
							return;
						}
						if (data?.type === "drained") {
							if (data.epoch === epoch) drained?.();
							return;
						}
						if (
							data?.type !== "frame" ||
							data.sequence !== sequence + 1 ||
							data.sampleRate !== audioContext.sampleRate ||
							!(data.samples instanceof Float32Array) ||
							!(data.reference instanceof Float32Array)
						) {
							fail(mediaError("protocol"));
							return;
						}
						sequence = data.sequence;
						send({ type: "ack", sequence });
						try {
							observer.frame({
								samples: data.samples,
								reference: data.reference,
								sampleRate: data.sampleRate,
							});
						} catch {
							fail(mediaError("protocol"));
						}
					};
					destination = audioContext.createMediaStreamDestination();
					node.connect(destination);
					// Keep processing when no RTC consumer exists; microphone PCM is never played locally.
					muted = audioContext.createGain();
					muted.gain.value = 0;
					node.connect(muted);
					muted.connect(audioContext.destination);
					source = audioContext.createMediaStreamSource(stream);
					source.connect(node, 0, 0);
					started = true;
					audioContext.onstatechange = () => {
						if (!closed && audioContext.state !== "running") fail(mediaError());
					};
				} catch (error) {
					close();
					throw error;
				}
			},
			createTurn(observer) {
				if (closed || !started || !context || !destination || !node) throw mediaError();
				for (const old of [...turns]) old.close();
				const current = ++epoch;
				const stream = destination.stream.clone();
				let retired = false;
				let sealed = false;
				let resolveDrain!: () => void;
				let rejectDrain!: (error: Error) => void;
				const drain = new Promise<void>((resolve, reject) => {
					resolveDrain = resolve;
					rejectDrain = reject;
				});
				void drain.catch(() => {});
				drained = resolveDrain;
				send({ type: "begin", epoch: current });
				const sharedContext = context;
				const media = createBrowserMediaFactory({
					getUserMedia: async () => stream,
					createAudioContext: () => sharedContext,
					keepAudioContextOpen: true,
					onRemoteStream: (remote) => {
						if (retired || closed || current !== epoch || !node) return;
						reference?.disconnect();
						reference = sharedContext.createMediaStreamSource(remote);
						reference.connect(node, 0, 1);
					},
				})(observer);
				const turn: BufferedVoiceMedia = {
					async connect(offer, signal) {
						try {
							await media.connect(offer, signal);
							if (retired || closed || current !== epoch) throw aborted();
							send({ type: "play", epoch: current });
						} catch (error) {
							turn.close();
							throw error;
						}
					},
					append(samples) {
						if (retired || closed || sealed) throw aborted();
						const copy = samples.slice();
						send({ type: "append", epoch: current, samples: copy }, [copy.buffer]);
					},
					finishInput() {
						if (retired || closed) return Promise.reject(aborted());
						if (!sealed) {
							sealed = true;
							send({ type: "end", epoch: current });
						}
						return drain;
					},
					stopCapture: () => media.stopCapture(),
					drain: (signal) => media.drain(signal),
					close() {
						if (retired) return;
						retired = true;
						turns.delete(turn);
						media.close();
						for (const track of stream.getTracks()) track.stop();
						rejectDrain(aborted());
						if (current === epoch) {
							send({ type: "cancel", epoch: current });
							drained = undefined;
							reference?.disconnect();
							reference = undefined;
						}
					},
				};
				turns.add(turn);
				return turn;
			},
			close,
		};
	};
}
