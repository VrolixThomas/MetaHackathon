import assert from "node:assert/strict";
import { test } from "node:test";
import { VoiceDiagnosticError } from "../../main/voice/diagnostics";
import { createBrowserMediaFactory } from "./browser-media";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}

function browser() {
	const track = Object.assign(new EventTarget(), {
		kind: "audio",
		readyState: "live",
		stop() {
			this.readyState = "ended";
		},
	});
	const stream = {
		getTracks: () => [track],
		getAudioTracks: () => [track],
	} as unknown as MediaStream;
	const channel = {
		label: "",
		onclose: null as (() => void) | null,
		onerror: null as (() => void) | null,
		closed: false,
		close() {
			this.closed = true;
			this.onclose?.();
		},
	};
	const context = {
		state: "running",
		resume: async () => {},
		close: async () => {
			context.state = "closed";
		},
	};
	const peer = Object.assign(new EventTarget(), {
		connectionState: "new",
		iceConnectionState: "new",
		iceGatheringState: "complete",
		ontrack: null,
		onconnectionstatechange: null as (() => void) | null,
		oniceconnectionstatechange: null as (() => void) | null,
		localDescription: null as RTCSessionDescriptionInit | null,
		remote: null as RTCSessionDescriptionInit | null,
		tracks: [] as MediaStreamTrack[],
		createDataChannel(label: string) {
			channel.label = label;
			return channel;
		},
		addTrack(value: MediaStreamTrack) {
			this.tracks.push(value);
		},
		createOffer: async () => ({ type: "offer", sdp: "initial" }),
		async setLocalDescription() {
			this.localDescription = { type: "offer", sdp: "gathered-with-candidates" };
		},
		async setRemoteDescription(value: RTCSessionDescriptionInit) {
			this.remote = value;
			this.connectionState = "connected";
		},
		close() {
			this.connectionState = "closed";
			this.onconnectionstatechange?.();
		},
	});
	const configurations: RTCConfiguration[] = [];
	let permission: () => Promise<MediaStream> = async () => stream;
	const errors: Error[] = [];
	const factory = createBrowserMediaFactory({
		getUserMedia: () => permission(),
		createPeer: (configuration) => {
			configurations.push(configuration);
			return peer as unknown as RTCPeerConnection;
		},
		createAudioContext: () => context as unknown as AudioContext,
	});
	const media = factory({
		pcm: () => {},
		disconnected: (error) => {
			errors.push(error);
		},
	});
	return {
		media,
		track,
		stream,
		peer,
		context,
		channel,
		configurations,
		errors,
		setPermission: (value: typeof permission) => {
			permission = value;
		},
	};
}

test("browser media stops late permission stream after close without negotiating", async () => {
	const b = browser();
	const permission = deferred<MediaStream>();
	b.setPermission(() => permission.promise);
	let offers = 0;
	const pending = b.media.connect(async () => {
		offers++;
		return { type: "answer", sdp: "answer" };
	}, new AbortController().signal);
	b.media.close();
	await assert.rejects(pending, { name: "AbortError" });
	permission.resolve(b.stream);
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(b.track.readyState, "ended");
	assert.equal(offers, 0);
	assert.equal(b.peer.connectionState, "closed");
	assert.equal(b.context.state, "closed");
});

test("microphone denial, missing device and unavailable device have precise safe messages", async () => {
	for (const [name, code, message] of [
		["NotAllowedError", "denied", /blocked for this app/],
		["NotFoundError", "not-found", /No microphone/],
		["NotReadableError", "busy", /unavailable or in use/],
	] as const) {
		const b = browser();
		b.setPermission(async () => {
			throw new DOMException("private-device-detail", name);
		});
		await assert.rejects(
			b.media.connect(
				async () => ({ type: "answer", sdp: "unused" }),
				new AbortController().signal
			),
			(error: Error) => {
				assert.ok(error instanceof VoiceDiagnosticError);
				assert.deepEqual(error.diagnostic, { stage: "microphone", code });
				assert.match(error.message, message);
				assert.equal(error.message.includes("private-device-detail"), false);
				return true;
			}
		);
		assert.equal(b.peer.connectionState, "closed");
	}
});

test("browser offer has gathered SDP, mic track, pipecat channel, no STUN; release preserves receiving peer", async () => {
	const b = browser();
	const abort = new AbortController();
	await b.media.connect(async (offer) => {
		assert.deepEqual(offer, { type: "offer", sdp: "gathered-with-candidates" });
		return { type: "answer", sdp: "answer" };
	}, abort.signal);
	assert.deepEqual(b.configurations, [{ iceServers: [] }]);
	assert.equal(b.channel.label, "pipecat");
	assert.equal(b.peer.tracks.length, 1);
	assert.deepEqual(b.peer.remote, { type: "answer", sdp: "answer" });
	b.media.stopCapture();
	assert.equal(b.track.readyState, "ended");
	assert.notEqual(b.peer.connectionState, "closed");
	assert.equal(b.channel.closed, false);
	abort.abort();
	assert.equal(b.channel.closed, true);
	assert.equal(b.peer.connectionState, "closed");
	assert.equal(b.errors.length, 0);
});

test("late signaling answer cannot install a remote description on a closed peer", async () => {
	const b = browser();
	const answer = deferred<{ type: "answer"; sdp: string }>();
	const offered = deferred<void>();
	const pending = b.media.connect(() => {
		offered.resolve();
		return answer.promise;
	}, new AbortController().signal);
	await offered.promise;
	b.media.close();
	answer.resolve({ type: "answer", sdp: "late" });
	await assert.rejects(pending, { name: "AbortError" });
	assert.equal(b.peer.remote, null);
});

test("disconnect tears down all local resources once and reports failure", async () => {
	const b = browser();
	await b.media.connect(
		async () => ({ type: "answer", sdp: "answer" }),
		new AbortController().signal
	);
	b.peer.connectionState = "disconnected";
	b.peer.onconnectionstatechange?.();
	b.channel.onerror?.();
	assert.equal(b.errors.length, 1);
	assert.equal(b.track.readyState, "ended");
	assert.equal(b.context.state, "closed");
	assert.equal(b.channel.closed, true);
});

test("cancellation between permission settlement and continuation stops the microphone", async () => {
	const b = browser();
	b.peer.iceGatheringState = "gathering";
	const abort = new AbortController();
	const pending = b.media.connect(async () => ({ type: "answer", sdp: "answer" }), abort.signal);
	await Promise.resolve();
	abort.abort();
	await assert.rejects(pending);
	assert.equal(b.track.readyState, "ended");
	assert.equal(b.peer.connectionState, "closed");
});

test("browser connect waits for actual peer connection and aborts negotiation cleanly", async () => {
	const b = browser();
	const abort = new AbortController();
	b.peer.setRemoteDescription = async (value) => {
		b.peer.remote = value;
		b.peer.connectionState = "connecting";
	};
	let ready = false;
	const connecting = b.media
		.connect(async () => ({ type: "answer", sdp: "answer" }), abort.signal)
		.then(() => {
			ready = true;
		});
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(ready, false);
	assert.equal(b.peer.connectionState, "connecting");
	b.peer.connectionState = "connected";
	b.peer.dispatchEvent(new Event("connectionstatechange"));
	await connecting;
	assert.equal(ready, true);
	b.media.close();
});
