# MET-51: voice latency deep dive

Investigation date: 2026-10-30. Product baseline: **22b462be82f8172bfbb922f229a9893dc0c93a15**.
Branch: `hack/met-51-deep-latency`, initially clean. The session's actual `turn_context`
reported **gpt-6-astra / max**, not merely a requested configuration. Local ignored
`.codex/config.toml` was preserved and never staged. No child agents were used.

Coordination: [MET-51](https://linear.app/metahackathon/issue/MET-51) and
[MET-8](https://linear.app/metahackathon/issue/MET-8), initial reservation
`0186dab3-7871-4653-97e6-ebe95d0aeaee`; approved two-file timing reservation
`821a5037-a666-44b8-b070-210fa565205e`.
Integration/root performed the native/provider experiments below. This author ran
only deterministic probes and unit/static checks, read root-sanitized reports, and
did not launch Electron, record a microphone, call a live provider, or read `.env`.

## Conclusions and ranked work

**Fresh ASR setup plus real-time replay is the largest reproduced avoidable delay.**
In root's current native experiment, ASR open took **3,153 ms**, concurrent peer
initialization **3 ms**, and endpoint to renderer release **4,165 ms**. A second
native run had **4,134 ms** endpoint to release. Both used the actual default app,
worklet, WebRTC, sidecar and live ASR/TTS, a known synthetic spoken phrase, a
controlled model, and muted physical output. The long pause exists before model cost.

**The earlier model interval is not proof that buffering costs several seconds.**
Root's exact-revision empty-home live model experiment completed four ordinary
answers in 1,095–1,542 ms; withholding the first text until completion cost only
36–488 ms. An extra model routing round is not justified as the default fix.

**Selected review has a newly confirmed serial network dependency.** Before the
first model request for an already displayed file, the real review coordinator does
four PR-head reads, even when the source file is local. A deterministic production-
coordinator probe confirms the call order. This was hidden by model experiments
whose review ports return immediately. Measure it on the real route before attributing
the full agent interval to inference.

| Rank | Blocker / change | Quantitative basis | Decision |
| --- | --- | --- | --- |
| 1 | Move fresh ASR/RTC preparation before the next accepted onset | Current native setup C=3,464 ms, retained preroll P=700 ms; C+P predicts the observed 4,165 ms endpoint drain | Design a bounded provisional capture during explicit listening; native/provider acceptance required before enabling |
| 2 | Measure and consolidate repeated selected-review PR revalidation | Four serial reads before first request; injected 250 ms/read implies 1,000 ms of dependency cost, **not a live timing** | Root-owned operation-scoped snapshot/source read with preserved pre/post pin checks; no blanket TTL cache |
| 3 | Separate model/context/tool rounds and history sizes | Recent unversioned agent→answer median 6,772 ms; versioned simple live replies 1.10–1.54 s; controlled-source navigation takes two rounds | Optional numeric model timing hook implemented; context/round counters and persistence remain root work |
| 4 | Reduce endpoint wait only after hesitation tests | Quiet threshold 700 ms; 500 ms saves exactly 200 ms in the detector's sample clock | Leave default unchanged in this handoff |
| 5 | Remove proven leading silence or stream a safe final answer | Entire 700 ms preroll remains even with C=0; simple live buffering median 238 ms | Exact-zero-only trim is safe but may save nothing with physical microphone noise; semantic final-phase experiment stays conditional |
| 6 | TTS startup, segmentation and output gaps | Current native first published answer→PCM 359 ms; recent unversioned median 467 ms; 300 ms drain floor is after a segment | Keep initial latency and inter-sentence/narration gaps separate; no speculative drain reduction |

The 5202fa1 ASR/RTC overlap is already in the baseline. Its critical path is the
slower setup branch. Overlapping a 3 ms RTC branch with a 3.15 s ASR branch cannot
remove the latter. No end-to-end improvement is claimed for this or the timing hook.

## Evidence ledger

| Evidence | Source / revision | What it establishes | What it does not establish |
| --- | --- | --- | --- |
| Earlier device sample | Committed `voice-latency-investigation.md`, historical logs without build identity | Historical endpoint/release/model/PCM intervals | A current-revision benchmark or comparison |
| Recent device summary | Root `/tmp/met51-current-metrics.json`; 8 turns, 4 with audio, after publication; no build SHA | The user's observed long pause persists | Per-provider timing, route, physical acoustics or causal history-size effects |
| Current native speech input, repeated | Root `apps/desktop/out/met51-live-input-report.json`, source 22b462b; root messages `d8UxFkQ505xYoPEpYwRdh`, `KTwPGqwQjDKwppmIkmrm1` | Actual default UI/IPC/worklet/RTC, live Meta ASR and ElevenLabs TTS, decoded nonzero PCM; controlled model | Physical microphone/speaker acoustics or live-model end-to-end latency |
| Sidecar stage trace | Root `/tmp/met51-sidecar-times.jsonl`, successful second native run | ASR open / RTC initialization / accepted audio / send awaits / finish durations | WebSocket connect versus configuration-ack split inside ASR open |
| Empty-home live model | Root `/tmp/met51-model-baseline-report.json`, full 22b462b SHA | Production workspace loop and 33 tool schemas, four generic prompts, actual Meta; all one round and zero tools | Real user source/context/history, native rendering or speech |
| Guided live model | Root message `ld6nM1RFcXBr7ha_7Qc5W`, controlled two-file source | Tool round, simulated applied receipt, then existing tools-free streaming answer | Real GitHub head reads, native receipt latency or microphone |
| Deterministic probes | Actual baseline modules with fake clocks/barriers/ports | FIFO dependency, publication fence, serialized request sizes, four PR reads | Network performance, recognition quality or user-perceived speedup |

The second successful native report read by this author is recorded below because
the root helper overwrites its report path on later runs. Those temporary files are
not durable release artifacts. Root should archive numeric reports with a build ID
for any acceptance claim. A failed instrumentation-wrapper launch was fixed and
rerun by root; it is not counted as a successful experiment.

Recent unversioned device summary, kept distinct from those experiments:

| Interval | n | Min ms | Median ms | Max ms |
| --- | ---: | ---: | ---: | ---: |
| Local endpoint → transcript final | 7 | 2,396 | 2,609 | 3,146 |
| Local endpoint → renderer release | 4 | 1,919 | 2,120 | 2,230 |
| Renderer release → transcript final | 4 | 423 | 514 | 657 |
| Agent start → published answer | 4 | 1,977 | 6,772 | 15,338 |
| Published answer → renderer PCM | 4 | 368 | 467 | 1,917 |
| Local endpoint → renderer PCM | 4 | 6,590 | 9,780 | 18,429 |

There were two failure diagnostics and three cancellation events across eight turns;
outcome counts are not exclusive. Missing audio/cancelled attempts are censored, not
zero-latency successes. Do not add medians from different subsets or compare them
with tiny component samples as a treatment effect.

## Exact-revision timing table

Second root native run: frontend timestamps share the helper's millisecond origin.
The input is a 2,184 ms synthetic spoken-phrase file. Its marker is a file boundary,
**not a physical acoustic timestamp**, despite the helper's historical
`physicalMarkerToEndpointMs` field name.

| Event | Timestamp ms | Interval / interpretation |
| --- | ---: | --- |
| Synthetic input marker starts | 2,492 | Known file begins |
| Local VAD accepts onset; worklet epoch begins | 2,634 | 142 ms after marker start, including capture/detector granularity |
| `voice.offer` begins | 2,878 | 244 ms after onset; local offer/ICE/setup and scheduling |
| Synthetic input marker ends | 4,676 | The file may already contain trailing quiet |
| Local endpoint; FIFO sealed | 5,273 | 597 ms after file marker; default detector still uses 700 ms since its last voiced frame |
| `voice.offer` returns | 6,071 | Offer interval 3,193 ms; current source overlaps ASR/RTC |
| Worklet receives `play` | 6,098 | C=3,464 ms since onset; 27 ms after offer returns |
| Worklet reports input drained | 9,437 | 3,339 ms of replay after play; includes P=700 ms plus 2,639 ms captured since onset |
| Renderer issues release | 9,438 | 4,165 ms after endpoint, 1 ms after worklet drain |
| Release RPC returns | 9,443 | Return acknowledges release scheduling, not final STT |
| Final transcript delivered | 9,881 | 443 ms after release |
| Agent starts | 9,882 | Final+release fence passed |
| First answer published | 9,948 | 66 ms with the controlled model |
| `voice.speak` begins / returns | 9,949 / 9,951 | Enqueue acknowledgement, not audible speech |
| First positive renderer PCM | 10,307 | 359 ms after first answer; 5,631 ms after input file end |
| Turn completed | 11,527 | Includes full output and drain, not a first-audio milestone |

Independent Python monotonic clock: ASR open **3,153 ms**; concurrent RTC initialize
**3 ms**; `MetaStream.finish` **225 ms**, initial queue **0** items; accepted/sent audio
**3,259 ms**, **164** sends, aggregate awaited send time **53 ms**. Do not subtract
absolute timestamps across the Python and frontend clocks. That empty finish queue
and small send time rule out provider sender backlog as a multi-second contributor
in this run. Release's 443 ms still includes the fixed 200 ms RTP allowance and polling.

## Complete dependency path at 22b462b

Paths below are under `apps/desktop/src/` unless prefixed `services/`.

| Stage | Current implementation and bounds | Measurement still needed |
| --- | --- | --- |
| Physical capture → local frames | `renderer/voice/hands-free-audio.ts` opens one microphone/context/worklet on explicit Start; echo cancellation, noise suppression, AGC; 20 ms frames in `hands-free-worklet.js` | Hardware/capture latency; frame delivery lag and worklet-to-main-thread delay |
| Onset / barge-in | `activity.ts`: energy/ZCR, adaptive floor, 80 ms correlation trajectory; normal onset 120 ms, playback onset 240 ms; candidate gaps ≤60 ms and span ≤600 ms | Numeric candidate start/accepted times, echo classifications; real quiet speech and first consonants |
| Preroll | `hands-free.ts` retains up to 700 ms; only high-confidence playback echo is zeroed, including its preceding 80 ms trajectory; all retained frames append on onset | Retained samples and exact-zero leading frames; do not equate subthreshold audio with silence |
| Endpoint | Same detector: 700 ms quiet, at least 160 ms voiced input, 30 s utterance maximum; 20 ms granularity | Last locally voiced sample versus known input marker; hesitation split rate |
| New utterance setup | `controller.ts` allocates identity; `browser-media.ts` creates peer/datachannel, resumes shared context, creates offer, gathers ICE, calls main, installs answer and waits connected | Local offer/ICE, previous-generation retirement, main/sidecar request overhead separately |
| Main / sidecar admission | `main/voice/service.ts`, `sidecar.ts`, `main/composition/voice.ts`: identity fences, loopback HTTP, already-warmed Python executable; ordinary offer/poll/release are not configuration-serialized | Process warm/cold state; pending predecessor teardown; no credential logging |
| ASR + peer preparation | `services/voice/voice_sidecar/session.py`: fresh HTTP session, Meta stream and peer; ASR.open and peer.initialize overlap; pipeline runs only after both finish; manager awaits old cancellation before starting new session | Split TCP/TLS/WS opening and config ack; current 3,153 ms is their aggregate |
| RTP / input conversion | Pipecat 1.14.0 receives RTC frames, resamples to mono 24 kHz s16; `InputGate` checks rate/channels/active capture and passes PCM to Meta | RTP first/last sample, resampling/queue age, missing sample detection |
| Input replay / release | `hands-free-audio.ts` sends play only after connected. Worklet consumes one queued sample per output sample. `finishInput()` waits its drained epoch; only then `controller.endCapture()` stops virtual capture and releases | Queued sample count at play/endpoint/drain; P/C from the same run |
| Provider pacing / finalization | `providers.py`: ≤40 ms chunks, 100-slot queue, no catch-up credit; FIFO sentinel before endStream; wait for final and normal close. `session.py` allows 200 ms RTP tail before finish. Final+release gates agent start | Sent/processed audio ms, send-await sum, queue age, endStream→final and final→socket close; latest native queue is not the bottleneck |
| Context / routing | `conversation.ts` first observes workspace to select executive/workspace versus guided review. Workspace loop observes again and refreshes hub. Guided route reads plan/progress/source with screen checks | Per-port elapsed times, repeated PR-head reads, browser operation queue wait, packet construction time |
| Model | `models.ts`: quick→muse-spark-1.3; `meta-client.ts`: minimal reasoning, real SSE, auto tool selection, no store. Workspace ≤10 rounds, guided ≤6, 2,048 token cap; one validated output-limit retry at 4,096 | Request-specific first event/text/terminal, token usage and round/retry classification; hook below |
| Tool/text fence | `workspace-conversation.ts` buffers tool-capable output to terminal and discards prose on tool rounds. `guided-review.ts` already streams after acknowledged navigation with tools=[] and rechecks the screen per delta | Tool duration and durable receipt wait; first safe published text, independently of provider first text |
| Polling | Renderer agent/voice polling normally 50 ms, bounded pages of 100; zero delay when paging retained events | Poll phase + IPC time, not a presumed multi-second bottleneck |
| Segmentation | `sentences.ts`: punctuation plus whitespace/closing quote or newline; fallback at 1,000 chars; flush at final/checkpoint; no timer flush | First admitted text→first complete speech segment; text at temporary period alone remains pending to protect decimals/quotes |
| TTS first byte / chunk | `controller.ts` queues only admitted text; sidecar uses ElevenLabs streaming HTTP, flash v2.5, PCM24k; 1,920 bytes=40 ms audio buffered before yielding | Request→headers→first bytes→first complete PCM chunk, each separately; chunk duration is not wall delay |
| Output transport / PCM | Sidecar's started/ended fences surround serial PCM; Pipecat output uses four 10 ms chunks and zero added end silence. Chromium decoder and Web Audio analyser observe output every 10 ms, threshold .001 | First sidecar PCM enqueue versus first renderer PCM versus physical speaker onset |
| Drain / cancellation | Media drain: ≥300 ms after ended and ≥180 ms since nonzero PCM, checking every 20 ms. Exact checkpoints wait speech-ended + actual drain. Cancellation invalidates synchronously, mutes/disconnects, aborts and issues separate voice/agent RPCs | Inter-sentence gaps separately; keep generation, stale allocation/receipt compensation and foreground/worker independence |

No fixed deadline (setup 12 s, finalization 15 s, worklet drain wait 17 s, model 120 s)
is an intentional successful-turn sleep. Hidden/native browser observation still uses
the serialized page-operation queue; a slow page can delay context independently
of provider inference. The synchronous diagnostic writer is also not a guaranteed
nonblocking operation; disk/renderer long-task timing would distinguish rare stalls.

## Deterministic probes and model/context findings

### Replay cannot catch up

Let P be retained preroll, C the onset→play delay, and L the onset→endpoint duration.
The worklet receives P+L audio and consumes at the same sample rate as live capture.
For C≤L, endpoint backlog is P+C. For C>L, endpoint also waits C−L before playback,
then P+L audio. In both cases endpoint→drain is approximately **P+C**, plus scheduling.
Longer utterances do not cure the backlog. This does not authorize accelerated PCM.

An actual-worklet VM probe at 48 kHz with controlled 20 ms processing/appends confirmed:

| P ms | C ms | L ms (each tested) | Endpoint→drain ms |
| ---: | ---: | --- | ---: |
| 700 | 0 | 200, 1,000, 10,000 | 700 |
| 700 | 500 | 200, 1,000, 10,000 | 1,200 |
| 700 | 1,400 | 200, 1,000, 10,000 | 2,100 |

The native second run independently gives 700+3,464=4,164 ms, versus measured
4,165 ms endpoint→release. Moving the same backlog into a Python/provider queue
would not remove it.

The actual Python `_send` method, executed with a fake queue/clock/socket, also
shows that anchoring the next deadline after awaited send accumulates send overhead:
10 s of 20 ms packets adds 50 ms for synthetic .1 ms/send or 500 ms for 1 ms/send.
At 40 ms packets the same cases add 25/250 ms. These are sensitivity calculations,
not live throughput. Root's 53 ms total send-await and zero queue at finish do not
justify changing the current pacing policy.

### Model buffering is real, but its size is route-dependent

A held-terminal probe delivered a complete sentence from the real workspace loop's
model iterator. There were zero published callbacks until terminal, then one.
This proves the gate, not a multi-second cost or a safe way to remove it.

Root's live empty-home results (times relative to case start, request starts 4–6 ms later):

| Case | First text ms | Terminal/published ms | Withheld tail ms | Rounds / calls |
| --- | ---: | ---: | ---: | --- |
| Short 1 | 1,287 | 1,323 | 36 | 1 / 0 |
| Six sentences 1 | 1,115 | 1,482 | 367 | 1 / 0 |
| Short 2 | 1,433 | 1,542 | 109 | 1 / 0 |
| Six sentences 2 | 607 | 1,095 | 488 | 1 / 0 |

The first three retained usage rows report 7,942–7,946 input tokens and 52–135 output
tokens. The fourth report lacks usage; it is unknown, not zero. The guided component
run had tool first text at 993 ms, terminal at 1,152, simulated receipt at 1,154,
answer-only first text at 3,234 and terminal at 3,543. Its safe answer **already
streams**, and an additional selector would not eliminate its second model request.

Production tool projection with all capabilities and log reading enabled: 15
workspace tools / 12,953 serialized bytes plus 18 hub tools / 9,531 bytes;
combined 33 / **22,483 bytes**, instructions **3,207 bytes**, before data/history.
Largest schemas are visual mock 3,074, browser action 2,106 and source flow 1,453 bytes.
Byte counts are not token counts.

A workspace-only controlled packet with 200-char user + 1,000-char assistant
exchanges measured input bytes 1,211 / 8,789 / 16,367 for 0 / 6 / 12 exchanges.
24 supplied exchanges still retain 12 and 16,367 bytes. History is capped at 12
records and 64,000 characters; tool history is separately trimmed near 32 KB while
keeping the newest protocol pair. Workspace input is bounded at 96 KB. Guided source
fills a 96 KB serialized-input budget with exact whole source lines. Instructions
and tool schemas are additional to that budget; attention reference context may
also increase instructions. Guided requests currently include a bounded workspace
hub projection and a separate actualHub projection, unlike the workspace loop's
explicit omission of the embedded hub.

Thus longer history/more tools/larger source can increase request size. **No causal
latency slope has been measured** for those dimensions. User history is not unbounded,
and nothing in these probes proves that the recent slowest device turn had large
context. Repeated browser reads and four sequential PR reads are independent suspects.

### Four PR-head reads before inference

The production `ReviewCoordinator` with controlled pinned cache/source, actual
`runGuidedReview`, and an immediate no-tool model produced this pre-model call order:

1. `getSnapshot → getReady → ready → revalidate → readPR`.
2. `getSnapshot → getProgress → ready → revalidate → readPR`.
3. `currentSource → file → ready → revalidate → readPR`.
4. `file → readFile → pinned source read → revalidate → readPR`.

One source read and four head checks occur before the first model call. A logical
250 ms/read probe totals 1,000 ms; no real network timing was inserted or measured.
Repeated tool/snapshot rounds multiply the checks. The current checks catch moving
heads and are not removable without an operation-scoped replacement that checks
the selected plan, exact source pins, cancellation and head before/after the read.

## Implemented bounded change

Commit **6b4ee76e79b32de0332b4fd11019410e323820ce**, exactly two source files:

- `apps/desktop/src/main/agent/meta-client.ts`
- `apps/desktop/src/main/agent/meta-client.test.ts`

`MetaClient` accepts optional `recordTiming(record)` and an injectable monotonic
`now` for deterministic checks. The callback reports SHA-256 request/attempt hashes,
fixed workload/status, input/instruction/tool/request byte counts, item/tool counts,
output cap, credential lookup time, request-relative headers/first framed SSE/first
nonempty text/terminal times, full iterator duration, streamed character count,
function-call count, HTTP status and validated numeric token usage. Missing stages
are null. No transcript, source, tool arguments, model output, response ID, request
ID, URL, SDP, exception body or key is emitted.

Provider stage times are captured before yielding their events. They include
transport/parser/scheduling and potentially downstream iterator backpressure;
they are not server-only inference measurements. Full duration also includes
credential and consumer/cleanup time. The callback occurs on iterator cleanup,
which can follow publication; abandoning an iterator without closing it cannot
produce a completion record. Observer failure is swallowed without changing
generation output, cancellation or usage accounting. Persistence, build/route/turn
correlation, retention and numeric schema admission remain integration-owned.
The optional hook alone neither changes inference nor reduces latency.

## Next safe input change: bounded preconnection

### First increment: provisional next capture during idle

Use a fresh PUSH_TO_TALK provider session; retain one physical microphone and all
preroll. Begin preparing the next peer/ASR while the explicitly started hands-free
session is idle, after the previous reply and actual PCM drain have completed.
This uses existing offer/cancel identity contracts. A distinct provisional handle
must not be mistaken for an active conversation turn.

- Allocate a future monotonically increasing identity once. Prepare its media and
  offer, but defer `onTurnStart`, UI exchange/history, agent work, final-transcript
  admission and active-turn exposure until VAD accepts real speech.
- On onset, atomically promote the same provisional identity/media, append the
  complete current 700 ms preroll exactly once, and continue normal capture. If it
  is still connecting, retain the current FIFO/failure behavior. Do not cancel the
  prepared handle in the existing `beginUtterance` interruption step.
- `getIdentity()`/busy/phase must continue to describe active work only. Idle
  preparation must not prevent attention. Starting reply-only attention retires
  preparation with **voice-only** cancellation before allocating the attention turn;
  late cleanup cannot cancel that newer identity or its agent.
- Stop, typing, manual interruption/source change, disposal, failed preparation and
  lease expiry invalidate the provisional epoch synchronously and close/cancel it.
  Compensate a late offer allocation. Promotion and expiry must be mutually exclusive.
  Idle prewarm failure may fall back to normal cold capture without ending a healthy
  microphone; failure after promotion follows current active-turn rules.
- Initially prewarm only after session start or a real turn's completion, never
  while an old peer is speaking. Barge-in remains the existing cold, generation-safe
  path. Do not delay barge-in waiting for a warmed candidate.
- Bound the provisional lifetime from **preparation start**, not connection-ready.
  A candidate 20 s lease leaves room under the sidecar's existing 60 s capture wall
  limit for a 30 s utterance plus drain. Expiry should return to cold-ready listening;
  avoid unbounded reconnect loops. This is a proposed bound, not provider validation.

Precise proposed reservation (not edited by this author):

| Files | Responsibility |
| --- | --- |
| `renderer/voice/controller.ts`, `controller.test.ts`, `types.ts` | Provisional lifecycle, identity promotion, active-only publication, voice-only cleanup, lease and attention/cancellation races |
| `renderer/voice/hands-free.ts`, `hands-free.test.ts`, `hands-free-types.ts` | Idle preparation trigger, onset promotion, session stop and preparation option |
| `renderer/voice/hands-free-audio.ts`, new/appropriate audio lifecycle tests | Prepared virtual track ownership without losing shared microphone/reference or resetting accepted PCM |
| Existing worklet and its tests, **only if protocol changes prove necessary** | Keep sample order/epoch/drain; do not reserve speculatively |
| Root `renderer/conversation/voice.ts` and native harness | Opt-in wiring and integrated acceptance after evidence; root owns these edits |

With a fully ready candidate, the FIFO prediction changes from C+P to P. In the
current native example, up to 3.46 s of setup could move before onset; residual
preroll remains 700 ms, endpoint silence remains, and no benefit is promised when
the user speaks before preparation finishes or after its lease expires.

**Provider-lifetime gate:** the current virtual track outputs zeros while waiting
for real queued input; a connected sidecar accepts that silent PCM. Validate that
a fresh PUSH_TO_TALK session held this way remains usable at 0/5/20 s, that blank
final/close is detected before promotion, and that send pacing/queue/capture bounds
remain correct. Do not assume that holding an acknowledged socket with no audio
is supported. No root idle-hold experiment has yet established these conditions.

### Later increment: independent ASR preparation during playback

The larger alternative separates ASR input lifetime from the active TTS peer. A
sidecar-owned bounded prepared-stream slot can overlap ASR open with the preceding
answer, then be adopted exactly once by a new generation. It requires explicit
prepare/adopt/retire identity and configuration-version semantics, stored readiness,
late failure cleanup, pre-adoption event suppression, pacing during the hold and
shutdown/credential-change ownership. The current Manager's one-session-per-ID
replacement closes the old peer, so issuing a new ordinary offer during playback
is not this design and would break it.

Root must reserve/define private protocol plus lifecycle in `main/voice/protocol.ts`,
`main/voice/service.ts`, `sidecar.ts`, `services/voice/voice_sidecar/{protocol,server,
session,providers}.py`, matching tests, renderer hooks, and composition. Do not
smuggle pool ownership into foreground speech cancellation or let a stale prepared
stream become a new turn. Keep one consumable candidate, finite lease and bounded
retry policy. This larger design is not implemented or proven by the idle design.

### Continuous input and trimming alternatives

Meta's primary documentation defines PUSH_TO_TALK as single-turn; ENDPOINTING has
speechStart/speechEnd/speechComplete, potentially overlapping turn completions and
partials without turn IDs. `endStream` ends the entire input session; there is no
client per-turn commit. Audio must remain real-time paced. A persistent endpointing
transport therefore needs a separate provider-turn-to-app-generation mapping and
new endpoint/cancel semantics, not a reused finished PTT socket.
[Meta STT guide](https://dev.meta.ai/docs/speech-to-text),
[voice schemas](https://dev.meta.ai/docs/api-reference/voice/schemas).

Dropping complete exact-zero frames before the first nonzero preroll sample cannot
remove phonemes, but normal quiet microphone frames need not be zero. Do not trim
using VAD confidence or remove a fixed prefix: a candidate may span 600 ms, and soft
consonants can precede accepted onset. Preserve all PCM from the first retained
nonzero frame, including gaps and the first speech sample. This was not shipped
because expected physical benefit is unproven and smaller than measured setup.

## Safe model changes and required experiments

An optional empty-argument semantic finish tool could select one subsequent
tools=[] streaming final phase after effects/receipts settle. Keep planner prose
buffered, reject unsolicited calls, fence generation/content, preserve exact source
and allow no output-limit retry after an emitted prefix. Never stream early based
on the absence of a call so far or prompt keyword routing. Meta documents only
`tool_choice:auto`; do not assume a forced/required selector exists.
[Meta Responses schemas](https://dev.meta.ai/docs/api-reference/responses/schemas).

For that change to help, the removed full-answer tail must exceed the added
selector/second-request latency and segmentation overhead. The observed 36–488 ms
tail is too small to justify an extra round without paired evidence. Existing guided
post-navigation streaming already follows the safe phase. No new default route,
filler speech, model switch, or token-cap reduction was implemented.

Root experiment plan, with numeric records and exact build SHA:

1. **Input A/B:** existing cold path versus bounded prepared path; same known phrase,
   same explicit microphone session and device settings; alternate order. Include
   immediate onset, 5/20 s idle, lease expiry, first and subsequent turns, short/long
   utterances, setup failure and speech during prior TTS. At least ten successful
   pairs per normal condition; retain cancellations/failures as separate outcomes.
   Report median, range and empirical tail without claiming a stable p95 from tiny n.
2. **Review/context attribution:** instrument real `ConversationService` and coordinator
   ports; separate four `readPR` durations, source retrieval, page queue/observation,
   hub reads and packet assembly from model request time. Use controlled source for
   provider experiments; actual user context only under root's existing authorization.
3. **History/size matrix:** 0/6/12 retained exchanges; empty home / populated hub /
   displayed small file / near-budget file; ordinary follow-up / one navigation /
   multi-tool request. Record bytes, actual input/cached/output tokens, route, round,
   retries, tool counts/durations, receipt waits, first safe publication and first
   speech segment. Use matched prompts and alternating order; do not mix outcome types.
4. **If final-phase streaming is tested:** compare whole-turn first PCM, not provider
   TTFT alone; include long punctuation-free text and short replies. Require unchanged
   tool/source authority, no preamble, no duplicated speech after retry, late-token
   suppression and correct manual/source/sidebar behavior before enabling.
5. **Physical acoustics:** later, explicitly user-started microphone/speaker checks
   with soft onset, final consonants, hesitations and echo/barge-in. Neither synthetic
   recorded speech nor analyser PCM proves room acoustics or physical audible onset.

Missing numeric telemetry should use fixed categories, hashed correlation and
bounded counters: capture-frame and candidate/onset/endpoint times; preroll/queued/
sent/processed sample counts; old teardown, offer/ASR/RTC ready; RTP tail; endStream,
final-received and final-published; context and tool/receipt spans; first segment;
TTS headers/first byte/first complete chunk; first renderer PCM and final drain.
Use monotonic deltas within a process and explicit cross-process correlation, never
subtract unrelated clocks. Include build/revision and controlled/live/physical
evidence category. No transcript, source, key, URL, SDP or raw exception logging.
The current strict conversation diagnostic schema cannot accept these additions;
integration must publish its migration and bound/rate-limit/rotate persistence.

## Validation and handoff limits

- `bun --no-env-file install --frozen-lockfile --ignore-scripts`: passed; no manifest
  or lockfile changes. Initial wider tests had two module-load failures because this
  fresh checkout lacked `zod`; the independent 13 pure voice tests passed then.
- After installing the exact lock, **75 tests passed, zero failed** across
  `meta-client.test.ts`, `workspace-conversation.test.ts`, `guided-review.test.ts`,
  `activity.test.ts`, `hands-free-worklet.test.ts`, `sentences.test.ts`.
- Four new timing tests cover distinct stage clocks/UTF-8 size/privacy, missing
  stages and tool/incomplete/HTTP cases, cancellation and observer failure, missing
  credentials and abandoned consumer cleanup. Existing source/receipt/cancel/early
  speech/retry tests continue to pass.
- Main TypeScript check and scoped Biome passed; `git diff --check` passed. An initial
  test-only iterator-return type error was corrected before this final check.
- Deterministic probes described above used actual source and controlled ports or
  clocks, with no live network. No new native/provider/microphone experiment was run
  by this worktree. No shared contracts, composition, manifests, model routing,
  speech thresholds, PCM pacing or playback drains were edited.

MET-51 remains In Progress. The timing seam is ready for root review; the materially
useful input fix has a concrete reservation/design and unresolved provider idle-hold
acceptance, not a claimed deployment or measured speedup.
