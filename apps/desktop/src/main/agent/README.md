# Agent lane integration

## V1 conversation

Import `ConversationService` from `./conversation` and `createConversationRouter` from
`./conversation-router`. Root constructs `new ConversationService(metaClient, { getContext })`
and registers only the V1 router for ordinary conversation. `getContext` is optional and
receives `(prId, signal)` only when the turn explicitly includes `prId`; it returns the
shared `ConversationPRContext` from selected real GitHub metadata and patches. No PR,
screen, fixture, tool, action or acknowledgement receipt is required for conversation.
Root owns credentials, speech input/output, router registration and shutdown wiring.

The API is `start(ConversationTurnInput)`, `poll(PollTurn)`, `cancel(CancelTurnInput)`,
`releaseSession(sessionId)` and `dispose()`. The router exposes start/poll/cancel/release.
Ordinary chat polling uses existing agent events and full text snapshots, with `actions: []`. Drain
terminal pages by event sequence. Retry an identical request ID without starting another
inference; changed input requires a fresh request ID, turn ID and higher generation.
The last 128 request IDs per session are deduplicated; old-generation admission remains
rejected after that window. Historical polls return stale once a newer turn starts.

Each of at most 100 sessions retains the last 12 completed user/assistant pairs within
64,000 characters. Replies are capped at 32,000 characters; polling retains 512 events.
Cancelled/failed partial replies never enter history. Selected PR context is refreshed
per requested turn, bounded to 96,000 serialized characters with omitted patches marked
truncated, and is not cached in conversation history. No PR selection is inferred from
previous turns. Release clears history and dedup state; dispose ends admission and aborts
all active work. Errors are sanitized and distinguish context, credential, quota,
network and timeout failures without echoing provider/server text.

The legacy screen-bound review engine below remains available for later integration;
the V1 conversation service neither invokes it nor exposes its tools or comment routes.

## Prepared guided review

`prepareReview(client, context, signal)` in `prepare-review.ts` returns a shared
`PreparedReview` using one deep structured `submit_prepared_review` call. Root schedules
and caches this work; conversation turns do not regenerate it. Main creates IDs/time and
pins the PR/repository/SHAs. The result must contain each supplied changed file once, in
model-explained behavior/dependency order, with inferred reasons, summaries and draft
comments. Comment locations are constructed only from actual supplied unified-patch
lines; unsupported locations are omitted. Missing/truncated source remains partial.
No provider failure or invalid output produces a substitute plan.

Optional `ConversationOptions.review` supplies `getReady(prId, signal)`,
`getProgress(prId, signal)`, `getScreen(sessionId, initial?)` (sync or async), and
`navigate(prId, {direction?, path?, line?, side?}, signal)`. Its types are exported from
`guided-review.ts`. A separate top-level `actionReceipts` option supplies `timeoutMs?`
(at most 10 seconds) and `updateScreen(receipt, navigation, signal)` (sync or async).
The navigation argument is the validated pending action, including its paused flag.
The callback must honor the signal before committing screen/progress; it aborts on
cancellation or receipt timeout. Agent awaits that commit before proceeding.

For an explicitly selected PR the tools are `inspect_ready_review({})`,
`open_review_file({path,line?,side?})`, `next_review_file({})`,
`previous_review_file({})`, `pause_review({})`, and `resume_review({})`.
Resume starts the first file when no saved progress exists. Each round uses the cached
plan, saved progress and actual `ReviewScreen`; unavailable preparation is reported as
unavailable, not fabricated as ready. The loop permits one tool per round and six rounds.
No selected PR keeps the original ordinary-chat path, with no tool/context port access.

Optional `review.getFile(prId, reviewId, path, signal): Promise<ReviewFile>` supplies the
actual displayed diff/source. Only the current ready file in review mode is fetched, once
per model round and again after acknowledged navigation. PR/current path, head path and
base/head SHAs must match the pinned plan; only runtime-verified renamed files may carry
a different base path. All paths must be repository-relative and safe. Mismatches stop inference. No port, no displayed
file or a failed read produces explicit unavailable source, never an inspected-source claim.
`currentFileSource` preserves patch and side status with whole-line prefixes, one-based
line ranges, total line counts and truncation flags. Patch ranges index patch text itself.
Missing/binary/too-large source remains unavailable; a line too large for the budget is
omitted completely. The full serialized model input is capped at 96,000 UTF-8 bytes,
including JSON escaping. Old conversation pairs and inferred plan text/order may be
trimmed with explicit flags to reserve source space. Each round has one latest context
packet; old file patches are neither replayed nor copied into inspection tool results.

Navigation emits shared `review-navigation` actions. The renderer acknowledges through
`conversation.actionApplied(ConversationActionReceipt)` after the real file settles.
Applied receipts must match the exact active identity/action, PR/review/path/SHAs, paused
flag and `mode: review`; pause keeps the file visible. Retired/foreign receipts cannot
update state. Ignored effects, screen changes, cancellation, timeout and persistence
failure stop dependent narration. Review tool-round prose is discarded; only the final
answer is emitted after acknowledgement. Existing voice no-filler behavior is unchanged.

This module supplies agent intelligence for MET-19–26. Integration owns main composition,
root tRPC registration, renderer/preload transport and dependency manifests. Runtime owns
repository/GitHub operations and execution; UI renders actions; voice invokes turns and
stops audio when cancelling. MET-27 remains Stretch.

## Main composition

Create one `MetaClient`, `CommentDrafts` and `AgentService`, then register
`createAgentRouter(service, drafts)` under `agent`. Await `service.dispose()` before
disposing runtime or closing its database. The client requires a main-only asynchronous
`getApiKey` and a synchronous `recordUsage` sink. Runtime's credential getter can supply
the Meta key; neither this module nor renderer RPCs expose it.

`AgentPorts` supplies validated preparation, current screen context, existing scenario,
diagram and preview lookups, code-location validation, and the comment draft store.
Artifact lookups must resolve the requested PR/revision. UI must send current screen
selection to main so `getScreenContext(sessionId)` reflects navigation, including while
a turn runs. The loop refreshes it before each model request and before emitting actions.
Runtime's source reader validates line bounds; it must compare repository and pinned SHA.

`AgentService` and the analysis helpers accept the structural `AgentModelClient` interface
(`stream(request, signal)`), implemented by `MetaClient`. Root acceptance may inject a
scripted provider explicitly. There is no silent provider or browser simulation fallback.

`ScreenContextStore` supplies that main-side cache. Register `createAgentScreenRouter(store)`
beside the agent router (for example, `agentScreen`) and implement the port as
`getScreenContext: (sessionId, initial) => store.get(sessionId, initial)`. UI sends
`update({sessionId, screenContext})` after navigation and applied tool effects, using its
monotonic sequence. Delayed updates cannot roll state backward. Release both the screen
store and the agent session together; clear the store during main shutdown.

## UI and voice turns

- `start` takes shared `AgentTurnInput` plus optional `workload: quick|deep`. It returns
  immediately and buffers an acknowledgement. Every new turn needs a fresh request/turn
  ID and a higher generation for the session. Retrying the current identical request is
  idempotent. Starting the next generation cancels pending work from the previous one.
- `poll` takes shared `PollTurn`, including `afterSequence` and `limit` (maximum 100).
  Advance the cursor using the last returned event's sequence. The response's `sequence`
  describes its full snapshot, not the page cursor. Drain events even when status is
  terminal. The bounded event history retains 512 events; full text/actions allow recovery.
- `cancel` takes shared `CancelTurnInput`. Call it on interruption/navigation; aborting
  the renderer's IPC request alone does not stop main work. Voice must immediately stop
  playback, invalidate its active generation, and ignore old events. Late adapter results
  cannot emit agent effects. Client disconnect cancels local transport; no provider-side
  background cancellation endpoint is used or promised for ordinary streaming requests.
- `release` removes a session; dispose ends admission and cancels all active turns.
- Apply actions only for the active session/turn/generation and current screen sequence.
  Action delivery is a rendering request, not evidence that UI displayed it.

Production composition enables ordered presentation with the third `AgentService` argument:
`{ actionReceipts: { timeoutMs: 10000, updateScreen(receipt) { /* canonical store.update */ } } }`.
The callback must synchronously commit the receipt's final screen snapshot. UI calls
`agent.actionApplied(AgentActionReceipt)` after fully applying or ignoring each effect,
using its exact action request ID and turn identity. Typed and voice actions use the same
receipt path. Ordinary screen updates and the receipt must agree on the final snapshot.
Receipts are optional only for headless consumers; without the option behavior is unchanged.

Main registers the waiter before exposing the action and waits before the next effect or
model request. Multi-effect calls rebase only to an acknowledged sequence, and reject
navigation newer than that acknowledgement. Foreign, duplicate, late and regressing
receipts return `stale` without updating the store. An ignored receipt stops remaining
effects/calls from that model response and lets the next round inspect fresh context.
Timeout (at most ten seconds) or screen-commit failure ends the turn with a workspace
acknowledgement error; it does not retry the browser mutation or blame credentials.
Cancellation, replacement, release and shutdown clear pending waiters immediately.

## Conversational browser review (MET-19 / MET-24)

Inject optional `AgentPorts.browser: AgentBrowserPort` with
`execute(command: BrowserCommand, signal): Promise<BrowserState>` and
`observe(sessionId, signal): Promise<BrowserState | null>`. Integration adapts runtime's
single persistent visible page; the agent creates no page, view or browser process.
No browser tools are offered without this port. Runtime owns preview URLs, same-origin
navigation, DOM interaction, viewport changes, native presentation and session disposal.

The tools are `browser_open`, `browser_observe`, `browser_navigate`, `browser_click`,
`browser_type`, `browser_scroll` and `browser_viewport`. Open takes `{revision, path?}`;
observe takes `{}`; the other tools take their shared command fields without `kind`,
`sessionId` or `requestId`. Agent supplies the session, pinned PR and a stable per-call
request ID. Element operations require an exact current browser ID, element ID and
observation sequence. Only scroll may target an offscreen element. Navigation stays on
the current preview origin. Runtime must recheck refs against the DOM before mutating.

Every model request and pre-dispatch screen refresh reads runtime's actual observation
into `ScreenContext.browser`, replacing the renderer cache and removing closed pages.
Every browser mutation is followed by another observation. Unchanged DOM reads must
preserve runtime's sequence. State must match the session, PR, repository and pinned
revision; non-open commands cannot switch browser identity. Opening base may replace
the page ID, and the next action must use the newly returned one. The same turn abort
signal reaches execute/observe; late results cannot produce events. Runtime must stop
in-flight work on abort and prevent late DOM mutations itself.

`show-browser` carries the observed page with the originating session/turn/generation.
UI presents that existing runtime page in its main surface, never another iframe or
browser. A concurrent screen-sequence change suppresses presentation while returning
the observed mutation outcome to the model. A browser observation is not scenario/build
execution evidence. Browser element source mappings must be grounded and validated
before highlighting; causal explanations from source alone remain inferences.

Guidance supports the seven-request flow: explain the PR from bounded `sourceContext`
excerpts, open head checkout, fill then apply a promo using refreshed refs, resize the
current page to phone (390×844), scroll to the observed payment button, highlight the
responsible code, then open base and reproduce inputs for an observed comparison.
Desktop is the default (1024×768). Showing payment does not submit payment. Runtime
observations govern all claims; failures are reported instead of inventing outcomes.

Optional `runScenario(prId, signal): Promise<ScenarioTrace>` enables `run_scenario({})`.
Root executes its trusted configured scenario and catalogs the returned trace. Agent
accepts only execution evidence at both pinned revisions, validates step locations and
requests `show-scenario`. Fixture traces remain available through `show_scenario`, but
cannot satisfy this execution port. No model-provided shell command is accepted.

## Drafts and posting

The model has a draft tool and no posting/confirmation tool. UI obtains/edits the draft,
then calls `confirmComment` with the exact shared confirmation payload. A changed body,
revision or head invalidates approval. Main checks current PR head before calling runtime.
Runtime's posting adapter must recheck the head and persist the idempotency key before
writing. Ambiguous failures stay unresolved and cannot blindly retry with another ID.
`originalWords` is taken from the actual turn, never from model tool arguments.

## Preparation and intent

`preparePullRequest` consumes runtime-read base/head contents and calls a trusted
`runBuilds` port when mechanical candidates exist. It only establishes exact content
equality or identical validated JSON tokens after removing formatting whitespace outside
strings. Numbers and duplicate members retain their original spelling. Verification requires successful
build evidence at both requested SHAs. The reason states what was checked and explicitly
does not claim behavior equivalence. Reading order is a deterministic path-role heuristic.

`prepareIntentHook` builds a redacted recorded-session payload from allowlisted fields.
The hook caller supplies known secret values; pattern checks additionally remove common
credentials and URL auth/query data. This is not an exhaustive secret detector. The
reviewed canonical payload can be sent through `publishIntentHook` and runtime's posting
port. `readRecordedTrail` validates it. Recorded Why notes require an author excerpt linked
to the exact location; the agent's own entries do not establish author intent. `explainIntent`
uses inspected code citations for uncovered locations and labels every result inferred.

## Scenarios

`proposeScenarios` sends trusted ticket/reviewer/agent briefs and runtime-inspected code
targets to the deep model. It cannot let model output invent provenance or targets.
`generateScenario` produces a deterministic `.mjs` test with trace calls, an assertion,
source digest and `execution: not-run`. A unique source anchor is resolved separately
on each revision. Arguments/expectations are JSON data, not generated executable expressions.

`requestScenarioExecution` checks the exact source and digest, then invokes runtime's
`runGeneratedTest`. It requires execution evidence for both pinned revisions before
returning results. Failing assertions are real failed executions, not generator failures.
`tests/fixtures/agent/scenario-c.ts` supplies the seeded expired-promo regression plan.

Optional `AgentPorts.scenarioAuthoring` enables the write/run tools. It supplies inspected
targets, storage for generated plans and traces, and runtime execution. Runtime composition
adds the trusted worktrees to each call. Generated plans, fixture traces and executed traces
remain distinct. Each model request includes screen context, including deep subrequests.

## Model availability and accounting

Official Meta documentation checked 2026-10-26 lists `muse-spark-1.3` and
`muse-wonder-1.0`, `POST https://api.meta.ai/v1/responses`, streamed text/tool output and
encrypted reasoning replay. The allowlist rejects Contributor variants and unknown names.
Account entitlement and live inference remain unverified without a configured credential.

- [Models](https://dev.meta.ai/docs/models)
- [Responses protocol](https://dev.meta.ai/docs/protocols/responses)
- [Tool calling](https://dev.meta.ai/docs/tool-calling)
- [Pricing](https://dev.meta.ai/docs/pricing-rate-limits)

Each HTTP attempt has a unique accounting ID, even when logical request IDs repeat.
`UsageLedger` aggregates reported usage per PR and accepts a runtime persistence sink.
Costs use dated list-price estimates, with cached-input rates. Missing terminal usage is
unknown, not zero. Its budget helper declines admission when previous costs are unknown;
integration must reserve/check budgets before scheduling work. Failed requests are not
automatically retried. No prompt/key/response content is written to the usage sink.

## Optional context analysis

`findCodeContext` uses TypeScript's compiler API with an in-memory host over runtime-read
source snapshots. It reports resolved call sites, caller counts, callees and a shared diagram.
It never reads repositories itself. Dynamic dispatch, uninspected files, external modules
and project aliases may remain unresolved. Integration supplies the pinned
`typescript@5.9.3` runtime dependency.

`assessRequestedScope` compares changes with supplied ticket/recorded-author sources.
Findings are inferences; conflict citations must be exact excerpts. “Untraced” means no
link was found among inspected sources, not proof that a change was never requested.

## Validation

Run `bun test apps/desktop/src/main/agent`, `bun run type-check`, `bun run lint`,
`bun run test:contracts` and `bun run build`. Simulated Meta transport tests verify protocol
and orchestration behavior; they do not establish live provider access. Root app wiring,
runtime-backed scenario/preview actions, voice interruption and confirmed GitHub posting
need integrated acceptance before tickets are Done.
