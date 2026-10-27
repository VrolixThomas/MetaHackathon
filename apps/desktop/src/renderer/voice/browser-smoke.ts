/** Isolated Chromium smoke. Uses fake microphone + local oscillator; no live STT/TTS/provider. */
import type { SpeakInput, VoiceEvent } from "../../main/voice/protocol";
import type { TurnIdentity } from "../../shared/contracts";
import { createBrowserMediaFactory } from "./browser-media";
import { createVoiceController } from "./controller";
import type { LatencyObservation, VoiceController } from "./types";

function check(value: unknown, message: string): asserts value {
	if (!value) throw new Error(message);
}
async function until(predicate: () => boolean) {
	const deadline = performance.now() + 10_000;
	while (!predicate()) {
		check(performance.now() < deadline, "Chromium condition timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
async function gather(peer: RTCPeerConnection) {
	await until(() => peer.iceGatheringState === "complete");
}
function identity(value: TurnIdentity): TurnIdentity {
	return { sessionId: value.sessionId, turnId: value.turnId, generation: value.generation };
}

async function smoke() {
	const outputContexts: AudioContext[] = [];
	const serverContexts: AudioContext[] = [];
	const localPeers: RTCPeerConnection[] = [];
	const serverPeers: RTCPeerConnection[] = [];
	const microphones: MediaStream[] = [];
	const events: VoiceEvent[] = [];
	const speeches: SpeakInput[] = [];
	const latencies: LatencyObservation[] = [];
	const errors: string[] = [];
	const timers: ReturnType<typeof setTimeout>[] = [];
	let dataLabel = "";
	let gain: GainNode | null = null;
	let offerReady = false;
	let controller: VoiceController | null = null;
	try {
		const media = createBrowserMediaFactory({
			createPeer: (configuration) => {
				check(configuration.iceServers?.length === 0, "STUN was configured");
				const peer = new RTCPeerConnection(configuration);
				localPeers.push(peer);
				return peer;
			},
			createAudioContext: () => {
				const context = new AudioContext();
				outputContexts.push(context);
				return context;
			},
			getUserMedia: async (constraints) => {
				const stream = await navigator.mediaDevices.getUserMedia(constraints);
				microphones.push(stream);
				return stream;
			},
		});
		controller = createVoiceController({
			media,
			acknowledgementText: "Received.",
			getScreenContext: () => ({
				prId: "smoke-pr",
				sequence: 1,
				panel: "diff",
				focusedLocation: null,
			}),
			onLatency: (value) => {
				latencies.push(value);
			},
			onError: (error) => {
				errors.push(error.message);
			},
			voice: {
				offer: async (input) => {
					const remote = new RTCPeerConnection({ iceServers: [] });
					serverPeers.push(remote);
					remote.ondatachannel = (event) => {
						dataLabel = event.channel.label;
					};
					await remote.setRemoteDescription({ type: input.type, sdp: input.sdp });
					const serverContext = new AudioContext();
					serverContexts.push(serverContext);
					await serverContext.resume();
					const oscillator = serverContext.createOscillator();
					oscillator.frequency.value = 440;
					gain = serverContext.createGain();
					gain.gain.value = 0;
					const destination = serverContext.createMediaStreamDestination();
					oscillator.connect(gain);
					gain.connect(destination);
					oscillator.start();
					for (const track of destination.stream.getTracks())
						remote.addTrack(track, destination.stream);
					await remote.setLocalDescription(await remote.createAnswer());
					await gather(remote);
					check(remote.localDescription?.sdp, "No server SDP");
					offerReady = true;
					return { type: "answer", sdp: remote.localDescription.sdp };
				},
				release: async (input) => {
					events.push({
						...input,
						sequence: events.length + 1,
						kind: "transcript",
						text: "Synthetic smoke question",
						final: true,
					});
				},
				speak: async (input) => {
					speeches.push(input);
					events.push({
						...identity(input),
						sequence: events.length + 1,
						kind: "speech-started",
						speechId: input.speechId,
					});
					check(gain, "No server audio graph");
					const speechGain = gain;
					speechGain.gain.value = 0.03;
					timers.push(
						setTimeout(() => {
							speechGain.gain.value = 0;
							events.push({
								...identity(input),
								sequence: events.length + 1,
								kind: "speech-ended",
								speechId: input.speechId,
							});
						}, 350)
					);
				},
				poll: async (input) => ({
					events: events.filter(
						(event) => event.sequence > input.afterSequence && event.turnId === input.turnId
					),
				}),
				cancel: async () => {},
			},
			agent: {
				start: async (input) => ({ ...identity(input), status: "running" }),
				poll: async (input) => ({
					...identity(input),
					status: "completed",
					sequence: 3,
					text: "Synthetic answer.",
					actions: [],
					events: [
						{
							...identity(input),
							sequence: 1,
							kind: "acknowledgement",
							text: "Do not repeat acknowledgement.",
						} as const,
						{
							...identity(input),
							sequence: 2,
							kind: "text-delta",
							delta: "Synthetic answer.",
						} as const,
						{ ...identity(input), sequence: 3, kind: "completed" } as const,
					].filter((event) => event.sequence > input.afterSequence),
				}),
				cancel: async (input) => ({
					...identity(input),
					requestId: input.requestId,
					status: "cancelled",
				}),
			},
		});
		controller.beginCapture();
		await until(
			() => offerReady && dataLabel === "pipecat" && controller?.getPhase() === "listening"
		);
		controller.endCapture();
		await until(() => controller?.getPhase() === "idle" || controller?.getPhase() === "error");
		check(errors.length === 0, errors.join("; "));
		check(speeches.length === 2, "Expected exactly one acknowledgement and one answer");
		check(
			latencies.length === 2 &&
				latencies[0]?.kind === "acknowledgement" &&
				latencies[1]?.kind === "answer",
			`Missing separate PCM observations: ${JSON.stringify({ latencies, contexts: serverContexts.map((c) => c.state) })}`
		);
		check(
			microphones.every((stream) =>
				stream.getTracks().every((track) => track.readyState === "ended")
			),
			"Microphone still active"
		);
		check(
			localPeers.every((peer) => peer.connectionState === "closed"),
			"Peer still active"
		);
		const completedPcm = latencies.slice();
		controller.beginCapture();
		await until(() => controller?.getPhase() === "listening");
		controller.endCapture();
		await until(() => speeches.length === 3);
		check(controller.getPhase() === "speaking", "Expected active speech before interruption");
		controller.beginCapture();
		check(localPeers[1]?.connectionState === "closed", "Interrupted peer survived");
		check(localPeers.length === 3, "Next generation reused its peer");
		controller.endCapture(); // key-up during the new permission/negotiation setup
		await new Promise((resolve) => setTimeout(resolve, 600));
		check(controller.getPhase() === "cancelled", "Late media resumed a cancelled capture");
		check(
			localPeers.every((peer) => peer.connectionState === "closed"),
			"Cancelled peer survived"
		);
		check(
			microphones.every((stream) =>
				stream.getTracks().every((track) => track.readyState === "ended")
			),
			"Cancelled microphone survived"
		);

		// Real getUserMedia resolves after key-up; the returned track must be stopped immediately.
		let permit!: () => void;
		const gate = new Promise<void>((resolve) => {
			permit = resolve;
		});
		let lateStream: MediaStream | null = null;
		const lateMedia = createBrowserMediaFactory({
			getUserMedia: async (constraints) => {
				await gate;
				const stream = await navigator.mediaDevices.getUserMedia(constraints);
				lateStream = stream;
				return stream;
			},
		});
		let unexpectedOffer = false;
		const handle = lateMedia({
			pcm: () => {
				throw new Error("Late audio");
			},
			disconnected: () => {},
		});
		const connecting = handle
			.connect(async () => {
				unexpectedOffer = true;
				return { type: "answer", sdp: "unused" };
			}, new AbortController().signal)
			.catch(() => {});
		handle.close();
		permit();
		await connecting;
		await until(
			() =>
				lateStream !== null &&
				(lateStream as MediaStream).getTracks().every((track) => track.readyState === "ended")
		);
		check(!unexpectedOffer, "Late permission resumed negotiation");
		return {
			ok: true,
			synthetic: true,
			dataChannel: dataLabel,
			speeches: speeches.length,
			measurementScope:
				"synthetic localhost oscillator; not a live provider benchmark or acoustic measurement",
			pcmObservations: completedPcm,
			checks: [
				"real localhost WebRTC",
				"fake microphone release",
				"serial speech",
				"separate acknowledgement/answer PCM",
				"closed peer and mic",
				"late permission stopped",
				"begin during speech creates a fresh peer",
				"keyup during setup never resumes",
			],
		};
	} finally {
		controller?.dispose();
		for (const timer of timers) clearTimeout(timer);
		for (const peer of [...localPeers, ...serverPeers]) peer.close();
		for (const context of outputContexts) if (context.state !== "closed") await context.close();
		for (const context of serverContexts) if (context.state !== "closed") await context.close();
	}
}

declare global {
	interface Window {
		voiceSmoke: Promise<unknown>;
	}
}
window.voiceSmoke = smoke().catch((error: unknown) => ({
	ok: false,
	error: error instanceof Error ? error.stack : String(error),
}));
