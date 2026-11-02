# Conversation repair and model routing acceptance

The demo-story Codex worker started from released main `036bbf8`. Integration
reviewed and applied its foreground handoff as `e0e4705` through `5cefe5e`, then
its coding-model handoff as `2cf1520` through `d715778`. The worker checkout
remains separate and its temporary reservations are released on MET-8.

## Result

Interrupted conversation retains the real user utterance and published assistant
context, explicitly marked as potentially unheard. A separate work-admission check
requires exact real-user evidence and settled scope. Ambiguous fragments do not
grant a scope choice merely because the planner requested a start. Admitted or
uncertain attempts retain identity, and speech cancellation still does not cancel
background coding jobs. Empty completed capture attempts no longer become user
messages. Unrelated priority briefs and automatic notice tails are removed from
ordinary foreground conversation; the independent attention scheduler remains.

The app selects a focused tool family and supplies authorized selected-ticket/job
details or pinned source before the first fast request. Ordinary conversation
uses Spark/minimal. Focused deeper PR/ticket analysis uses a separate read-only
Wonder/high capability. The controlled greeting tool menu falls from 70 to 7;
selected-ticket and PR requests also shrink. These are request-footprint and
controlled-orchestration results, not measured live speech speedups.

New API coding jobs durably pin Wonder/high before admission. Legacy jobs,
including queued jobs without checkpoints, retain Spark/minimal when historical
model metadata is absent. Explicit existing pins are preserved. Admission,
provider-marker and checkpoint conflicts fail closed. Subscription CLI sessions
retain their separate provider/billing protocol; no fallback is introduced.

## Verification

The worker's focused foreground group passed 255 tests and its model-pin group
passed 193, with no failures or skips in either group. These groups overlap and
are not summed into a unique full-suite count. Worker type-check, lint and build
passed. Integration repeated repository type-check and lint (725 files), and
native suite builds passed.

Integration ran these actual built-app suites with controlled upstream providers:

- `test:integration`: empty startup, real conversation IPC/history and cancellation.
- `test:hands-free`: actual Chromium media, first PCM/drain, interruption and listening continuity.
- `test:workspace`: canvas/native-browser operations, source and display acknowledgements.
- `test:attention`: delivery/quiet/focus/input deferral and durable receipts.
- `test:comment-conversation`: exact canonical draft/display/consent/posting guards.
- `test:executive`: actual coding child, Git/checks, decisions and checkpoint behavior; rerun after model pins.
- `test:coding-provider`: provider selection and durable worker identity.
- `test:pr-fixes`: actual child, local candidate/checks, source rendering and private persistence.
- `test:team-workspace`: proposal/local application and real Git/check integration.

Older controlled request fixtures assumed every foreground request exposed the
global tool set. Integration updated them to request capability expansion where
needed. Hands-free now separately verifies that the actual hub startup queues are
empty; an omitted model-context queue is not evidence of an empty app queue.
Executive's new-job fixture now asserts Wonder/high and rejects Spark/minimal for
that new-job path. Legacy behavior remains covered by the pin/checkpoint tests.

The first PR-fix run failed its audit requiring two observed source frames. A
diagnostic-only failure capture was added. The rerun passed without changing the
production frame/receipt gate. That initial timing failure is non-reproduced and
is retained as a limitation rather than counted as a successful first run.

The foreground six-suite run preceded the additive coding-pin change; executive
was rerun and coding-provider, PR-fix and team-workspace ran afterward. Exact
report hashes, timestamps and available built-main identities are in
[the compact evidence](evidence/conversation-repair-native-2026-11-02.json).

## Installed app and remaining live checks

The installed v0.1.1 app, its fresh demo profile and the ready MET-77 job remain
untouched. No new app package was installed, no PR was posted/merged, and no live
provider or microphone was used by this acceptance run. A new installed build is
required to retest the user's actual conversation. Live recognition/classification
quality, warm/cold/long-idle speech latency and live Wonder coding are still
separate checks. No end-to-end speedup or signed-release acceptance is claimed.
