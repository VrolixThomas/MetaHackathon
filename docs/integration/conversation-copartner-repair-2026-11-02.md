# Foreground copartner repair, 2026-11-02

Single worker: `demo-story-conversation-fix-20261102`, parent `zS0yrvhTsVyYlZECDNBam`.
Clean merge of `origin/main` **50bed884f4b199fd04f5f53e7f1e245f8362c165** is `e4e3c65`.
All prior nine worker commits remain in history. No install, native launch, live model call,
credential lookup, preview restart, user-data access, MET-77 mutation, push or main merge.

Implementation commits, in order:

- `3468c00`: narrow spoken Stop ingress, copartner instructions, session admission generations.
- `487198e`: requested/selected ticket and historical-job context; returned-existing-job chronology;
  main-only operation diagnostics and the single `services.ts` callback.
- `be17145`: bounded ticket discussion streaming, controlled orchestration/voice regressions and
  synthetic quality replay with an explicitly injected live Meta option.
- `a9a5ad0`: replay timing begins before synchronous turn submission.

## Behavior and boundaries

Complete final utterances such as “Stop”, “Please stop speaking” and “Stop talking, please” finish
quietly before acknowledgement, agent start or speech synthesis. Interim “Stop”, “Stop the worker”,
“Don't stop”, and meaningful longer sentences remain ordinary speech input. This closes the
foreground utterance only. Actual hands-free controller tests retain the same audio session and
accept Continue as the next real user turn. Background workers are never owned by this path.

Copartner instructions apply to workspace, ordinary conversation and guided review. They ask for the
consequential insight, a reasoned recommendation and at most one consequential product question.
Requirements, recommendations, implementation evidence and unknowns are distinct. A choice continues
the discussion, without automatically offering review/publication or reciting paths/checks.
These instructions alone do **not** prove live model quality.

Before the first request, current/requested ticket context includes its actual bounded description,
up to three relevant existing jobs, creation/update time, brief, readiness, recorded review/publication
metadata and session admission provenance. The ticket uses the existing live provider read; local jobs
use current main-owned job reads and exact ticket/job identity checks. Failed reads withhold details.
No source is inspected by this preload, no new repository authority is established, and no acceptance
or publication authority is inferred. Existing source/head/consent/idempotency/display gates remain.
The historical job's implementation summary, file paths and checks are deliberately absent from this
planning packet. There is no cross-turn detail cache.

Requested ticket matching uses actual observed identifiers. A bare spoken number is considered only
on the ticket board with a ticket reference and a unique match. Ambiguity falls back to the ordinary
loop. This does not explain the cause of the recorded ASR fragment.

Session effects record actual submission generations. A successful start can return an existing job:
the retained receipt marks known reuse and never claims that a returned job proves new creation.
Jobs with no session admission record are explicitly existing work. That context cannot justify
“I just started it” or a premature-start apology. Tests exercise an existing ready job both without
any new operation and when an explicit request returns the same job.

## Streaming and round reduction

A conservative, app-owned ticket discussion selector uses the real utterance, real dialogue and
fresh ticket context. It is capability selection, **not** a consent classifier. Recognized planning
questions and bounded choice/Continue followups use `tools: []` immediately, with Spark/minimal and
no preliminary routing request. Explicit operations, implementation/source questions, difficult
analysis and unknown phrasing keep the ordinary gated tool path. Explicit prior start requests do
not become discussion-only choice continuations. No response text or ticket-specific recommendation
is hardcoded.

A recognized mixed open-and-discuss request exposes only actual ticket navigation. Navigation prose
stays buffered. After the existing applied display receipt and refreshed detail, the answer request
has no tools and streams. First publication checks acknowledged content sequence again; sidebar-only
changes remain compatible. Subsequent manual/account interruption uses existing generation cancellation.
Unsolicited function calls cannot execute. Output-limit errors after published text cannot retry and
repeat speech. Existing final narration checkpoints and speech-ended/drain handling remain required.

Controlled tests prove publication before provider terminal, **and** actual ConversationService →
VoiceController speech requests before terminal while final narration acknowledgement waits for drain.
That test injects PCM observations/media events; it is not native Chromium media or physical audio.

Limitations: the selector is intentionally conservative and English-oriented. Unsupported phrasing
can retain extra rounds. General greetings outside this ticket path still use the existing tool-capable
workspace path. Deep analysis retains the fast selection + Wonder/high answer, currently buffered.
No provider/model/billing setting, endpointing/VAD, ASR transport or preconnection setting changed.

## Diagnostics

`foreground-timing` is main-only, validated by a strict private schema. Fixed operation names include
preload ticket/job, workspace/hub observation, registered tool identifiers, model, workspace execution
including receipt wait, and narration receipt. Other tool families map to a fixed category. Records
contain hashes, sequence, fixed status and numeric durations/first-text time only. Provider-supplied
names, arguments, transcripts, answers, source, URLs and credentials never become log values. Renderer
RPCs cannot submit this record type. Public `VoiceDiagnostic` and all shared DTOs are unchanged.

`ConversationService.onTiming` forwards to the existing private rotating diagnostic sink via one line
in `services.ts`. A model record's request hash joins existing provider model timings; turn hash and
operation sequence associate the selected tools with that round. Timings are inclusive and nested:
**do not sum them**. Workspace execution includes the receipt wait; it does not separately measure
native receipt-only latency. Narration has its own measured receipt wait. Existing rate/size limits
can drop diagnostic rows; logging failure cannot fail a turn.

The supplied numeric retry trace was read. It shows four model rounds for the mixed request, two for
the choice, and three for Stop, with detected speech-end → first audio of 15943/11256/15463 ms.
It contains counts, not original tool identities, so the exact historic tool sequence is unknown.
The new instrumentation lets root inspect that sequence on the next real run. Earlier smaller
prompts did not establish an end-to-end speedup.

## Controlled measurements

Three runs at **a9a5ad0** with `bun apps/desktop/src/main/agent/foreground-replay.ts`.
Each model request injects 20 ms until first text and another 80 ms until terminal. Context and
navigation ports use synthetic in-memory data; no artificial network or native receipt delay is
included in these measurements. A separate held-receipt regression proves gating. Times below are
poll-observed milliseconds from foreground turn submission; no first PCM is measured.

| Synthetic turn | Model calls | Tools per request | First published ms, three samples | Completed ms, three samples |
| --- | --- | --- | --- | --- |
| Exact mixed open/explain text | 2 | 1, 0 | 138, 136, 141 | 217, 217, 222 |
| Scope choice | 1 | 0 | 23, 24, 22 | 105, 105, 103 |
| Continue after choice | 1 | 0 | 26, 23, 23 | 108, 103, 103 |
| Ordinary why question | 1 | 0 | 26, 22, 22 | 107, 104, 102 |
| Recommendation question | 1 | 0 | 26, 23, 24 | 104, 103, 105 |
| Difficult reasoning | 2 | 20, 0 | 214, 204, 205 | 214, 204, 205 |
| Implementation unknown | 1 | 20 | 106, 102, 104 | 106, 102, 104 |

Input JSON bytes are 4422/4731 for the mixed requests, 4586 for choice, and 4717 for Continue;
these exclude instructions/tools and are **not token counts**. The 20-tool fallback is this synthetic
port configuration, not a universal product count. Stop is separately proven to have zero agent
starts and zero synthesis requests through the actual controlled voice controller.

These waits demonstrate removed orchestration rounds and streaming overlap only. They cannot be
compared as speedups against the live observations above. Live token counts, output quality,
warm/cold behavior, ASR and first-PCM latency remain unmeasured for this repair.

## Root replay and acceptance

Controlled, no credentials or data mutations:

```sh
bun apps/desktop/src/main/agent/foreground-replay.ts
bun test ./apps/desktop/src/main/agent/foreground-replay.test.ts
```

The exported `replayWithMeta(getApiKey: () => Promise<string | null>)` uses the actual MetaClient and
ConversationService. Root can inject its approved **main-only credential closure**; the module never
reads `.env`, process credentials, a product store or a native application. It runs the public/synthetic
scenario, including historical ready work, ordinary/difficult questions and an implementation-unknown
question. All external/worker/write ports reject; navigation modifies only ephemeral harness state.
There is a 24-request per-scenario cap, 90s model timeout and 120s turn deadline. It returns actual
answer text for human assessment plus numeric request/operation/provider timing. Only this explicit
replay artifact contains synthetic questions/answers; production diagnostics never do. Live provider
usage is real; worker did not run this option.

Human assessment should check whether the answer adds a useful consequence and reasoned recommendation,
asks only a consequential question, accepts the choice without a job-receipt dump, keeps existing work
historical, and admits missing source. Test unusual wording and another ticket/topic as well as MET-77.
The controlled tests check context, authority, call counts, chronology and delivery ordering; scripted
text is labeled and does not establish those human quality judgments.

Root owns native/live checks and any preview restart. Suggested native regressions: hands-free,
workspace, attention, comment conversation and executive. Root should inspect actual model/tool traces,
final dialogue, first published sentence and first PCM on the same build; do not infer acoustic
performance from these controlled media observers. Existing live MET-77 remains untouched.

## Validation

313 focused controlled tests pass, zero failures/skips: voice controller 62, hands-free 58, hub tools
60, workspace conversation 17, conversation/history 15, guided review 37, attention 14, PR comment fixes
31, PR comment tools 5, replay 8, latency 2, diagnostics 4. Tests were run with exact `./` paths so old
ignored probe source copies under `out/` were not selected. The first bare-path test invocation did
select those old copies and failed; the exact-source rerun is the reported result.

Type-check, targeted Biome, repository lint (731 files), build and whitespace checks pass. The old
selected-ticket latency assertion was updated to require streaming before terminal and its one new
first-text display revalidation read; all tool-capable buffering/receipt assertions remain. No native,
live-provider, microphone, deployment, signed-distribution or product-quality acceptance is claimed.
