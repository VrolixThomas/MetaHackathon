# Voice latency investigation — 2026-10-30

Investigated exact `c2379196c2a46df3f144e3fa1591bc187a076c67` on new branch
`hack/voice-latency-investigation`, using the existing executive-coding worktree.
The initial tracked/untracked status was clean; the former branch/history was preserved.
Reservation: MET-8 comment `455818e6-a53d-4172-a90f-5d95986f58c0`.
This document is the only authored repository file. Root/voice owns implementation.
No child agents, installs, source/manifests changes, Electron/combined-app launches,
microphone capture, provider requests, or new live speech verification occurred.

## Findings to act on

1. **Input connection delay survives until after speech ends.** The microphone session
   persists, but every utterance creates a fresh RTC/provider session. Its FIFO starts
   playing only after connection completes, then plays at real time. It cannot catch
   up with continuing real-time capture. The existing app timings imply a median
   **2,195 ms between local endpoint and renderer release**, before final STT processing.
2. **Workspace replies wait for the complete model round.** Even an eventual no-tool
   answer goes through `modelRound` without its streaming callback. Existing
   agent-start → first-answer timings range **1,197–14,876 ms**; context reads, tools,
   retries, provider reasoning/generation and buffering are not separately timed.
3. **Endpointing adds 700 ms before the logged endpoint.** Lowering it to 500 ms
   would save 200 ms in uninterrupted quiet, subject to pause/truncation validation.
4. **TTS is a smaller observed stage.** First published answer → first renderer PCM
   has median **373 ms**, range **320–1,705 ms**. This includes segmentation and
   transport, so it is not an isolated ElevenLabs startup measurement.

Do not fix either main bottleneck by dropping buffered first phonemes, sending PCM
faster than the provider permits, publishing tool preamble, or bypassing source receipts.

## Existing app evidence and its limits

Source establishes the exact permitted log: `main/index.ts:106` passes
`app.getPath("userData")` to `ConversationDiagnostics`; `main/composition/diagnostics.ts:52`
appends `diagnostics/conversation.jsonl`. Desktop `package.json:3` and
`electron-builder.yml:2` name the app MetaHackathon. Only the following exact paths
were inspected, through bounded JSON parsing and a whitelist of numeric stage fields:

```text
/Users/Werk/Library/Application Support/MetaHackathon/diagnostics/conversation.jsonl
/Users/Werk/Library/Application Support/MetaHackathon/diagnostics/conversation.jsonl.previous
```

Current log: 19,541 bytes, 134 rows, 29 hashed turns, UTC range
2026-10-28T22:06:28.975Z–2026-10-30T12:29:20.401Z. Previous log absent.
No keys, transcript/model/source text, raw identities, or unrelated user files were
read or printed. The writer validates strict metadata, hashes turn identities, limits
events to 80/s, and rotates at 256 KB (`main/composition/diagnostics.ts:55–83`;
`shared/contracts/conversation-diagnostics.ts:5–24`).

| Existing logged interval | n | Minimum ms | Median ms | Maximum ms |
| --- | ---: | ---: | ---: | ---: |
| Local endpoint → final transcript | 16 | 2,154 | 2,569.5 | 3,346 |
| Agent start → first published answer | 7 | 1,197 | 2,103 | 14,876 |
| First published answer → first renderer PCM | 6 | 320 | 373 | 1,705 |
| Local endpoint → first renderer PCM | 6 | 4,086 | 5,109.5 | 9,892 |
| Renderer release → first renderer PCM | 6 | 1,986.5 | 2,872.8 | 7,831.1 |
| **Derived local endpoint → renderer release** | 6 | **1,850** | **2,195** | **2,932** |
| **Derived renderer release → final transcript** | 6 | **402** | **441** | **548** |

Derived release time, relative to turn start, is
`first-audio.elapsedMs - first-audio.releaseToAudioMs`. Subtract `speech-ended.elapsedMs`
for endpoint → release; subtract release time from `transcript-final.elapsedMs` for
release → transcript. Derived values are rounded to whole milliseconds because
`elapsedMs` is rounded by the logger. Medians from different sample sets must not be added.

The six matched audio samples are shown without identity/content:

| Sample (log-order index) | Endpoint → release ms | Release → transcript ms | Agent → answer ms | Answer → PCM ms | Endpoint → PCM ms | Later outcome |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 2,932 | 414 | 3,569 | 1,705 | 8,621 | cancelled |
| 11 | 2,061 | 434 | 7,038 | 359 | 9,892 | completed |
| 20 | 2,291 | 548 | 1,377 | 946 | 5,163 | cancelled |
| 22 | 2,100 | 402 | 1,197 | 387 | 4,086 | cancelled |
| 23 | 2,380 | 461 | 1,895 | 320 | 5,056 | cancelled |
| 25 | 1,850 | 448 | 2,103 | 323 | 4,724 | completed |

These are existing local app measurements, not a representative production benchmark.
The log does not carry a build SHA, provider request timings, audio content, physical
speech-end timestamp, hardware output latency, or route/tool classification. Its older
rows cannot be attributed conclusively to the investigated revision. Four of six audio
turns were later cancelled; cancelled/no-audio turns are censored, not zero-latency
successes. Outcome stage counts are not exclusive because failure diagnostics can repeat.

## Trace and known waits

Paths in this section are relative to `apps/desktop/src/` unless beginning with `services/`.
Line references describe the exact investigated revision, not future implementations.

### Renderer input, endpoint and backlog

- `renderer/voice/hands-free-worklet.js:9` emits 20 ms capture frames. The detector
  is energy/ZCR plus adaptive noise/echo gating, not semantic VAD (`activity.ts:22`).
  Defaults: 120 ms speech onset, 240 ms onset during playback, 700 ms end silence,
  30 s utterance bound (`activity.ts:45–49`). Active voiced frames reset quiet time;
  endpoint requires accumulated quiet and at least 160 ms voiced input
  (`activity.ts:164–176`). Frame scheduling adds granularity; noise can delay endpoint.
- `renderer/voice/hands-free.ts:177–188` interrupts the old turn synchronously,
  allocates a fresh turn and appends all retained preroll. Preroll can contain 700 ms
  (`hands-free.ts:230–234`), including silence before onset. Echo-correlated history
  is scrubbed locally (`hands-free.ts:215–227`). Keep the candidate phonemes and the
  playback-reference protection when considering any trimming.
- Each virtual track calls `createBrowserMediaFactory`, using the shared physical
  context/microphone but a fresh RTC peer (`hands-free-audio.ts:188–215`;
  `browser-media.ts:192–193`). `hands-free-audio.ts:219–221` sends worklet `play`
  only after `media.connect` completes. All earlier PCM remains queued.
- The worklet consumes one queued sample per output sample
  (`hands-free-worklet.js:108–119`). With preroll P and setup C, a steady input/output
  clock retains approximately **P+C** backlog even through a long utterance.
  This is a code/probe inference, consistent with the existing ~2.2 s derived stage;
  the old logs cannot isolate actual C or prove its network cause.
- On endpoint, `hands-free.ts:192–202` first seals and awaits `finishInput()`.
  That resolves only on worklet `drained` (`hands-free-audio.ts:144–145,232–238`).
  Only then does `controller.ts:709–729` set `releasedAt`, stop the virtual track,
  and issue `voice.release`. Thus `releaseToAudioMs` omits **both 700 ms endpoint
  silence and input FIFO drain**. The 17 s `finishInput` bound is a failure deadline,
  not an intentional sleep on successful turns.

### Speech transport and STT

- Renderer setup gathers ICE, sends the local offer, applies the answer and waits for
  connected (`browser-media.ts:253–265`); no STUN/TURN is configured. ICE and connection
  limits of 5 s and 10 s (`:156,173`) are deadlines, not measured normal waits.
- Main validates identity, rejects stale generations and forwards each request over
  private loopback HTTP (`main/voice/service.ts:63–122`; `sidecar.ts:145–165`). The
  ordinary requests do not pass through the composition configuration serialization
  queue (`main/composition/voice.ts:296–339`).
- Explicit preparation already warms the local executable, not provider connections
  (`main/composition/voice.ts:198–245`; `main/voice/sidecar.ts:56–64`). Recommending
  only Python process warmup misses this per-utterance path.
- `services/voice/voice_sidecar/session.py:153–204` constructs the pipeline and a fresh
  HTTP session, **awaits Meta STT open before peer initialization**, then starts/waits
  for the pipeline. `providers.py:47–79` does fresh WebSocket connection and config
  acknowledgement, with 5 s deadlines. These stages contribute to C; their actual
  durations are unmeasured in the current log.
- Meta is configured `PUSH_TO_TALK`, `CUMULATIVE` (`providers.py:57–62`). Its sender
  paces accepted PCM at real time without catch-up credit (`:97–111`); its queue is
  bounded to nominally 4 s (`:39`). The finish sentinel drains accepted PCM before
  `endStream` and waits for the receiver (`:144–154`). Never replace this with a
  burst or finalize before all accepted samples have arrived.
- Sidecar release explicitly allows **200 ms RTP tail** (`session.py:29,223–234`).
  Renderer voice polling normally sleeps **50 ms** per page
  (`renderer/voice/controller.ts:94,573–586`). Provider finalization, residual pacing,
  IPC/HTTP and poll lag share the observed 402–548 ms release → final stage in the
  six audio samples; that entire interval is not a pure provider measurement.
- Final transcript plus release gates model start (`controller.ts:540–551,564–569`).
  Partial transcripts do not start irreversible model/tool work. Preserve that fence.

### Conversation, model and tools

- The integrated service supplies workspace/hub ports (`main/services.ts:76–94`).
  Consequently the direct tools-free streaming fallback in `main/agent/conversation.ts:440–464`
  is not the normal integrated workspace path.
- Before routing, `conversation.ts:378` observes the workspace; the workspace loop
  observes it again and then the hub (`workspace-conversation.ts:48–51`). Each
  workspace observation reads actual browser/review state (`main/composition/workspace.ts:823–835`)
  and hub snapshot (`:869–872`); `hub-tools.ts:316–321` fetches another hub snapshot
  even after accepting the one already provided. These are redundant candidates,
  with **no measured duration**. Reuse may only occur within a valid observed sequence;
  source/mutation/receipt checks must still refresh when required.
- The model request uses quick routing, a 2,048-token cap, up to ten sequential
  rounds, and at most one call per response (`workspace-conversation.ts:46,87–97,120–141`).
  Quick maps to `muse-spark-1.3` (`models.ts:9–10`); the client already asks for
  minimal reasoning (`meta-client.ts:137`). The 120 s client limit (`:97`) is a
  timeout, not a sleep. Changing a nonexistent high-reasoning default is not a fix.
- Although the client yields real SSE text deltas (`meta-client.ts:180–182`),
  `workspace-conversation.ts:97` calls `modelRound` without `onText`. The helper
  accumulates until a completed response (`guided-review.ts:868–908`). Only a final
  no-call response reaches `onText` (`workspace-conversation.ts:113–118`); tool-round
  prose is discarded (`:128`). Output-limit recovery retries once at 4,096 tokens
  (`:98–110`), potentially adding another full attempt without logging this split.
- Guided review already has a narrower safe streaming phase: after acknowledged
  navigation it disables tools, revalidates the shown screen for emitted text and
  streams (`guided-review.ts:310–336`). Otherwise it buffers (`:367–374`). A normal
  question about an already shown file can therefore still buffer its whole initial
  tool-capable round. Do not remove the guard globally.
- Agent polling adds a normal **0–50 ms scheduling phase**, plus request/scheduling
  time, to an available answer (`renderer/voice/controller.ts:482–534`). It cannot
  explain the observed multi-second model interval by itself.

### TTS, playback and measurement

- `renderer/voice/controller.ts:347–353` passes admitted text into `Sentences`.
  `sentences.ts:14–20` waits for punctuation plus following whitespace/newline,
  a 1,000-character bound, or final flush. There is **no time-based first-clause
  flush**. A token ending in a period alone remains pending until more text/finality.
- The speech pump issues `voice.speak`, waits for matching `speech-ended`, then
  actual media drain before the next segment (`controller.ts:294–328`). This preserves
  checkpoints but serializes synthesis and includes an inter-segment gap.
- Sidecar synthesizes one request at a time, waits for connection, and fences output
  chunks (`services/voice/voice_sidecar/session.py:257–277`). ElevenLabs uses the
  streaming HTTP endpoint, `eleven_flash_v2_5`, mono 24 kHz PCM, and accumulates
  **1,920 bytes = 40 ms audio** before yielding (`providers.py:14–15,33,169–197`).
  Forty milliseconds of audio is a chunk size, not a guaranteed 40 ms wall wait.
  The connected 15 s / synthesis 125 s / fence 5 s bounds are failure limits.
- Output transport uses four 10 ms chunks and zero extra end silence
  (`session.py:158–162`). Renderer then pulls RTC audio through the Web Audio graph;
  its analyser samples every **10 ms**, fftSize 512, RMS threshold .001
  (`browser-media.ts:118–139`). These observations precede any physical speaker/output
  latency; they do not prove what a person actually heard.
- Renderer drain waits **at least 300 ms** after a segment-end event and **180 ms**
  since last detected PCM, checked every 20 ms (`browser-media.ts:273–279`). It affects
  later segments and narration checkpoints, not initial first-audio startup.
- `controller.ts:267–287` records first positive PCM only while a current speech item
  exists, per kind and generation, relative to renderer release. `speech-started`
  events are deliberately not the latency sample. `renderer/conversation/voice.ts:100–108`
  starts diagnostic elapsed time at detected onset, `:201–203` logs endpoint at
  responding, `:126–138` logs admitted final transcript/answer/PCM. These endpoints
  explain why the headline release metric understates finish-speaking → reply delay.

## Prioritized implementation handoff

All items below are proposals, not implemented fixes or measured improvements. Root
and voice were sent the timings and exact source references during investigation.
Coordinate shared-contract and agent changes on MET-8 before editing.

| Priority | Change | Expected effect and safety condition |
| --- | --- | --- |
| 0 | Add numeric endpoint → release, input queued-ms, offer/STT-open/RTC-ready, model first-delta/terminal, tool/receipt duration, TTS enqueue/first-PCM timings; include build identity. | Small additive diagnostic work; separates the observed 2.2 s input backlog from STT and model delays. Extend strict schemas; retain hashed identity, numeric/fixed-category fields, bounds and private rotation. No text, SDP, URLs or credentials. |
| 1 | Reduce per-utterance setup/backlog without changing accepted PCM order: first test overlapping independent STT-open and peer preparation, with failure/cancel cleanup. | Smallest transport experiment; savings depend on overlap and are unmeasured. Never begin consuming input before STT readiness or play a virtual track before RTC can accept it. A persistent/prepared transport across utterances could remove more setup, but requires explicit generation ownership and is a larger change. |
| 1 | Add an explicit safe reply-only streaming phase for workspace and already-displayed review follow-ups. | Avoid waiting for the remainder of an answer after safe first speech exists. Route while tools may still run using buffered output; only emit early text in a tools-disabled phase after effects/receipts settle. Keep unsolicited-call guards, generation/screen checks and no retry after spoken prefix. Extra routing/provider round trips can erase gains, so measure before rollout. No raw-prompt keyword shortcut. |
| 2 | Reuse the initial workspace observation and embedded hub snapshot within one unchanged round. | Low-risk removal of duplicate reads; savings unmeasured. Invalidate on intervening action/navigation/generation change and retain fresh mutation validation plus durable display receipts. |
| 2 | Try 500 ms quiet endpoint, retaining onset/echo/barge-in thresholds. | Exactly 200 ms less quiet wait in the synthetic detector. Validate natural hesitations, quiet speech, final consonants, background noise and interrupted replies before claiming a live improvement. 400 ms is the schema minimum, not an established safe default. |
| 3 | Consider trimming only provably pre-speech silence from preroll, or bounded first-clause speech chunks in safe reply-only phases. | A fully populated 700 ms preroll is retained backlog even with instant setup. Do not blindly shorten it: onset candidates may span up to 600 ms (`activity.ts:149–157`) and near-end first-word/echo tests protect it. Clause flushing must preserve decimals, quotes and exact admitted text. |
| 4 | Optimize TTS connection reuse/inter-segment pipelining or 300 ms drain only after stage evidence supports it. | Smaller observed first-audio stage. New HTTP session per utterance exists (`session.py:192`); queueing synthesis ahead must remain bounded/cancellable and cannot advance narration until actual PCM drain. The current 300 ms floor is not an initial-answer bottleneck. |

Keep immediate output disconnect, dual voice/agent cancellation and late allocation
compensation (`renderer/voice/controller.ts:172–196,253–264`), playback echo rejection,
FIFO sample order, current generation identities, exact source receipts and checkpoint
playout gating. Do not add filler acknowledgements or relabel fixtures as live speech.

## Bounded validation performed

- **13 existing pure tests passed**, zero failures, across `activity.test.ts`,
  `hands-free-worklet.test.ts`, `sentences.test.ts`, with automatic `.env` loading disabled:

  ```sh
  bun --no-env-file test --timeout 10000 \
    apps/desktop/src/renderer/voice/activity.test.ts \
    apps/desktop/src/renderer/voice/hands-free-worklet.test.ts \
    apps/desktop/src/renderer/voice/sentences.test.ts
  ```

- A stdin-only synthetic detector probe used actual `VoiceActivityDetector`, 48 kHz,
  20 ms tone/quiet frames: default onset 120 ms; quiet endpoints exactly 700, 500,
  400 ms for the respective option. This tests deterministic detector clocks, not
  conversational pause quality or microphone accuracy.
- A stdin-only VM probe loaded the actual worklet with a simulated 48 kHz/20 ms output
  clock. After 3 s of live-paced appends, all eight combinations P={120,700} ms and
  C={0,500,1500,2000} ms drained after exactly P+C additional ms. Example: 700+1500
  =2,200 ms. No audio hardware, RTC or provider was involved; simulated block cadence
  is not browser scheduling evidence. Existing epoch/overflow/stall tests also passed.
- A stdin-only injected-model probe used actual `runWorkspaceConversation` and
  `modelRound`, holding terminal completion behind a promise. Workspace with no tools
  published zero callbacks before terminal and one after. Explicit tools-free
  `modelRound` with a callback emitted before terminal. The probe resolved only its
  existing installed `zod` dependency read-only from integration; no install or file
  modification. It demonstrates buffering, not a safe routing implementation.
- A wider nine-file unit selection could not load six files because this checkout
  lacks resolvable `zod`; it reported 13 pass / 6 load failures. `NODE_PATH` did not
  resolve that. A stdin-preload workaround failed loading its transient input and
  was terminated while the controller suite was pending (exit 143). **No wider suite
  pass is claimed.** No dependency installation, source changes or harness changes
  were made to force a passing result.
- Existing relevant assertions inspected but not newly passed here include
  `main/agent/guided-review.test.ts:1124` (receipt-gated early text and withheld tool
  preamble), `workspace-conversation.test.ts:767` (discard incomplete retry text),
  `renderer/voice/controller.test.ts:302` (every speech end and drain before narration),
  `:1395` (PCM timing rather than speech-start event), and
  `services/voice/tests/test_voice.py:408` (200 ms queued PCM stays paced, adjacent
  arrivals >=35 ms, total first-to-last >=150 ms). Python network/peer tests were
  not run under the no-provider/RTC-launch restriction.

Implementation acceptance should retain those assertions and add held-terminal
ordinary-follow-up coverage, no spoken tool preamble or incomplete retry duplication,
barge-in while setup/model/TTS/drain is pending, preserved first phonemes, and stale
receipt/generation rejection. Root alone owns combined-app validation. A later real
conversation comparison must measure local endpoint → first renderer PCM as well as
release → PCM, use the same device/build and classify cold/warm turns. Current results
establish source mechanisms and existing local timing evidence; they establish no
new live speech latency improvement.
