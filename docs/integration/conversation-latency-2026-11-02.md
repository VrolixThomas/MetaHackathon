# MET-8 / MET-51 conversation repair and latency handoff

Worker branch: `demo-story-conversation-fix-20261102`, created at release base
`036bbf821f23d4cecc6ece120845637ab9f84bff`. Correctness is isolated in
`3a05390101a0d463c12e82f159e489e6f3019f48`; latency code and the reproducible probe
are in `0306225c356ccb7ef6f4c2633b66fc99446c1199`. No dependencies, shared contracts,
composition, provider configuration, microphone thresholds or preconnection changed.

The later user-directed context/model-profile increment is recorded below at `8d7452ad9c4b1dda360325102817797fadb8b1bb`; it supersedes the all-tools default used by the first latency comparison.

## Correctness

Cancellation and failure retain the actual user utterance and published assistant
prefix. Interrupted context explicitly says it may be unheard; ordinary voice output
without an accepted full spoken checkpoint remains unconfirmed. Whole-record history
bounds include these annotations. Late cancelled output cannot append history or
workspace effects. Workspace voice replies now finish through the existing narration
checkpoint, so cancellation while playback is pending retains the discussion.

`start_work` has an agent-local admission boundary independent of the planner's tool
selection. A separate no-tools Muse classification checks real user turns, the proposed
brief and retained clarification context. Main validates its strict result and exact
user-turn evidence before any operation. Planning/unclear/unresolved, malformed results,
forged/partial quotations, unavailable classification and cancellation fail closed.
A clear current answer may satisfy an earlier explicit start request; assistant text
cannot become a user answer. A conservative question reference survives cancellation
and ordinary history eviction. An exact cited clarification without a question mark
can also support an answer. This remains semantic model classification, not a claim
of perfect natural-language interpretation. Controlled tests establish enforcement of
the classifier result and evidence boundary, not live model classification accuracy.

A session records each start attempt before dispatch and retains confirmed job identity
or an uncertain outcome. Later turns cannot replay it. Existing actual hub/job reads
provide current state for corrections; stopping speech never sends worker cancellation.
This protection is session-local, supplements the existing durable main job ledger,
and is not a new durable consent protocol. Starting work incurs one additional bounded
model round for correctness; greetings, planning, follow-ups and read/navigation tools
do not incur that classification round.

Foreground instructions no longer request a priority brief or notice tail on ordinary
answers. The automatic walkthrough tail was removed. Pending discussion defers notice
queueing; notices remain unannounced. The independent attention scheduler, delivery
proofs and comment/approval gates are unchanged. Empty finalized/cancelled/error capture
attempts leave the exchange list; active capture is a status, not a fabricated user
message. Substantive transcripts/replies and global error diagnostics remain.

## Current-session observations and scope

Parent supplied sanitized numeric installed-v0.1.1 diagnostics, with no audio, transcript
or credentials. Six turns with observed first PCM had detected-endpoint-to-PCM intervals
6.105, 8.807, 7.027, 15.963, 9.282 and 16.310 seconds. Five were later interrupted; their
observed initial latency is still real. The two longest turns used six/five serial model
requests and five/four tool calls; agent-to-published-answer was 12.906/13.160 seconds,
while answer-to-first-PCM was 379/499 ms. Even the greeting reported 17,822 input tokens.
These are uncontrolled user-session observations, not a before/after experiment. The
endpoint timestamp excludes the detector's preceding quiet interval and is not acoustic
speech end. The cause of the incomplete recognition fragment is not established.

Read alongside `voice-latency-deep-dive.md` and
`evidence/voice-preconnect-2026-10-31.json`: historical warm/cold ASR experiments establish
neither current model latency nor a speedup from this patch. Default bounded ASR/RTC
preconnection, input replay, silence thresholds and playback drain remain intact.

## Measured changes

The controlled probe runs actual `ConversationService`, tool orchestration and all 70
production tool schemas. Only provider responses, observations and workspace receipts
are controlled. It injects 10 ms per observation port, 20 ms before provider text and
40 ms before its terminal event, plus a 20 ms workspace receipt delay. It makes no
network calls and launches no native app. Three sequential samples were taken at each
exact source revision. Raw numeric records are in
[evidence/conversation-latency-2026-11-02.json](evidence/conversation-latency-2026-11-02.json).

The router's just-read workspace observation now supplies the first model round, and
each round reuses the hub snapshot embedded in that same observation. Later rounds
still re-observe the workspace; Day remains freshly read. Explicit inspection and
current-head/source/consent revalidation are unchanged. There is no TTL or cross-turn
cache. The final model request still follows the actual tool/receipt result.

| Scenario | Model rounds before/after | Observation calls before → after (workspace / hub / Day) | Injected context wait before → after |
| --- | --- | --- | --- |
| Simple conversation | 1 / 1 | 2 / 3 / 1 → 1 / 1 / 1 | 60 → 30 ms |
| Planning + real follow-up, two turns | 2 / 2 | 4 / 6 / 2 → 2 / 2 / 2 | 120 → 60 ms |
| One workspace action + answer | 2 / 2 | 3 / 5 / 2 → 2 / 2 / 2 | 100 → 60 ms |

The repeated top-level `$schema` declaration is omitted from each function parameter
schema. All 70 tools, descriptions, refs, required fields and validation constraints
remain. Tool JSON decreases from **53,618 to 49,628 UTF-8 bytes** per request (3,990 bytes,
7.4% of tool bytes). No model request or routing classifier is added for this reduction.
Native/live acceptance should confirm provider compatibility of this equivalent schema
representation. Input-token counts are **unavailable** in the controlled probe; bytes
are not relabeled as tokens.

| Median controlled published-text time | Release 036bbf8 | Correctness 3a05390 | Latency 0306225 |
| --- | ---: | ---: | ---: |
| Simple, first answer | 129.1 ms | 130.1 ms | 99.6 ms |
| Planning, first answer | 128.3 ms | 127.3 ms | 93.4 ms |
| Workspace action, answer after receipt | 266.3 ms | 267.1 ms | 219.5 ms |
| Planning + follow-up, both complete | 256.5 ms | 256.5 ms | 190.8 ms |

Comparing 3a05390 to 0306225 isolates the latency patch: their instruction bytes (4,631)
and per-scenario input bytes are identical. Simple input is 3,445 bytes; planning requests
3,490/3,740; action requests 3,455/3,835. The release's shorter instructions and missing
interrupted-context annotations are measured separately in the evidence. Request start,
provider first-text and terminal timestamps and actual controlled receipt wait are also
recorded. The tool port has no injected work beyond that receipt wait.

These measurements establish eliminated serial port calls and fewer request bytes.
They do **not** establish live model speedup, first-audio improvement, physical acoustics,
or warm/cold/long-idle provider behavior. First audio and provider token counts are null;
provider lifecycle is explicitly not observed. The seven-second-plus live pauses are
not claimed fixed by tens of milliseconds of controlled observation savings.

## Remaining latency work and integration validation

The main observed cost remains repeated tool/model rounds and a large tool surface.
Removing unrelated notice/priority instructions should avoid unnecessary rounds, but
this is not measured as a live treatment effect. All capabilities remain available.
Tool-capable prose stays buffered: the provider can still return a tool call after text,
so publishing it early could narrate unaccepted effects. The existing guided-review
no-tools phase already streams after navigation and validates the screen per delta.
A general workspace final-answer phase needs a similarly explicit, validated transition;
blindly dropping tools after one operation could truncate legitimate multi-action work.
No default extra routing/classification round was introduced to shrink tools.

Root should run the integrated build and controlled native gates (`test:integration`,
`test:hands-free`, `test:workspace`, `test:attention`, `test:comment-conversation`,
`test:executive`). The unit regressions exercise actual service/tool paths, but do not
prove native display/media behavior. In particular verify final voice checkpoints with
barge-in, listening continuity, modal/focus deferral, comment consent and native source
receipts. No new native harness or manifest wiring is required for these existing gates.
For a separate live experiment, compare equivalent prompts/source state at pinned builds
and include every attempt with observed first audio even when later interrupted. Record
request tokens/rounds and endpoint/transcript/published-text/PCM stages. Stratify warm,
immediate cold and long-idle/expired preconnection; do not infer that state from transcript
content. Do not reuse or alter the user's already-admitted live job to run an experiment.

Reproduce the controlled probe without loading `.env`:

```sh
bun --no-env-file apps/desktop/src/main/agent/conversation-latency.probe.ts . 0306225c356ccb7ef6f4c2633b66fc99446c1199
```

For baseline code, extract `git archive <revision> apps/desktop/src` into an ignored
`out/` directory and pass that directory instead of `.`; use the current probe for every
revision. The recorded source trees were archived from the exact commits above. Run
focused tests with explicit `./apps/...test.ts` paths so Bun does not also discover any
archived tests under `out/`.

## Worker validation

Final isolated Bun runs at 0306225: **247 passed, zero failed**, 11 files:
conversation12, history3, hub50, workspace17, latency2, guided-review36,
attention14, PR-comment-tools5, PR-comment-fixes31, renderer conversation17,
renderer voice60. Controlled late events, scope evidence, admissions, notice proofs,
empty captures and fresh post-effect observations are exercised. Frozen install,
`bun run type-check`, targeted Biome, `bun run build` and whitespace checks passed.
The fresh checkout initially lacked dependencies; frozen installation resolved that
without changing manifests or lockfile. Old expectations that interrupted turns and
empty capture placeholders remain/disappear incorrectly were updated to the required
behavior. No tests were skipped. No native, installed-app, live-provider, packaging or
physical microphone acceptance is claimed, and no feature ticket was marked Done.

## User-directed context and model profiles

Subsequent implementation: **8d7452ad9c4b1dda360325102817797fadb8b1bb**. Routine
foreground requests retain the existing `quick` route (Muse Spark 1.3, minimal reasoning).
The app chooses the profile from the acknowledged primary canvas and exact selected
item before inference; there is no preliminary routing model call. Home uses six existing
navigation tools plus `expand_tools`. Ticket/job, review/source, browser, canvases, Day,
Slack, knowledge, comments and approvals have focused capability families. Expansion
only changes the prompt's capability/context selection; all existing operation parsers,
source/actor checks, user consent and display receipts remain authoritative. It is not
a new authorization mechanism. Existing valid registered operations retain their runtime
gates even if a controlled provider names one outside its advertised profile.

Explicitly expanded families persist for a real follow-up while the actual pane/item
stays the same. Sidebar-only changes do not erase them. An actual content/item switch
resets expansion. Retained real conversation, unresolved-question reference and admitted
job effects remain in context. Ordinary Home omits unrelated queue data and explicitly
labels omissions rather than claiming the queues are empty. A selected ticket limits its
summary/jobs/notices to that item. Explicit queue questions can expand and inspect the
actual hub. No model/worker/source text gains consent from any of this context.

Selected ticket details and selected saved-job details are read through the existing
main-owned authorized ports before the first fast request; source canvases supply bounded
exact pinned source through existing line-preserving projection. A failed detail read
produces a fixed unavailable marker and does not block an ordinary greeting. The displayed
PR path already loads validated pinned file/source before inference; its request now uses
the focused review tools and omits duplicate/unrelated hub queues. These reads do not
claim new display or execution. Generated explanations remain inference.

`analyze_current_context` is a separate read-only escalation: the fast controller can
choose it for a difficult ticket/job/source/PR question, and the actual second request
uses `deep` (Muse Wonder 1.0/high) with **no tools**. Routine questions do not invoke it.
The bounded input comes from the already authorized current packet, not model-supplied
source text. Workspace analysis rechecks acknowledged content before publishing; sidebar
revisions alone are tolerated. Guided PR analysis uses the existing per-delta screen
fence and tools-free streaming mechanism. Cancellation rejects late deep output and
never owns background work. No alternate provider, model fallback or new key was added.

### Extended exact-revision controlled comparison

The same extended probe and six scenario inputs ran three times sequentially at release
036bbf8, snapshot/schema-only 0306225, and profile 8d7452a. Full records are in
[evidence/foreground-context-profile-2026-11-02.json](evidence/foreground-context-profile-2026-11-02.json).
All delays remain controlled as described above. The provider is deliberately scripted
to answer the selected-ticket question directly on both versions; this does not establish
that the old version had enough context. Separate service regressions establish that the
new first packet contains the freshly authorized full ticket description and selected
source identity.

| Scenario | Release → profile tool counts per request | Release → profile tool bytes, first request | Model calls release → profile | Median published text release → profile |
| --- | --- | ---: | --- | ---: |
| Greeting | 70 → 7 | 53,618 → 3,157 | 1 → 1 | 130.6 → 99.8 ms |
| Planning + follow-up | 70,70 → 7,7 | 53,618 → 3,157 | 2 → 2 | 127.8 → 93.2 ms, first answer |
| Open tickets + answer | 70,70 → 7,22 | 53,618 → 3,157 | 2 → 2 | 269.0 → 223.4 ms |
| Selected-ticket question | 70 → 23 | 53,618 → 10,384 | 1 → 1 | 130.5 → 117.5 ms |
| Explicit scoped dispatch | 70,70 → 23,0,23 | 53,618 → 10,384 | 2 → 3 | 245.6 → 286.9 ms |
| Displayed PR explanation | 76 → 19 | 55,643 → 9,107 | 1 → 1 | 147.1 → 136.6 ms |

The dispatch cost is explicit: the added admission guard consumes one 60 ms controlled
provider round, and both planner rounds now read the selected ticket (two 10 ms port
waits). Exactly one controlled start admission occurs; there is no real worker/checkout.
This correctness cost is not hidden in an aggregate speedup. Against the snapshot-only
0306225, selected-ticket median is **100.8 → 117.5 ms**, reflecting the extra fresh read;
model delays are fixed and cannot demonstrate inference gains from fewer tokens.

For the first request, input + instruction + tool JSON bytes are **60,957 → 9,766** for
Home, **61,159 → 18,259** for a selected ticket, and **70,861 → 22,688** for the selected
PR. These are measured request-component byte sums, not exact HTTP bytes or token counts.
The profile's default fast greeting remains one request and no classifier. Live model
latency, actual provider token counts, warm/cold/idle behavior and first PCM still require
root's controlled native/live comparison. No drastic user-perceived improvement is claimed.

Final profile validation: **255 passes, zero failures**, the same 11 isolated test files
(history3, conversation12, hub57, workspace17, latency2, guided37, attention14,
comment-tools5, comment-fixes31, renderer17, voice60). New checks cover first-request
ticket/source data, unavailable-source fallback, expansion and follow-up, distinct deep
workload, late cancellation, and sidebar-only versus changed-content fencing. Types,
targeted Biome and build pass. The V1 native harness compatibility update accepts the two
new tool names and omitted scoped queues while still rejecting any present seeded queue.
Its `node --check` and `node .../v1-smoke.cjs --self-check` passed; it was **not launched**
with Electron. Root must retain actual startup UI/IPC checks: omitted model context is not
proof that the underlying hub is empty.

### Coding-model pin: separate integration seam

The inspected `coding-worker.ts` still hardcodes `workload: "quick"`. This worker did
**not** flip it globally. Parent received the following concrete proposal before any
out-of-reservation change:

1. At NEW Meta coding-job admission, main's `work/coding-provider/pin.ts` durably pins
   exact Wonder 1.0/high model settings alongside the existing provider/path identity.
2. Pass the main-only pin via additive `CodingTaskInput` fields and persist/check it in
   `CodingWorkerCheckpoint`; `requestModel` must honor the exact pin, not a changing global
   default. Reject a mismatch or unsupported model instead of falling back.
3. Existing provider pins/checkpoints without the field resolve Spark 1.3/minimal. This
   includes previously admitted jobs without a checkpoint; changing only the worker's
   no-checkpoint default would silently switch those jobs and is unsafe.
4. Preserve provider/billing/session identity, especially existing ready jobs. Do not
   rerun, cancel, migrate or alter the user's MET-77 job to implement or test this seam.

Integration owns agreement on that main/work admission/checkpoint migration. No coding
job, provider pin, settings, shared DTO or installed profile was changed by this worker.
The foreground deeper-reasoning path is implemented independently; stronger NEW coding
jobs remain an explicit integration dependency, not a claimed completed behavior.
