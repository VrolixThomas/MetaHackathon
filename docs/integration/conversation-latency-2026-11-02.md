# MET-8 / MET-51 conversation repair and latency handoff

Worker branch: `demo-story-conversation-fix-20261102`, created at release base
`036bbf821f23d4cecc6ece120845637ab9f84bff`. Correctness is isolated in
`3a05390101a0d463c12e82f159e489e6f3019f48`; latency code and the reproducible probe
are in `0306225c356ccb7ef6f4c2633b66fc99446c1199`. No dependencies, shared contracts,
composition, provider configuration, microphone thresholds or preconnection changed.

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
