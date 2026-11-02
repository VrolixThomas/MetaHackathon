// Synthetic local capture only. Actual remote RTC output, Web Audio and PCM observer stay intact.
function installSyntheticInput() {
	const NativeContext = window.AudioContext;
	const tracks = [];
	const contexts = [];
	let gain;
	Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
		configurable: true,
		value: async (constraints) => {
			if (constraints.video !== false || !constraints.audio) throw Error("Unexpected capture");
			const context = new NativeContext();
			await context.resume();
			const oscillator = context.createOscillator();
			gain = context.createGain();
			gain.gain.value = 0;
			oscillator.frequency.value = 220;
			const destination = context.createMediaStreamDestination();
			oscillator.connect(gain);
			gain.connect(destination);
			oscillator.start();
			contexts.push(context);
			const track = destination.stream.getAudioTracks()[0];
			tracks.push(track);
			return destination.stream;
		},
	});
	window.__rehearsal = {
		async pulse(milliseconds = 400) {
			if (!gain) throw Error("Start the listening session first");
			gain.gain.value = 0.12;
			await new Promise((resolve) => setTimeout(resolve, milliseconds));
			gain.gain.value = 0;
		},
		read() {
			return {
				syntheticInput: true,
				tracks: tracks.map((track) => track.readyState),
				contexts: contexts.map((context) => context.state),
			};
		},
	};
}
module.exports = { installSyntheticInput };
