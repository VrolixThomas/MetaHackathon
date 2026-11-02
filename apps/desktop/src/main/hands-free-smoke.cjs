// ROOT ONLY after default hands-free binding is built. Worker: --check / --self-check only.
// env -u ELECTRON_RUN_AS_NODE electron src/main/hands-free-smoke.cjs [built-main]
// Optional HANDS_FREE_STOP=escape and HANDS_FREE_MODAL_CHECKS=1 extend the same bounded run.
// This legacy controlled media transport tests the cold path; the package script explicitly
// builds VITE_MUSE_VOICE_PRECONNECT=0. Warm-path actual-provider evidence is recorded separately.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const { randomUUID } = require("node:crypto");
const { tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const endpoint = "https://api.meta.ai/v1/responses";
const transcripts = ["First controlled utterance.", "Second controlled utterance."];
const answers = ["First controlled answer. ", "Second controlled answer."];
const lateText = "LATE_CANCELLED_HANDS_FREE_OUTPUT";
const identity = (value) => ({
	sessionId: value.sessionId,
	turnId: value.turnId,
	generation: value.generation,
});
const key = (value) => JSON.stringify(identity(value));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
function assertWorkspaceRequest(body) {
	for (const name of ["inspect_workspace", "expand_tools", "open_command_center"])
		assert.ok(body.tools.some((tool) => tool.name === name));
	assert.equal(body.tool_choice, "auto");
	const packet = JSON.parse(body.input.at(-1).content[0].text);
	const context = packet.actualWorkspace;
	assert.equal(context.workspace.review.prId, null);
	assert.equal(context.workspace.canvases[0].kind, "center");
	assert.equal(context.workspace.centerSection, "home");
	assert.deepEqual(context.reviews, []);
	if (packet.actualHub.jobs !== undefined) assert.deepEqual(packet.actualHub.jobs, []);
	if (packet.actualHub.counts) assert.equal(packet.actualHub.counts.pendingDecisions, 0);
}
function measure(samples, rate) {
	let energy = 0;
	let crossings = 0;
	for (let i = 0; i < samples.length; i++) {
		energy += samples[i] ** 2;
		if (i && samples[i] >= 0 !== samples[i - 1] >= 0) crossings++;
	}
	return { rms: Math.sqrt(energy / samples.length), hz: (crossings * rate) / (2 * samples.length) };
}

// Runs in the actual built app renderer before Start. Constructors still create real
// Chromium objects. Observers never alter PCM, controller methods or the default binding.
function installMedia(observeSamples) {
	const NativeContext = window.AudioContext;
	const NativePeer = window.RTCPeerConnection;
	const NativeWorklet = window.AudioWorkletNode;
	const microphones = [];
	const contexts = [];
	const peers = [];
	const outputs = [];
	const worklets = [];
	const remotes = [];
	const timers = new Set();
	let sequence = 0;
	const analyse = (samples, rate, stats) => {
		const value = observeSamples(samples, rate);
		stats.reads++;
		stats.rms = value.rms;
		// Opus startup transients can briefly cross the other marker's band. Require
		// sustained decoded tone before assigning order, without altering the audio.
		stats.lowStreak =
			value.rms > 0.02 && value.hz > 420 && value.hz < 580 ? (stats.lowStreak ?? 0) + 1 : 0;
		stats.highStreak =
			value.rms > 0.02 && value.hz > 820 && value.hz < 980 ? (stats.highStreak ?? 0) + 1 : 0;
		if (value.rms > 0.008) {
			stats.nonSilent++;
			stats.lastNonSilentAt = performance.now();
			if (value.hz > 420 && value.hz < 580) {
				stats.low++;
				if (stats.lowStreak >= 4) stats.firstLowAt ??= performance.now();
			}
			if (value.hz > 820 && value.hz < 980) {
				stats.high++;
				if (stats.highStreak >= 4) stats.firstHighAt ??= performance.now();
			}
		}
	};
	const counters = () => ({ reads: 0, nonSilent: 0, low: 0, high: 0, rms: 0 });
	window.AudioContext = class extends NativeContext {
		constructor(...args) {
			super(...args);
			contexts.push(this);
			const create = this.createAnalyser.bind(this);
			this.createAnalyser = () => {
				const node = create();
				const read = node.getFloatTimeDomainData.bind(node);
				const stats = { ...counters(), peer: peers.length - 1 };
				outputs.push(stats);
				node.getFloatTimeDomainData = (samples) => {
					read(samples);
					analyse(samples, this.sampleRate, stats);
				};
				return node;
			};
		}
	};
	window.RTCPeerConnection = class extends NativePeer {
		constructor(options) {
			if (options?.iceServers?.length) throw Error("Smoke forbids STUN/TURN");
			super(options);
			peers.push(this);
		}
	};
	window.AudioWorkletNode = class extends NativeWorklet {
		constructor(context, name, options) {
			super(context, name, options);
			const stats = { name, frames: 0, drained: 0 };
			worklets.push(stats);
			this.port.addEventListener("message", ({ data }) => {
				if (data?.type === "frame") stats.frames++;
				if (data?.type === "drained") stats.drained++;
			});
			this.port.start();
		}
	};
	Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
		configurable: true,
		value: async (constraints) => {
			if (constraints.video !== false || !constraints.audio)
				throw Error("Unexpected capture constraints");
			const context = new NativeContext();
			await context.resume();
			const oscillator = context.createOscillator();
			const gain = context.createGain();
			const destination = context.createMediaStreamDestination();
			gain.gain.value = 0;
			oscillator.connect(gain);
			gain.connect(destination);
			oscillator.start();
			const stream = destination.stream;
			const track = stream.getAudioTracks()[0];
			const mic = { context, oscillator, gain, stream, track, stops: 0 };
			microphones.push(mic);
			const stop = track.stop.bind(track);
			track.stop = () => {
				mic.stops++;
				stop();
			};
			return stream;
		},
	});
	window.__handsSmoke = {
		drive(parts) {
			const mic = microphones.at(-1);
			if (!mic) throw Error("Start has not acquired synthetic microphone");
			let at = mic.context.currentTime + 0.05;
			const startedAt = performance.now() + 50;
			mic.gain.gain.cancelScheduledValues(mic.context.currentTime);
			mic.gain.gain.setValueAtTime(0, mic.context.currentTime);
			for (const [hz, ms] of parts) {
				mic.oscillator.frequency.setValueAtTime(hz, at);
				mic.gain.gain.setValueAtTime(0.14, at);
				at += ms / 1000;
			}
			mic.gain.gain.setValueAtTime(0, at);
			return {
				startedAt,
				prefixEndedAt: startedAt + parts[0][1],
				endedAt: startedAt + parts.reduce((sum, p) => sum + p[1], 0),
			};
		},
		async answer(input, number) {
			const local = peers.findIndex((peer) => peer.localDescription?.sdp === input.sdp);
			if (local < 0) throw Error("Offer did not come from the default product RTC peer");
			const peer = new NativePeer({ iceServers: [] });
			const context = new NativeContext();
			await context.resume();
			const remote = {
				peer,
				context,
				number,
				local,
				input: counters(),
				channel: "",
				cancelled: false,
			};
			remotes.push(remote);
			peer.ondatachannel = (event) => {
				remote.channel = event.channel.label;
			};
			peer.ontrack = ({ track }) => {
				const source = context.createMediaStreamSource(new MediaStream([track]));
				const analyser = context.createAnalyser();
				const muted = context.createGain();
				analyser.fftSize = 2048;
				muted.gain.value = 0;
				source.connect(analyser);
				analyser.connect(muted);
				muted.connect(context.destination);
				const samples = new Float32Array(analyser.fftSize);
				const timer = setInterval(() => {
					analyser.getFloatTimeDomainData(samples);
					analyse(samples, context.sampleRate, remote.input);
				}, 10);
				timers.add(timer);
				remote.timer = timer;
			};
			await peer.setRemoteDescription({ type: "offer", sdp: input.sdp });
			const oscillator = context.createOscillator();
			const gain = context.createGain();
			const destination = context.createMediaStreamDestination();
			oscillator.frequency.value = 300;
			gain.gain.value = 0;
			oscillator.connect(gain);
			gain.connect(destination);
			oscillator.start();
			remote.gain = gain;
			for (const track of destination.stream.getTracks()) peer.addTrack(track, destination.stream);
			await peer.setLocalDescription(await peer.createAnswer());
			const end = performance.now() + 5000;
			while (peer.iceGatheringState !== "complete") {
				if (performance.now() > end) throw Error("Counterpart ICE timeout");
				await new Promise((done) => setTimeout(done, 10));
			}
			return { type: "answer", sdp: peer.localDescription.sdp };
		},
		markAnswer(number) {
			const remote = remotes.find((item) => item.number === number);
			remote.answerReturnedAt = performance.now();
		},
		speak(number, enabled) {
			const remote = remotes.find((item) => item.number === number);
			if (remote && remote.context.state !== "closed") remote.gain.gain.value = enabled ? 0.05 : 0;
		},
		cancel(number) {
			const remote = remotes.find((item) => item.number === number);
			if (!remote || remote.cancelled) return;
			remote.cancelled = true;
			remote.clientClosedAtCancel = peers[remote.local].connectionState === "closed";
			// Keep the remote sending briefly: the product must mute/close locally first.
			const timer = setTimeout(() => {
				remote.peer.close();
				void remote.context.close().catch(() => {});
				clearInterval(remote.timer);
				timers.delete(remote.timer);
			}, 500);
			timers.add(timer);
		},
		read() {
			return {
				sequence: ++sequence,
				microphones: microphones.map((mic) => ({ state: mic.track.readyState, stops: mic.stops })),
				contexts: contexts.map((context) => context.state),
				peers: peers.map((peer) => ({ state: peer.connectionState, ice: peer.iceConnectionState })),
				outputs,
				worklets,
				remotes: remotes.map((remote) => ({
					number: remote.number,
					local: remote.local,
					input: remote.input,
					channel: remote.channel,
					answerReturnedAt: remote.answerReturnedAt,
					clientClosedAtCancel: remote.clientClosedAtCancel,
				})),
			};
		},
		async dispose() {
			for (const timer of timers) {
				clearInterval(timer);
				clearTimeout(timer);
			}
			for (const peer of peers) peer.close();
			for (const remote of remotes) {
				remote.peer.close();
				await remote.context.close().catch(() => {});
			}
			for (const mic of microphones) {
				for (const track of mic.stream.getTracks()) track.stop();
				await mic.context.close();
			}
		},
	};
}

async function native() {
	const { app, BrowserWindow } = require("electron");
	assert.ok(process.versions.electron && !process.env.ELECTRON_RENDERER_URL);
	app.on("browser-window-created", (_event, win) => {
		win.setIgnoreMouseEvents(true);
		win.setFocusable(false);
	});
	// Privacy fallback only. Passing assertions still require our single injected stream.
	app.commandLine.appendSwitch("use-fake-device-for-media-stream");
	const owned = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "met-hands-free-smoke-")));
	const owner = randomUUID();
	fs.writeFileSync(join(owned, ".owner"), owner);
	const envPath = join(owned, ".env");
	fs.writeFileSync(
		envPath,
		"MODEL_API_KEY=hands-free-smoke-meta\nELEVENLABS_API_KEY=hands-free-smoke-eleven\nELEVENLABS_VOICE_ID=hands-free-smoke-public-id\n",
		{ mode: 0o600 }
	);
	process.env.METAHACKATHON_ENV_FILE = envPath;
	app.setPath("userData", owned);
	const reportPath = join(__dirname, "../../out/hands-free-smoke-report.json");
	fs.mkdirSync(dirname(reportPath), { recursive: true });
	const report = {
		status: "running",
		simulatedSTT: true,
		simulatedModel: true,
		simulatedTTS: true,
		simulatedReadiness: false,
		actualChromiumMedia: false,
		liveSpeech: false,
		acousticVerification: false,
		physicalSpeakerMutedForTest: true,
		input: "controlled WebAudio stream, never ambient",
		userData: owned,
		offers: [],
		releases: [],
		speaks: [],
		cancels: [],
		model: [],
		blocked: [],
	};
	const save = () => fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
	save();
	let win;
	let sidecarPort;
	let releaseOffer;
	let lateModel;
	const sessions = new Map();
	const timers = new Set();
	const js = (code) => win.webContents.executeJavaScript(code);
	const media = () => js("window.__handsSmoke.read()");
	async function wait(label, predicate, timeout = 12_000) {
		const end = Date.now() + timeout;
		while (Date.now() < end) {
			const result = await predicate();
			if (result) return result;
			await sleep(30);
		}
		throw new Error(`Timed out: ${label}`);
	}
	const event = (session, kind, fields) =>
		session.events.push({
			...session.identity,
			sequence: session.events.length + 1,
			kind,
			...fields,
		});
	const forward = globalThis.fetch;
	globalThis.fetch = async (input, options = {}) => {
		const url = new URL(String(input.url ?? input));
		if (url.href === endpoint) {
			const body = JSON.parse(options.body);
			const index = report.model.length;
			assert.ok(index < 2);
			assertWorkspaceRequest(body);
			assert.equal(
				body.input.findLast((item) => item.role === "user" && typeof item.content === "string")
					?.content,
				transcripts[index]
			);
			const entry = { index, cancelled: false, signalAborted: false };
			report.model.push(entry);
			options.signal.addEventListener(
				"abort",
				() => {
					entry.signalAborted = true;
				},
				{ once: true }
			);
			const complete = (text) => ({
				type: "response.completed",
				response: {
					id: `controlled-${index}`,
					model: body.model,
					status: "completed",
					output: [
						{ type: "message", role: "assistant", content: [{ type: "output_text", text }] },
					],
					usage: null,
				},
			});
			const encode = (value) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
			if (!index && process.env.HANDS_FREE_AGENT_FAILURE === "1") {
				return new Response(
					`data: ${JSON.stringify({
						type: "response.incomplete",
						response: {
							id: "controlled-agent-failure",
							model: body.model,
							status: "incomplete",
							output: [],
							incomplete_details: { reason: "controlled-provider-failure" },
							usage: { input_tokens: 4410, output_tokens: body.max_output_tokens },
						},
					})}\n\n`,
					{ headers: { "content-type": "text/event-stream" } }
				);
			}
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(
							encode({ type: "response.output_text.delta", delta: answers[index] })
						);
						// Tool-capable prose is buffered until completion; then barge in during PCM playback.
						controller.enqueue(encode(complete(answers[index])));
						controller.close();
						if (!index)
							lateModel = () => {
								entry.lateAttempted = true;
								try {
									controller.enqueue(
										encode({ type: "response.output_text.delta", delta: lateText })
									);
								} catch {
									/* Actual reader already cancelled. */
								}
							};
					},
					cancel() {
						entry.cancelled = true;
					},
				}),
				{ headers: { "content-type": "text/event-stream" } }
			);
		}
		if (
			url.protocol === "http:" &&
			url.hostname === "127.0.0.1" &&
			["/offer", "/release", "/speak", "/poll", "/cancel"].includes(url.pathname)
		) {
			assert.equal(options.method, "POST");
			assert.equal(url.search, "");
			sidecarPort ??= Number(url.port);
			assert.equal(Number(url.port), sidecarPort);
			const body = JSON.parse(options.body);
			const id = key(body);
			const route = url.pathname;
			let session = sessions.get(id);
			if (route === "/offer") {
				assert.ok(!session);
				session = {
					identity: identity(body),
					number: sessions.size + 1,
					events: [],
					cancelled: false,
				};
				sessions.set(id, session);
				report.offers.push(session.identity);
				const answer = await js(
					`window.__handsSmoke.answer(${JSON.stringify(body)},${session.number})`
				);
				if (session.number === 1) await sleep(1500);
				if (session.number === 3)
					await new Promise((done) => {
						releaseOffer = done;
					});
				await js(`window.__handsSmoke.markAnswer(${session.number})`);
				return Response.json(answer);
			}
			if (route === "/cancel") {
				report.cancels.push(identity(body));
				if (session) {
					session.cancelled = true;
					await js(`window.__handsSmoke.cancel(${session.number})`);
				}
				return Response.json({});
			}
			assert.ok(session, "Voice request preceded its actual offer");
			if (route === "/poll")
				return Response.json({
					events: session.events.filter((item) => item.sequence > body.afterSequence),
				});
			assert.ok(!session.cancelled);
			if (route === "/release") {
				assert.ok(session.number <= 2, "Stopped late turn must never submit");
				const captured = (await media()).remotes.find((item) => item.number === session.number);
				assert.ok(captured.input.nonSilent > 2, "Actual RTC input PCM missing");
				if (session.number === 1) {
					assert.ok(captured.input.low > 0 && captured.input.high > 0);
					assert.ok(captured.input.firstLowAt < captured.input.firstHighAt);
				}
				report.releases.push({ ...session.identity, captured });
				event(session, "transcript", { text: transcripts[session.number - 1], final: true });
				return Response.json({});
			}
			assert.equal(route, "/speak");
			report.speaks.push({ ...session.identity, speechId: body.speechId });
			event(session, "speech-started", { speechId: body.speechId });
			await js(`window.__handsSmoke.speak(${session.number},true)`);
			if (session.number === 2)
				timers.add(
					setTimeout(() => {
						void js("window.__handsSmoke.speak(2,false)")
							.then(() => event(session, "speech-ended", { speechId: body.speechId }))
							.catch(() => {});
					}, 600)
				);
			return Response.json({});
		}
		if (
			url.protocol === "http:" &&
			!url.username &&
			!url.password &&
			["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
		)
			return forward(input, { ...options, redirect: "error" });
		report.blocked.push(url.origin);
		throw new Error("Hands-free smoke forbids external provider traffic");
	};
	let finishing = false;
	const quit = async (error) => {
		if (finishing) return;
		finishing = true;
		if (error) {
			report.status = "failed";
			report.error = String(error.message);
		}
		for (const timer of timers) clearTimeout(timer);
		releaseOffer?.();
		lateModel?.();
		if (win && !win.isDestroyed()) {
			try {
				report.finalMedia ??= await media();
				await js("window.__handsSmoke.dispose()");
			} catch {
				/* Startup may precede fixture installation. */
			}
		}
		save();
		app.quit();
	};
	const deadline = setTimeout(() => {
		void quit(new Error("120-second hands-free acceptance deadline"));
	}, 115_000);
	try {
		await import(
			pathToFileURL(resolve(process.argv[2] ?? join(__dirname, "../../out/main/index.js"))).href
		);
		await app.whenReady();
		app.once("will-quit", (event) => {
			event.preventDefault();
			clearTimeout(deadline);
			const stopped = sidecarPort
				? new Promise((done, reject) => {
						const socket = net.createConnection({ host: "127.0.0.1", port: sidecarPort });
						socket.setTimeout(1000);
						socket.once("connect", () => {
							socket.destroy();
							reject(Error("Owned readiness sidecar survived shutdown"));
						});
						socket.once("timeout", () => {
							socket.destroy();
							reject(Error("Sidecar shutdown check timed out"));
						});
						socket.once("error", (error) =>
							error.code === "ECONNREFUSED" ? done() : reject(error)
						);
					})
				: Promise.resolve();
			void stopped
				.then(() => {
					report.sidecarStopped = true;
				})
				.catch((error) => {
					report.status = "failed";
					report.error = error.message;
				})
				.finally(() => {
					try {
						const diagnosticPath = join(owned, "diagnostics/conversation.jsonl");
						const diagnosticText = fs.readFileSync(diagnosticPath, "utf8");
						for (const privateText of [
							...transcripts,
							...answers,
							"hands-free-smoke-meta",
							"hands-free-smoke-eleven",
						])
							assert.ok(
								!diagnosticText.includes(privateText),
								"Diagnostic log must not contain speech or credentials"
							);
						const diagnosticRows = diagnosticText
							.trim()
							.split("\n")
							.map((row) => JSON.parse(row));
						assert.ok(diagnosticRows.some((row) => row.stage === "first-audio"));
						assert.ok(diagnosticRows.some((row) => row.stage === "shutdown-complete"));
						if (report.agentFailureRecovered)
							assert.ok(
								diagnosticRows.some(
									(row) => row.stage === "turn-failed" && row.failureSource === "agent"
								)
							);
						report.diagnosticStages = diagnosticRows.map(
							({ stage, elapsedMs, releaseToAudioMs, failureSource }) => ({
								stage,
								elapsedMs,
								releaseToAudioMs,
								failureSource,
							})
						);
						report.privateDiagnosticsVerified = true;
						assert.equal(fs.readFileSync(join(owned, ".owner"), "utf8"), owner);
						fs.rmSync(owned, { recursive: true, maxRetries: 5, retryDelay: 100 });
						report.ownedTempRemoved = true;
					} catch (error) {
						report.status = "failed";
						report.error ??= error.message;
						report.cleanupError = error.message;
					}
					save();
					console.log(`HANDS_FREE_SMOKE_${report.status.toUpperCase()}: ${reportPath}`);
					app.exit(report.status === "passed" ? 0 : 1);
				});
		});
		win = await wait("main window", () => BrowserWindow.getAllWindows()[0]);
		win.setIgnoreMouseEvents(true);
		win.setFocusable(false);
		win.webContents.setAudioMuted(true);
		await wait("renderer", () => !win.webContents.isLoadingMainFrame());
		const rpc = async (type, path, input) => {
			const encoded =
				input === undefined
					? { json: null, meta: { values: ["undefined"], v: 1 } }
					: { json: input };
			const result = await js(
				`window.electron.trpc.request(${JSON.stringify({ type, path, input: encoded })})`
			);
			assert.ok(!result.error, path);
			return result.result.data.json;
		};
		const ui = () =>
			js(
				`(() => ({ armed:document.querySelector('footer.voice-bar')?.dataset.handsFree,phase:document.querySelector('main.conversation-main')?.dataset.conversationState,error:document.querySelector('.voice-bar-error')?.textContent||'',messages:[...document.querySelectorAll('article.exchange')].map(e=>({phase:e.dataset.phase,turnId:e.dataset.turnId,answer:e.querySelector('.assistant-message p')?.textContent||''})) }))()`
			);
		const config = await rpc("query", "app.config");
		const initialHub = await rpc("query", "hub.snapshot", {});
		for (const key of ["repositories", "reviews", "tickets", "jobs"])
			assert.deepEqual(initialHub[key], [], `Actual startup ${key} must be empty`);
		report.actualEmptyHubVerified = true;
		await wait("initial executive Home", () =>
			js(`document.querySelector('.hub-center')?.dataset.centerSection==='home'`)
		);
		report.centerHomeStartup = true;
		assert.equal(config.envPath, envPath);
		assert.equal(
			config.microphone,
			"granted",
			"Actual app microphone permission must be granted; this harness does not fake permission or capture ambient input"
		);
		await wait(
			"real local sidecar readiness",
			async () => {
				const state = await rpc("query", "voice.status");
				assert.notEqual(state.phase, "error", state.error);
				return state.phase === "ready";
			},
			50_000
		);
		report.localReadiness = true;
		await js(`(${installMedia.toString()})(${measure.toString()})`);
		await wait("default UI voice readiness and Start button", () =>
			js(
				`!!document.querySelector('[data-testid="voice-control"][aria-label="Start conversation"]') && document.querySelector('footer.voice-bar')?.innerText.includes('Voice ready')`
			)
		);
		await js(`document.querySelector('[data-testid="voice-control"]').click()`);
		await wait("persistent microphone armed", async () => {
			const state = await ui();
			assert.ok(!state.error, state.error);
			return state.armed === "true";
		});
		assert.equal((await media()).microphones.length, 1);
		await wait("actual AudioWorklet capture", async () =>
			(await media()).worklets.some((item) => item.name === "voice-hands-free" && item.frames > 4)
		);
		report.firstWaveform = await js("window.__handsSmoke.drive([[500,260],[900,460]])");
		const failingAgent = process.env.HANDS_FREE_AGENT_FAILURE === "1";
		if (failingAgent) {
			await wait(
				"agent failure returns to a live listening session",
				async () => {
					const state = await ui();
					return state.armed === "true" && state.messages.some((item) => item.phase === "error");
				},
				15000
			);
			assert.equal(report.model.length, 1, "Failed requests must not retry automatically");
			assert.equal((await media()).microphones[0].state, "live");
			report.agentFailureRecovered = true;
		} else
			await wait(
				"silence auto-submits and output PCM is decoded",
				async () =>
					report.releases.length === 1 &&
					(await media()).outputs.some((item) => item.peer === 0 && item.nonSilent > 3),
				15_000
			);
		const first = (await media()).remotes[0];
		assert.ok(first.answerReturnedAt > report.firstWaveform.prefixEndedAt);
		assert.equal(first.channel, "pipecat");
		report.prefixSurvivedDelayedOffer = true;
		if (process.env.HANDS_FREE_MODAL_CHECKS === "1" && !failingAgent) {
			await js(`document.querySelector('[data-testid="workspace-more"]').click()`);
			await wait("More dialog", () => js(`!!document.querySelector('#workspace-more[open]')`));
			await js(`document.querySelector('[data-testid="configuration-toggle"]').click()`);
			await wait("Settings dialog", () => js(`!!document.querySelector('#configuration[open]')`));
			win.setFocusable(true);
			win.focus();
			win.webContents.focus();
			win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
			win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
			await wait("modal Escape consumed", () => js(`!document.querySelector('dialog[open]')`));
			assert.equal((await ui()).armed, "true");
			assert.equal((await media()).microphones.length, 1);
			assert.equal(report.cancels.length, 0);
			win.setFocusable(false);
			report.modalEscapePreservedSession = true;
		}
		await js("window.__handsSmoke.drive([[700,600]])");
		if (!failingAgent) {
			await wait(
				"barge cancels speech and closes old product peer",
				async () =>
					report.cancels.some((item) => key(item) === key(report.offers[0])) &&
					(await media()).peers[0].state === "closed"
			);
			lateModel();
			assert.ok(report.cancels.some((item) => key(item) === key(report.offers[0])));
			report.bargeCancelled = true;
		}
		await wait(
			"second automatic turn completes",
			async () =>
				report.releases.length === 2 &&
				(await ui()).messages.some(
					(item) => item.turnId === report.offers[1]?.turnId && item.phase === "complete"
				),
			15_000
		);
		const second = await media();
		assert.equal(second.microphones.length, 1);
		assert.equal(second.microphones[0].state, "live");
		assert.equal(second.remotes[0].clientClosedAtCancel, true);
		assert.ok(second.outputs.some((item) => item.peer === 1 && item.nonSilent > 3));
		assert.equal((await ui()).armed, "true");
		report.continuedListening = true;
		await js("window.__handsSmoke.drive([[500,2000]])");
		await wait("third delayed offer", () => releaseOffer);
		if (process.env.HANDS_FREE_STOP === "escape") {
			win.setFocusable(true);
			win.focus();
			win.webContents.focus();
			win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
			win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
		} else
			await js(
				`document.querySelector('[data-testid="voice-control"][aria-label="End conversation"]').click()`
			);
		await wait(
			"End releases hardware",
			async () =>
				(await ui()).armed === "false" &&
				(await media()).microphones.every((item) => item.state === "ended")
		);
		win.setFocusable(false);
		releaseOffer();
		await sleep(1100);
		report.finalMedia = await media();
		assert.equal(report.finalMedia.microphones.length, 1);
		assert.ok(report.finalMedia.microphones[0].stops >= 1);
		assert.ok(report.finalMedia.contexts.every((state) => state === "closed"));
		assert.ok(report.finalMedia.peers.every((peer) => peer.state === "closed"));
		assert.equal(report.offers.length, 3);
		assert.equal(report.releases.length, 2);
		assert.equal(report.model.length, 2);
		assert.equal((await ui()).armed, "false");
		assert.ok(!(await ui()).messages.some((item) => item.answer.includes(lateText)));
		assert.deepEqual(report.blocked, []);
		report.stopMode = process.env.HANDS_FREE_STOP === "escape" ? "escape" : "End button";
		report.noLateRearm = true;
		report.actualChromiumMedia = true;
		report.status = "passed";
		await quit();
	} catch (error) {
		await quit(error);
	}
}
function selfCheck() {
	const tone = (hz) =>
		Float32Array.from({ length: 4800 }, (_, i) => Math.sin((i * 2 * Math.PI * hz) / 48000) * 0.14);
	for (const hz of [300, 500, 700, 900]) {
		const stats = measure(tone(hz), 48000);
		assert.ok(stats.rms > 0.09 && Math.abs(stats.hz - hz) < 12);
	}
	assert.deepEqual(measure(new Float32Array(960), 48000), { rms: 0, hz: 0 });
	assert.equal(
		key({ sessionId: "s", turnId: "t", generation: 1, sdp: "never log" }),
		'{"sessionId":"s","turnId":"t","generation":1}'
	);
	new Function(`return (${installMedia.toString()})`);
	const context = {
		actualWorkspace: {
			workspace: { review: { prId: null }, canvases: [{ kind: "center" }], centerSection: "home" },
			reviews: [],
		},
		actualHub: { jobs: [], counts: { pendingDecisions: 0 } },
	};
	const request = () => ({
		tool_choice: "auto",
		tools: ["inspect_workspace", "expand_tools", "open_command_center"].map((name) => ({ name })),
		input: [{ content: [{ text: JSON.stringify(context) }] }],
	});
	assertWorkspaceRequest(request());
	context.actualHub.jobs = undefined;
	context.actualHub.counts = undefined;
	assertWorkspaceRequest(request());
	context.actualHub.jobs = [{ id: "unexpected-seeded-job" }];
	assert.throws(() => assertWorkspaceRequest(request()));
	context.actualHub.jobs = [];
	context.actualWorkspace.workspace.canvases[0].kind = "review";
	assert.throws(() => assertWorkspaceRequest(request()));
	context.actualWorkspace.workspace.canvases[0].kind = "center";
	assert.throws(() => assertWorkspaceRequest({ ...request(), tool_choice: "none" }));
	console.log(
		"HANDS_FREE_SELF_CHECK_PASS: controlled PCM, identity sanitization, Home/hub request guards, renderer fixture syntax; no media/app/network launched"
	);
}
exports.installControlledMedia = installMedia;
exports.measureControlledPcm = measure;
if (
	require.main === module ||
	(process.versions.electron && process.argv[1] && resolve(process.argv[1]) === resolve(__filename))
) {
	if (process.argv.includes("--self-check")) selfCheck();
	else
		native().catch((error) => {
			console.error(error.message);
			process.exitCode = 1;
		});
}
