import { VoiceDiagnosticError } from "../../main/voice/diagnostics";
import { VoiceAnswerSchema } from "../../main/voice/protocol";
import { aborted, asError, bounded, delay } from "./async";
import type { MediaFactory, VoiceMedia } from "./types";

export type BrowserMediaOptions = {
	/** Injectable browser constructors also allow deterministic lifecycle tests. */
	getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
	createPeer?: (configuration: RTCConfiguration) => RTCPeerConnection;
	createAudioContext?: () => AudioContext;
	now?: () => number;
	iceTimeoutMs?: number;
	connectionTimeoutMs?: number;
	permissionTimeoutMs?: number;
	rmsThreshold?: number;
	/** Session-owned context: a per-turn close must not close the microphone graph. */
	keepAudioContextOpen?: boolean;
	/** Local playback reference for echo-aware input detection; never transmitted or logged. */
	onRemoteStream?: (stream: MediaStream) => void;
};

export function microphoneError(error: unknown): VoiceDiagnosticError {
	const name = error instanceof Error ? error.name : "";
	const code = ["NotAllowedError", "PermissionDeniedError", "SecurityError"].includes(name)
		? "denied"
		: ["NotFoundError", "DevicesNotFoundError"].includes(name)
			? "not-found"
			: ["NotReadableError", "TrackStartError", "AbortError"].includes(name)
				? "busy"
				: "failed";
	return new VoiceDiagnosticError({ stage: "microphone", code });
}

/** A fresh localhost peer and output graph for every generation; no STUN/TURN or credentials. */
export function createBrowserMediaFactory(options: BrowserMediaOptions = {}): MediaFactory {
	return (observer): VoiceMedia => {
		const now = options.now ?? (() => performance.now());
		const lifetime = new AbortController();
		let closed = false;
		let captureStopped = false;
		let stream: MediaStream | null = null;
		let peer: RTCPeerConnection | null = null;
		let channel: RTCDataChannel | null = null;
		let context: AudioContext | null = null;
		let analyser: AnalyserNode | null = null;
		let source: MediaStreamAudioSourceNode | null = null;
		let meter: ReturnType<typeof setInterval> | null = null;
		let lastPcmAt = Number.NEGATIVE_INFINITY;
		let removeAbort: (() => void) | null = null;
		let remoteTrack: MediaStreamTrack | null = null;
		let decoder: HTMLAudioElement | null = null;

		function stopCapture() {
			captureStopped = true;
			for (const track of stream?.getTracks() ?? []) track.stop();
			// Keep the sender/peer alive so buffered RTP and incoming speech can drain.
		}
		function close() {
			if (closed) return;
			closed = true;
			lifetime.abort();
			removeAbort?.();
			removeAbort = null;
			stopCapture();
			if (meter !== null) clearInterval(meter);
			meter = null;
			if (decoder) {
				decoder.pause();
				decoder.srcObject = null;
			}
			if (remoteTrack) {
				remoteTrack.onended = null;
				remoteTrack.stop();
			}
			if (peer) {
				peer.ontrack = null;
				peer.onconnectionstatechange = null;
				peer.oniceconnectionstatechange = null;
			}
			if (channel) {
				channel.onclose = null;
				channel.onerror = null;
				channel.close();
			}
			// Disconnect/mute synchronously before asynchronous AudioContext.close().
			source?.disconnect();
			analyser?.disconnect();
			peer?.close();
			if (!options.keepAudioContextOpen && context && context.state !== "closed")
				void context.close().catch(() => {});
		}
		function disconnected(error: unknown) {
			if (closed) return;
			close();
			observer.disconnected(asError(error));
		}
		function ensureOpen() {
			if (closed) throw aborted();
		}
		function audio(track: MediaStreamTrack) {
			if (closed) {
				track.stop();
				return;
			}
			// The sidecar has exactly one audio output track; reject an unexpected second stream.
			if (remoteTrack) {
				track.stop();
				disconnected(new Error("Unexpected remote audio track"));
				return;
			}
			remoteTrack = track;
			track.onended = () => disconnected(new Error("Remote audio disconnected"));
			try {
				if (!context || context.state !== "running")
					throw new VoiceDiagnosticError({ stage: "media", code: "denied" });
				const remote = new MediaStream([track]);
				options.onRemoteStream?.(remote);
				// Chromium needs a media element to pull/decode remote RTC audio (crbug.com/40094084).
				// Muted here: only the analyser -> destination graph produces audible output.
				decoder = new Audio();
				decoder.muted = true;
				decoder.srcObject = remote;
				void decoder.play().catch(disconnected);
				source = context.createMediaStreamSource(remote);
				analyser = context.createAnalyser();
				analyser.fftSize = 512;
				source.connect(analyser);
				analyser.connect(context.destination);
				const samples = new Float32Array(analyser.fftSize);
				meter = setInterval(() => {
					if (closed || !analyser || context?.state !== "running") return;
					analyser.getFloatTimeDomainData(samples);
					let sum = 0;
					for (const sample of samples) sum += sample * sample;
					const rms = Math.sqrt(sum / samples.length);
					if (rms < (options.rmsThreshold ?? 0.001)) return;
					lastPcmAt = now();
					observer.pcm({ observedAt: lastPcmAt, rms, basis: "webaudio-output-analyser" });
				}, 10);
			} catch (error) {
				disconnected(error);
			}
		}
		async function gather(connection: RTCPeerConnection) {
			if (connection.iceGatheringState === "complete") return;
			let cleanup = () => {};
			const complete = new Promise<void>((resolve) => {
				const changed = () => {
					if (connection.iceGatheringState === "complete") resolve();
				};
				connection.addEventListener("icegatheringstatechange", changed);
				cleanup = () => connection.removeEventListener("icegatheringstatechange", changed);
				changed();
			});
			try {
				await bounded(complete, lifetime.signal, options.iceTimeoutMs ?? 5000);
			} finally {
				cleanup();
			}
		}
		async function connected(connection: RTCPeerConnection) {
			if (connection.connectionState === "connected") return;
			let cleanup = () => {};
			const ready = new Promise<void>((resolve) => {
				const changed = () => {
					if (connection.connectionState === "connected") resolve();
				};
				connection.addEventListener("connectionstatechange", changed);
				cleanup = () => connection.removeEventListener("connectionstatechange", changed);
				changed();
			});
			try {
				await bounded(ready, lifetime.signal, options.connectionTimeoutMs ?? 10_000);
			} finally {
				cleanup();
			}
		}
		return {
			async connect(offer, signal) {
				if (peer || closed) throw new Error("A media handle can only connect once");
				if (signal.aborted) {
					close();
					throw aborted();
				}
				signal.addEventListener("abort", close, { once: true });
				removeAbort = () => signal.removeEventListener("abort", close);
				try {
					// Resume before the first await, while the caller's pointer/key gesture is active.
					context = options.createAudioContext?.() ?? new AudioContext();
					const resumed = context.resume();
					void resumed.catch(() => {});
					peer =
						options.createPeer?.({ iceServers: [] }) ?? new RTCPeerConnection({ iceServers: [] });
					const connection = peer;
					connection.ontrack = (event) => {
						if (event.track.kind === "audio") audio(event.track);
					};
					connection.onconnectionstatechange = () => {
						if (["disconnected", "failed", "closed"].includes(connection.connectionState))
							disconnected(new Error("Voice peer disconnected"));
					};
					connection.oniceconnectionstatechange = () => {
						if (["disconnected", "failed", "closed"].includes(connection.iceConnectionState))
							disconnected(new Error("Voice ICE disconnected"));
					};
					channel = connection.createDataChannel("pipecat");
					channel.onclose = () => disconnected(new Error("Voice data channel disconnected"));
					channel.onerror = () => disconnected(new Error("Voice data channel failed"));
					// No data channel commands: all identity-bearing service messages use the typed port.
					const getMicrophone =
						options.getUserMedia ??
						((constraints) => navigator.mediaDevices.getUserMedia(constraints));
					const permission = (async () => {
						try {
							return await getMicrophone({
								audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
								video: false,
							});
						} catch (error) {
							throw microphoneError(error);
						}
					})();
					// Permission cannot be aborted by browsers. Own and stop a late stream explicitly.
					void permission.then(
						(acquired) => {
							if (closed || captureStopped) for (const track of acquired.getTracks()) track.stop();
							else stream = acquired;
						},
						() => {}
					);
					stream = await bounded(
						permission,
						lifetime.signal,
						options.permissionTimeoutMs ?? 60_000,
						new VoiceDiagnosticError({ stage: "microphone", code: "timeout" })
					);
					ensureOpen();
					if (captureStopped) throw aborted();
					const tracks = stream.getAudioTracks();
					if (tracks.length !== 1) throw new Error("Expected one microphone track");
					for (const track of tracks) {
						track.addEventListener(
							"ended",
							() => {
								if (!captureStopped) disconnected(new Error("Microphone disconnected"));
							},
							{ once: true }
						);
						connection.addTrack(track, stream);
					}
					await bounded(resumed, lifetime.signal, 5000);
					ensureOpen();
					const description = await connection.createOffer();
					ensureOpen();
					await connection.setLocalDescription(description);
					ensureOpen();
					await gather(connection);
					ensureOpen();
					const local = connection.localDescription;
					if (!local?.sdp || local.type !== "offer") throw new Error("No local voice offer");
					const answer = VoiceAnswerSchema.parse(await offer({ type: "offer", sdp: local.sdp }));
					ensureOpen();
					await connection.setRemoteDescription(answer);
					ensureOpen();
					await connected(connection);
					ensureOpen();
				} catch (error) {
					close();
					throw error;
				}
			},
			stopCapture,
			async drain(signal) {
				const startedAt = now();
				// Sidecar completion is a send boundary, not a playout boundary. Allow jitter-buffer tail.
				while (!closed && (now() - startedAt < 300 || now() - lastPcmAt < 180)) {
					if (now() - startedAt >= 10_000) throw new Error("Remote audio did not drain");
					await delay(20, signal);
				}
				if (closed || signal.aborted) throw aborted();
			},
			close,
		};
	};
}
