# Voice renderer handoff (MET-30 / MET-31 / MET-32 / MET-33)

`index.ts` exports `createVoiceController`, `createBrowserMediaFactory`, and their typed ports.
This directory owns media and turn coordination. The agent owns tools, intent, and answers;
integration owns router registration, transport adapters, UI composition, and lifecycle wiring.
There are no credentials, global key handlers, visible controls, or phrase-based tool routes here.

## Hands-free sessions — MET-30 / MET-33

`createHandsFreeVoiceController(options)` is the continuous conversation entry point. Pass the
existing voice/agent ports, shared session/generation allocator, context getter and UI hooks;
omit `media` and acknowledgement copy. The session never adds spoken filler. The browser audio
factory is the default; `audio?: HandsFreeAudioFactory` is the deterministic test seam.

```ts
const conversation = createHandsFreeVoiceController({
  voice: voicePorts,
  agent: conversationPorts,
  sessionId,
  allocateIdentity,
  getConversationContext,
  onTurnStart,
  onTurnEnd,
  onTranscript,
  onAnswer,
  onConversationAction,
  onError,
});
await conversation.startListening(); // call from the user's Start gesture
conversation.interrupt();            // stop this reply/turn, keep the explicitly opened mic armed
conversation.stopListening();        // End/Escape: stop the turn AND release hardware immediately
conversation.dispose();             // terminal; a disposed instance cannot start again
```

`subscribe` notifies for both session and turn changes. `getSessionSnapshot()` returns an
immutable `{phase, active, error?}`; phases are `stopped`, `starting`, `listening`, `capturing`,
`responding`, `error`. Use it for microphone/session labels. `getSnapshot`, `getPhase` and
`getIdentity` retain the existing **utterance** semantics; after an explicit restart they can
still describe the prior cancelled/error turn until new speech begins. `onTurnEnd` completes
one utterance, not the microphone session. Stop, error and disposal never auto-rearm. A late
permission result is stopped, and old turn cancellation failures cannot close a new hardware
session before its first utterance. An explicit new Start may create a new hardware session.

One `getUserMedia` capture with echo cancellation/noise suppression and one resumed AudioContext
belong to each explicit session. No new hardware capture or permission prompt occurs per turn.
A local AudioWorklet produces 20ms PCM frames for signal detection; it also paces a bounded FIFO
into a virtual MediaStream track. Each existing WebRTC generation receives a clone of that virtual
track. The sender remains silent until its peer is connected, then sends all retained onset PCM in
order at the render clock. Endpointing seals the FIFO; only its drained acknowledgement triggers
the existing `endCapture`/release RPC. This retains short utterances that end during setup rather
than cancelling them. Old senders stop before release, and future microphone frames cannot enter
their sealed FIFO. Barge-in synchronously disconnects old playback, closes its peer and sends both
voice/agent cancellation RPCs before creating the new turn with the shared allocator.

Signal detection is local energy/zero-crossing gating with an adaptive noise floor, not a semantic
speech model. Playback gets a longer onset guard plus a delayed correlation check against the
actual remote output reference. Highly correlated echo-only input is zeroed in preroll; assistant
reference PCM is never enqueued as microphone audio. Tests demonstrate these mechanics with
generated waveforms, not acoustic immunity in arbitrary rooms. Integration must assess speakers,
headsets, quiet voices, room echo and device processing in the actual app. No raw microphone PCM,
reference PCM or transcript is written to storage/logs by this layer; idle PCM remains local.

| Limit | Default / behavior |
| --- | --- |
| Onset | 120ms sustained input; 240ms during playback/tail (configurable `activity`) |
| Silence endpoint | 700ms; configurable 400–1500ms |
| Preroll | Most recent 700ms, with onset-through-setup retained for the new turn |
| Continuous utterance | 30s; configurable 1–45s, then error stops the session |
| Short noise | Below 160ms accepted voice discarded; 3 false starts within 30s stop the session |
| Media setup | 12s default for hands-free; existing RPC deadline remains 15s |
| Outgoing FIFO | 15s of PCM, hard overflow error instead of dropping/clipping input |
| Drain | 17s bound, then error stops session |
| Renderer frame stall | 2s; worklet independently caps unacknowledged capture at 100 frames |
| Idle / total session | No automatic cutoff by default; optional explicit `idleTimeoutMs` / `sessionTimeoutMs` |

`hands-free-worklet.js` is emitted as a separate self-origin asset (`?no-inline`), compatible with
the existing CSP without blob/eval policy changes. Keep it alongside the built renderer assets.
No provider/main RPC changes or new package dependency are required. The sidecar still uses the
bounded single-utterance Meta stream; only accepted utterances go upstream. Existing provider,
identity, event, action-receipt, cancellation and speech serialisation guards remain in force.

Deterministic checks cover actual processor FIFO prefix/order/drain, epoch tombstones, overflow,
capture credits, local signal classification, one hardware acquisition across replies, delayed
setup, short utterances, barge-in, pending permission, device failure, retired-session errors and
explicit stop/disposal. The asset check builds with Vite but launches no app or microphone.

## V1 conversation

Pass `getConversationContext: () => ({ prId: selectedPR?.id })` for the simple talk/reply flow.
Omit `getScreenContext`; no PR, fixture, screen update, browser or artifact surface is needed.
`AgentPorts.start` accepts `ConversationTurnInput | AgentTurnInput`; the V1 adapter parses with
`ConversationTurnInputSchema` and calls `conversation.start`, with polling and cancellation sent
to that same conversation namespace. The existing identity allocator, lifecycle/transcript/answer
hooks, serial speech and explicit dual cancellation are retained. The conversation getter takes
precedence when both context getters are supplied. V1 does not dispatch review action/receipt hooks.

Without the conversation getter, the legacy path still requires `getScreenContext` and sends an
`AgentTurnInput`. Legacy adapters should parse that schema before reading `input.screenContext`.

## Legacy review composition example

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
  sessionId: reviewSessionId,
  allocateIdentity: allocateReviewTurn, // UI's shared allocator for typed AND spoken turns
  onTurnStart: (identity) => {
    if (!externalVoiceTurn.begin(identity)) throw new Error("Review is not ready for voice");
  },
  onTurnEnd: (identity, result) => externalVoiceTurn.finish(
    identity,
    result.status === "completed" ? "complete" : result.status === "failed" ? "error" : "cancelled",
    result.status === "failed" ? result.error : undefined,
  ),
  getScreenContext: () => reviewStore.getState().screenContext,
  getKeywords: () => reviewStore.getState().prSymbolsAndPaths,
  acknowledgementText: "I’m checking that.", // product copy, not inferred intent
  completionText: "The background work has finished.", // optional generic copy
  onTranscript: (update) => externalVoiceTurn.transcript(update, update.text),
  onAnswer: (text, identity) => externalVoiceTurn.replaceText(identity, text),
  onEvent: (event) => eventStore.observe(event),
  onVoiceEvent: (event) => voiceEventStore.observe(event),
  onAction: async (action, screen, signal) => {
    // Controller already checked turn identity, PR and exact screen sequence.
    // Recheck after any await, immediately before committing a UI effect.
    if (signal.aborted || reviewStore.getState().screenContext.sequence !== screen.sequence) return;
    await externalVoiceTurn.action(action);
  },
  onActionIgnored: async (action, screen) => {
    // UI sends agent.actionApplied with the action's exact identity/requestId,
    // status: "ignored", and screenContext: screen using AgentActionReceiptSchema.
    await sendIgnoredActionReceipt(action, screen);
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

`reviewSessionId`, `allocateReviewTurn`, and `externalVoiceTurn` above are UI-owned seams.
Supply both `sessionId` and `allocateIdentity` in the integrated app: the controller validates
the returned identity, rejects a different session or non-increasing generation, and uses that
exact identity for voice, agent, UI effects and cancellation. Gaps are valid when typed questions
consume intervening generations. Standalone tests may omit both to use a private session.
`onTurnStart` runs synchronously before microphone setup. `onTurnEnd` runs once after local media
is closed and cancellation requests are sent, including early release, errors and navigation.
Successful completion waits until queued speech drains. Hook errors cannot prevent teardown.
Stop the current voice controller before starting a typed question, changing PR, or replacing it;
the same UI allocator must survive controller recreation. UI owns subscription and action guards.

The `agent.start` adapter must await `screen.update({sessionId, screenContext})` before invoking
`agent.start`, and UI publishes subsequent screen changes for that same session. The controller
passes the current shared `ScreenContext.browser` through unchanged and rejects a browser snapshot
from another review/session. `onEvent` must not execute actions or append answer deltas again:
`onAnswer` supplies replacement text and `onAction` is the single effect path.

`onActionIgnored(action, screen)` is optional and called once when an action from the same
active turn fails the current PR or screen-sequence guard. It receives the current validated
screen, never executes the effect, and shares action request-ID deduplication with `onAction`.
Foreign session/turn/generation identities, duplicate actions and cancelled turns do not invoke
either hook. The callback is awaited with the existing RPC deadline and turn cancellation;
rejection or timeout fails/cancels the turn. UI owns the actual `agent.actionApplied` receipt for
both applied and ignored actions. Preserve the action's identity/requestId; never allocate a new
generation to acknowledge it. If UI defers sending a receipt, recheck its active identity before
sending. Agent cancellation resolves its waiters, so no receipt is needed after cancellation.

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

Integration supplies `voice.status`, `voice.configure({voiceId})`, and `voice.prepare` backed by
the shared `VoiceSetupStatusSchema`. UI setup controls use the existing encrypted credential
set/status RPCs for `meta` and `elevenlabs`, then configure the public ElevenLabs voice ID and
await preparation. Capture is available only when setup `phase === "ready"`. `preparing` may
take up to the 180-second native startup deadline; setup errors and missing fields are displayed
without keys. A ready sidecar has started locally; it does not prove live provider entitlement.
Settings changes must interrupt the current turn before root disposes/recreates the service pair.
There is no duplicate voice-local credential store, router or setup controller.

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

A final transcript starts agent work immediately. An explicitly injected acknowledgement is
optional; V1 omits it and speaks only answers. Server acknowledgement events are never spoken. Text deltas
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
128 queued speech chunks of at most 1,000 characters (ack copy may be up to 4,000); 15 s per RPC,
90 s whole media setup (including a separate 60 s microphone permission budget),
45 s speech-ended, 10 s continuous-audio drain, and 180 s whole-turn limits. ICE gathering has a
5 s limit and peer connection a 10 s limit. Overflow/timeouts fail and cancel explicitly. Timers,
listeners and media are cleaned on interruption/disposal. `pollIntervalMs`, `rpcTimeoutMs`,
`speechTimeoutMs`, `mediaSetupTimeoutMs` and `turnTimeoutMs` are configurable for composition/testing.
The browser factory also accepts `permissionTimeoutMs`. Permission denial, missing microphone and
unavailable/in-use input return canonical messages with a `VoiceDiagnosticError` from the app's own
capture attempt. A separate launcher's microphone permission is not evidence about this app.
The first turn failure remains the reported failure even when media close or cancellation also fails.

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
