# Voice renderer handoff (MET-30 / MET-31 / MET-32 / MET-33)

`index.ts` exports `createVoiceController`, `createBrowserMediaFactory`, and their typed ports.
This directory owns media and turn coordination. The agent owns tools, intent, and answers;
integration owns router registration, transport adapters, UI composition, and lifecycle wiring.
There are no credentials, global key handlers, visible controls, or phrase-based tool routes here.

## Composition example

```ts
import {
  createBrowserMediaFactory,
  createVoiceController,
  type AgentPorts,
  type VoicePorts,
} from "./voice";

// Integration supplies these adapters over the existing preload request transport.
// Pass AbortSignal to that transport AND keep the explicit cancellation RPCs below.
declare const voicePorts: VoicePorts;
declare const agentPorts: AgentPorts;

const voice = createVoiceController({
  voice: voicePorts,
  agent: agentPorts,
  media: createBrowserMediaFactory(),
  getScreenContext: () => reviewStore.getState().screenContext,
  getKeywords: () => reviewStore.getState().prSymbolsAndPaths,
  acknowledgementText: "I’m checking that.", // product copy, not inferred intent
  completionText: "The background work has finished.", // optional generic copy
  onTranscript: (update) => transcriptStore.set(update),
  onAnswer: (text, identity) => answerStore.replace(identity, text),
  onEvent: (event) => eventStore.observe(event),
  onVoiceEvent: (event) => voiceEventStore.observe(event),
  onAction: async (action, screen, signal) => {
    // Controller already checked turn identity, PR and exact screen sequence.
    // Recheck after any await, immediately before committing a UI effect.
    if (signal.aborted || reviewStore.getState().screenContext.sequence !== screen.sequence) return;
    await applyAgentAction(action, signal);
  },
  onLatency: (sample) => latencyStore.record(sample),
  onError: (error) => voiceErrorStore.set(error.message),
});

// Structurally matches UI review/services.ts VoiceAdapter. UI owns input binding.
configureReviewServices({ voice });
const unsubscribe = voice.subscribe(() => renderVoiceState(voice.getSnapshot()));
// On navigation: voice.interrupt("navigation");
// On unmount/shutdown: unsubscribe(); voice.dispose();
```

Port payloads:

| Port | Input | Output |
| --- | --- | --- |
| `voice.offer` | `VoiceOffer` including capture-snapshotted keywords | `VoiceAnswer` |
| `voice.release` | strict `TurnIdentity` | `void` |
| `voice.speak` | `SpeakInput`: identity, unique speechId, text | `void` |
| `voice.cancel` | **strict `TurnIdentity` only** | `void` |
| `voice.poll` | `VoicePoll` | `VoicePollResult` |
| `agent.start` | `AgentTurnInput` with fresh requestId and current ScreenContext | identity + AgentTurnStatus |
| `agent.poll` | `PollTurn` | `PollTurnResult` |
| `agent.cancel` | `CancelTurnInput` including fresh requestId and reason | `CancelTurnResult` |

Every port also receives an `AbortSignal`. Inputs and data-bearing outputs are parsed with
the voice protocol or shared schemas. The controller accepts one final utterance per generation;
the sidecar must aggregate STT segments and finalize after release. Transcript callbacks are
for display: do not start a second agent turn from them. `onAnswer` provides the complete answer
for UI replacement, including event-window recovery. `onEvent` is an observation hook, not a
second action executor. Actions are deduplicated by requestId and dispatched only by `onAction`.

`getSnapshot()` / `snapshot` return the same frozen shared `VoiceState` until a change;
`transcript` is a convenience getter. `getIdentity()` returns a copy of the active identity for
integration's `screen.update` wiring, or null after completion/cancellation. `connecting` is
true during permission/signaling. `beginCapture()` intentionally returns **synchronously** so
the UI's serial capture gate can call `endCapture()` while permission is pending.

## Readiness and interruption

The phase remains `idle` while `connecting` is true. It becomes `listening` only after ICE/DTLS
establish the peer. UI should show a connecting cue and tell the user to wait for listening.
This cold connection path does not buffer speech spoken before readiness. A release during
setup cancels that capture; it never resumes after permission or signaling settles.

Each generation allocates a fresh peer, `pipecat` data channel, microphone stream, and audio
output graph. `iceServers: []` keeps signaling local, without STUN/TURN. Release stops microphone
tracks but retains the peer, allowing RTP tail drain and continued transcript/audio polling.
Interruption invalidates the active epoch first, aborts work, disconnects output, stops tracks,
closes the peer, and independently sends **both** cancellation RPCs. If offer/start settles
after cancellation, a compensating cancel follows so a late server allocation cannot survive.
The main services must also reject/tombstone cancelled identities; renderer abort alone cannot
undo server work. Late permission streams are owned and stopped even between promise callbacks.

A final transcript queues the injected acknowledgement immediately and starts agent work without
waiting for speech. Agent acknowledgement events are published but never spoken twice. Text deltas
feed a serial sentence queue. Each sentence waits for its matching `speech-ended` and local drain.
Terminal agent snapshots still page through all events using the **last returned event sequence**,
not the snapshot sequence. Compacted windows recover unsaid snapshot suffixes; conflicting already
spoken text fails the turn rather than replaying it. Background answers naturally arrive while the
agent remains running. `speakCompletion(identity, text)` also accepts a completion from an injected
background observer for the current active turn and returns false for retired identities. Optional
`completionText` is spoken only when a successfully completed turn produced no answer speech.
No completion copy is invented from a tool name or action.

## Latency measurement and bounds

The baseline is renderer `performance.now()` at release, **not acoustic end-of-speech**. Remote
PCM is sampled from a 512-frame Web Audio analyser every 10 ms while the context is running and
the graph is connected to its destination. The first block with RMS >= 0.001 emits a latency
sample for acknowledgement or answer. Both use the release baseline and include sessionId,
turnId, generation, speechId, kind, observedAt, elapsedMs, origin `renderer-release`, and basis
`webaudio-output-analyser`. Enqueuing TTS, `speech-started`, and media `playing` events never
produce latency samples. Silence produces no measurement.

This is the closest observable output-graph PCM, **not physical speaker/acoustic latency**.
Sampling, jitter buffers, output-device buffers and low-volume speech affect precision. RTC audio
does not carry speechId; attribution follows the serial command and a minimum 300 ms post-ended
drain with 180 ms of local silence. Unusually delayed tails can blur attribution. Hardware loopback
and live provider measurements remain integration acceptance work. A muted, detached audio element
activates Chromium's RTC decoder; only the Web Audio graph is audible. See
[Chromium receive-stream issue](https://issues.chromium.org/issues/40094084).

Defaults: 50 ms polling; at most 100 events per page; 32,000 answer characters; 256 action IDs;
128 queued speech chunks of at most 1,000 characters (ack copy may be up to 4,000); 15 s RPC/setup,
45 s speech-ended, 10 s continuous-audio drain, and 180 s whole-turn limits. ICE gathering has a
5 s limit and peer connection a 10 s limit. Overflow/timeouts fail and cancel explicitly. Timers,
listeners and media are cleaned on interruption/disposal. `pollIntervalMs`, `rpcTimeoutMs`,
`speechTimeoutMs` and `turnTimeoutMs` are configurable for composition/testing.

## Validation

```sh
bun test apps/desktop/src/renderer/voice
bun run type-check
bun run lint
bun run test:contracts
bun run build
env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron apps/desktop/src/renderer/voice/browser-smoke.cjs
```

The browser smoke builds an isolated bundle into a temporary directory, launches the installed
Electron Chromium with a temporary profile and fake microphone, negotiates real localhost WebRTC,
and verifies non-silent output PCM, separate acknowledgement/answer observations, fresh peers,
interruption and late-permission cleanup. Its oscillator/agent/STT data are **synthetic**. It does
not measure live Meta/Pipecat latency or prove registered application routing. No provider keys,
network provider calls or GitHub writes are involved. The normal build does not yet compose this
module; integration must wire it to the UI and registered services before ticket acceptance.
