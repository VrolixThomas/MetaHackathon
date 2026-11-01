# MetaHackathon integration rules

Source of truth: Linear team **MetaHackathon**, project **Voice-first PR review**;
original plan and design attachments on MET-9; repository README and committed Electron foundation.

## Ownership and tickets

| Peer branch | Exclusive write scope | Tickets |
| --- | --- | --- |
| `hack/integration` | `src/shared/`, preload, main composition, root router registration, all shared dependency manifests/lockfile, coordination docs | MET-5 / S-1, MET-6 / S-2, MET-8 / S-4, MET-45 / E-3 |
| `hack/ui` | `apps/desktop/src/renderer/` except `voice/` | MET-9–18 / A-1–10 |
| `hack/agent` | `apps/desktop/src/main/agent/` | MET-19–27 / B-1–9 |
| `hack/voice` | `main/voice/`, `renderer/voice/`, `services/voice/`, `apps/site/`, `docs/launch/` | MET-28–35 / C-1–8, MET-43–44 / E-1–2 |
| `hack/runtime` | `main/runtime/`, `main/db/`, `fixtures/demo/`, packaging and CI | MET-36–42 / D-1–7; delegated MET-7 / S-3 |

Desktop-relative paths above are under `apps/desktop/src/`. These are peer SuperiorSwarm
groups, not integration child workspaces. Each human claims their own credits on MET-5.
Agree boundary changes explicitly in Linear before editing another lane. Send dependency
requests (package, pinned version, purpose) to integration; do not edit manifests or lockfile.
The user authorized cross-lane integration on 2026-10-27. Integration resolves routine
reservations with peers on MET-8; keep one active writer per file and worktree. The integration
checkout alone launches and assesses the combined app; lanes feed reviewed implementations.

## Branches, integration and handoffs

- Start lane branches from the published MET-8 bootstrap on `hack/integration`.
- Preserve uncommitted work. Stage explicit paths; never sweep unrelated files into commits.
- Use one checkout per active worker. Bounded SuperiorSwarm workers get separate worktrees.
- Dispatch SuperiorSwarm workers explicitly with `cli_preset: "codex"`. The user requires
  Codex only; never rely on a service/provider default. Keep one active writer per checkout.
- Hand off small commits with ticket IDs, branch/SHAs, changed files, validation results and
  unresolved dependencies in Linear. Integration reviews and integrates them, then publishes
  any composition/dependency commits all lanes need. Do not merge another lane directly.
- Mark tickets Done only after their acceptance criteria work in the integrated app.
- Demo priority: open PR → Why notes → voice question → scenario C → phone preview →
  confirmed comment. Fixtures support development; they do not prove a feature executes.
- Current product direction: voice guides a compact conversation beside a large main workspace
  that switches browser/code/scenario/diagram. Desktop browser is default, phone on request.
  The persistent visible browser is the same webContents observed and operated by the agent.
  This supersedes previews hosted primarily inside the conversation panel (MET-12/MET-14).

## Validation

V1 reset (user direction, 2026-10-27): startup is a real conversation with no PR prerequisite
or demo content. Voice input/output is the acceptance priority; real GitHub context is optional.
Use repository `.env` in development and a user-provided `.env` for distribution. Rich review
artifacts remain legacy modules until needed; fixtures are test-only. Coordinate this reset on MET-8.

```sh
bun install --frozen-lockfile
bun run type-check
bun run lint
bun run test:contracts
bun run test:integration
bun run test:pr-work
bun run test:pr-fixes
bun run build
bun run --filter @metahackathon/desktop preview
```

Run behavior checks appropriate to the handoff; include actual results and limitations.
Use targeted formatting instead of formatting unrelated files. Runtime owns packaging checks.
`test:integration` launches the built Electron V1 app with isolated user data and `.env`, verifies
empty startup, a real renderer conversation without a PR, history and cancellation over IPC.
Its model transport is simulated; it neither records a microphone nor uses live provider keys.

## Current real-review increment

User direction adds real repository connection and local SQLite preparation, with a review-first
workspace inspired by Macro. Voice stays available everywhere; transcript and typing are hidden
until requested. A resizable right native browser pane opens an explicitly supplied local URL.
No demo content enters startup. Team hosting, webhooks and Supabase remain future deployment work.

`bun run test:prepared-reviews` validates pinned local source, durable prepared plans and guided
file actions in native Electron with controlled GitHub/model responses. `bun run test:local-browser`
validates an actual locally served page and native lifecycle. Integration alone launches these.

## Conversation polish (2026-10-28)

- One explicit Start/End controls the hands-free microphone session. Each detected utterance still
  has its own cancellable turn/generation. Speech onset buffers locally while media connects;
  release waits for buffered PCM to drain. No filler acknowledgement speech.
- Manual source/PR changes interrupt the current reply and retain the listening session. Opening
  workspace menus/settings does not end voice. A handled dialog Escape never cancels voice;
  unhandled app Escape and native guest Escape end the session.
- Native browser hiding must bypass renderer and main page-operation queues. Older show/resize
  completions cannot cover an open modal. Keep the page state when hidden.
- Show a compact explanation of what changes and why this file comes next; full cached overview,
  reading order and evidence stay available in bounded disclosures. Preserve exact source text,
  syntax, identity and action receipts. Generated explanation provenance remains inference.

## Shared interfaces (v1)

- `WorkspaceSnapshot` is the acknowledged canvas/layout/review state. `WorkspaceCommand` is shared
  by manual and agent actions. Main `WorkspaceCoordinator` publishes `workspace-canvas` effects;
  renderer acknowledges only after source, two committed frames, and native presentation settle.
  Only the durable accepted snapshot may be narrated as displayed. Each tool operation has its own
  request ID. A cancelled generation cannot publish later effects.
- Code, one persistent native browser, inferred Markdown documents and typed SVG visual drafts share
  primary/secondary panes and tabs. Generated drafts persist privately under user-data
  `workspace/canvases.json`; Recent restores closed drafts. New drafts omit ID; updates use observed IDs.
  Visual scenes are rectangle/text/line mocks, not image-provider raster output or screenshots.
- Browser observations include actual DOM text, document/element identity, values, viewport, scroll and
  presentation; tools operate that same page and return refreshed observations. Explicit HTTPS and
  local HTTP are supported; privileged URLs and remote plaintext HTTP remain blocked.
- `LocalBrowserState.viewportMode` is additive optional metadata: desktop fits the presented pane;
  phone/custom viewports remain fixed and centered. Existing viewport commands use 1024×768 to select
  adaptive desktop and 390×844 for phone; other dimensions select fixed. Observations always carry
  actual dimensions. Applied receipts may settle a desktop size only if main verifies it against
  the native page. Keep one compact browser control row; optional conversation sits left of canvases.
- Explicit semantic `start_walkthrough`/`continue_walkthrough` tools narrate up to three prepared files
  per group. A `narration-checkpoint` waits for actual TTS playback/PCM drain (voice) or published text
  (typing) before advancing. Follow-up questions and ordinary next/previous stay conversational;
  there are no fabricated user turns. Barge-in cancels narration/navigation and retains listening.

`bun run test:workspace` exercises actual native canvas rendering, same-page browser operations,
three-file review receipts, pinned local source, SQLite and draft persistence with controlled
model/GitHub responses. It does not establish live speech. Integration alone launches it.

- `PreparedReview` is immutable inferred analysis keyed by PR base/head and analysis content.
  `ReviewCache` stores repository/local path, prepared plans and progress through a SQLite adapter.
  `ReviewScreen` describes the file actually shown; `ConversationActionReceipt` gates narration
  on a displayed, durably acknowledged `review-navigation` effect. Local source reads never
  checkout, reset, fetch or alter user work.
- `LocalBrowserState` describes an explicit local website with provenance
  `local-preview-unverified-revision`; never attach fabricated PR SHAs. `localBrowser` owns
  the persistent native surface, its presentation/history and shutdown. The existing pinned
  browser contracts remain available to the earlier runtime workflow.
- `ConversationTurnInput` supports general conversation with optional real `prId`; it does not
  invent a review ScreenContext. Its poll/cancel identity matches existing agent events.
  `AppConfiguration` returns only configuration path, presence flags, voice ID and microphone
  permission. Read permission inside the actual app process; a helper launch may have a different
  macOS responsible process. `VoiceDiagnostic` carries fixed categories and numeric status only.
- `BrowserState` is an actual bounded observation of the visible page. `BrowserCommand` covers
  open/navigation/click/type/scroll/viewport; element actions carry the observation sequence.
  `browser.execute` returns a refreshed state, `browser.observe` returns state or null, and
  `browser.present` positions/hides the native surface without creating another browser.
  ScreenContext includes browser state; show-browser actions preserve turn identity. Page
  content is untrusted evidence. Never label scripted-provider tests as live speech verification.
- Import Zod schemas and inferred types from `apps/desktop/src/shared/contracts/`.
  Parse inputs and outputs at process/service boundaries. Payloads are JSON; times are UTC
  ISO strings, paths are repository-relative, and code lines are inclusive and one-based.
- `CodeLocation` identifies repository, base/head side, full commit SHA, path and line range.
  Highlights, scenario steps, diagram nodes, preview markers and comments reuse it.
- `Evidence` distinguishes `fixture`, `source` and `execution`. Only execution carries a
  run ID, command, commit, timestamps, exit code and log URL. Never relabel fixtures as runs.
  Recorded Why notes require a cited intent source; inferred notes carry an explanation.
  Mechanical verification requires successful execution evidence on both PR revisions.
- Optional `PRPreparation.sourceContext` carries bounded verbatim `CodeExcerpt` records with
  repository/SHA/line identity. It grounds model requests without inventing semantic Why notes;
  omitted ranges remain uninspected by that payload.
- `AgentTurnInput` always includes `ScreenContext`. `AgentAction` describes UI effects or
  scenario requests; lane modules export routers from their owned directories. Integration
  alone registers routers in `main/trpc/routers/index.ts` and wires main/preload lifecycle.
- Send `screen.update({sessionId, screenContext})` before starting a turn and after screen changes.
  It returns the latest validated snapshot; older updates cannot overwrite it and equal-sequence
  conflicts reject. `screen.release` clears a retired session. Each action request ID identifies
  one effect; session/turn/generation fields correlate effects with the originating turn.
- The app requires `agent.actionApplied(AgentActionReceipt)` after an effect settles. The receipt
  supplies the exact action identity, applied/ignored status and final screen snapshot. Agent
  tools wait for this bounded, cancellable acknowledgement before continuing; stale receipts
  cannot advance another turn. Both typed and voice paths acknowledge ignored current effects.
- Use the existing `window.electron.trpc.request` transport; bootstrap exposes
  `bootstrap.contract` and `bootstrap.fixture`. IPC supports query/mutation, not subscriptions.
  Request event/stream or lifecycle wiring through integration before implementing it.
- `AgentEvent`, `PollTurn` and `PollTurnResult` define bounded polling (maximum 100 events).
  Result `sequence` is the latest snapshot; page forward using the last returned event sequence.
  `GeneratedScenario` preserves the pinned PR, origin, source and digest with `execution: "not-run"`.
  Agent verifies source/digest before runtime executes it; router registration remains integration work.
- Agent turns/actions, voice state and cancellation carry session ID, turn ID and generation. On interruption,
  stop audio, abort work and reject late events from the cancelled generation. Transport abort
  alone does not cancel main-process work; voice/agent must implement the cancellation RPC.
- `DraftedComment` never posts. `ConfirmCommentInput` requires explicit confirmation bound
  to draft ID, revision, exact body and head SHA. Main must compare against the current draft
  and PR head, reject stale confirmations, and deduplicate request IDs before GitHub writes.
- `shared/fixtures/review.ts` returns fresh, validated deterministic demo data. The fixture-only
  router launches no runtime, voice pipeline, preview server or GitHub write. Fixture commit
  hashes, line positions, source URLs and preview geometry are illustrative until MET-7 lands.

Propose contract changes on MET-8; integration publishes the resulting commit and migration
notes. Keep lanes on the same contract version.

## Executive center increment (2026-10-29)

MET-46 covers independent app-owned Muse workers, MET-47 the sidebar/home/job review, MET-48 real
GitHub/Linear providers and SQLite, and MET-49 foreground tools and source-flow guidance. Integration
owns `main/work/`, final renderer bindings and composition. Provider/Git helpers remain runtime
modules; foreground/coding tools remain agent modules. Temporary exclusive reservations and review
handoffs live on MET-8. Use Codex-only SuperiorSwarm dispatch during development; SuperiorSwarm is
not an installed-app dependency.

Home derives priorities from actual sources, with incoming requested reviews separate from own-PR
feedback. Linear uses the configured personal key and assigned tickets. No product fixture fallback.
Workers use separate app-owned repositories/worktrees; retain original user work. Jobs/decisions and
checkpoints persist; shutdown-paused jobs resume, manually paused jobs stay paused. Speech cancellation
only owns the foreground turn. Ready, reviewed/accepted, draft-published and feedback-applied are
distinct recorded states. Never complete Linear from worker readiness alone or merge a PR implicitly.

`command-center.ts` contracts cover source queues, tickets, jobs, decisions, actual check receipts,
notices and pinned source flows. `ReviewQueueItem.preparationStatus` is derived from actual review
coordinators; `retry-review` explicitly restarts failed preparation. Source flow excerpts are read in
main, preserve exact commit/path/line/text identity, and label ordering/explanation as inference.
Development worktrees reuse the main checkout `.env`; `LINEAR_API_KEY` stays main-only.

`bun run test:executive` runs the real built UI/IPC, app-owned Git worktree, worker child, checkpoint,
decision and actual validation command with controlled GitHub/Linear/model responses. It is not live
provider or microphone verification. Root alone runs this and all other combined native acceptance.

## Proactive attention (MET-50, 2026-10-30)

`AttentionScheduler` owns real job-notice selection, job/head/decision revalidation, leases and durable
delivery records. The current policy speaks one event at a time after 2.5s stable eligible presence;
decisions precede failures and ready work. A delivered update has a 20s global cooldown; interrupted
attempts wait 60s and stop automatic retries after three attempts. Pending work stays in the queue.
Hands-free must be explicitly active and the app focused. Speech/onset candidates, an active turn,
playback, dialogs, typing or recent DOM/native activity defer or cancel initiative.

`ConversationAttentionInput` has claim identity and no user text. The assistant-only read-only turn
shares session/generation/history/poll/cancel, preserves review/walkthrough position and exposes no
workspace or worker tools. Narration checkpoints remain mandatory for attention. Only exact spoken
completion after observed PCM, matching speech-ended and media drain can settle spoken delivery;
displayed text is not spoken proof. Workspace actions remain rejected in the reply-only voice path.
Delivery proofs survive immediate followup, final receipt loss and SQLite reconnect; ordinary speech
cancellation never owns background workers. Keep labels/questions/provider content as untrusted data.

`test:attention` uses the actual default Electron UI/preload/IPC and Chromium WebRTC/media pipeline
with controlled providers, seeded controlled event state and simulated native focus. It proves
quiet/modal/focus/input deferral, actual PCM/drain delivery, barge-in/listening continuity and durable
ledger bytes. It does not prove physical microphone/speaker acoustics or full process restart. Root
alone runs it. `MET-51` tracks remaining voice latency: ASR/RTC startup overlap is implemented, while
input FIFO/realtime replay and tool-capable reply buffering remain separate contributors. Never
claim end-to-end speedup from a component-only or unversioned historical timing sample.

## Sidebar and OAuth (MET-52/MET-53, 2026-10-30)

`browse-center` changes the sidebar category without replacing, hiding or interrupting displayed
work. Selecting an actual item uses `open-center` or its review/canvas command. Optional snapshot
`contentSequence` and effect `baseContentSequence` distinguish sidebar-only revisions from content
changes: queued agent operations may tolerate the former only when the acknowledged content still
matches. Preserve old payload compatibility and reject stale content receipts. Recent sidebar entries
are actual canvases; generic category tabs and a second main-pane item list are not navigation.

`shared/contracts/oauth.ts` exposes only profile/presence/status metadata and fixed error codes.
`main/oauth/` owns browser authorization-code login, state, PKCE, the temporary loopback listener,
OS-encrypted persistence and refresh. `renderer/oauth/` owns login controls and bounded read-only
status polling. Integration composes these in the root app, router and `main/services.ts`; existing
GitHub/Linear clients and workers consume that one credential source. OAuth takes precedence over
manual `.env` tokens. Refresh failure must not switch silently to another account's manual token.
Disconnect clears the selected OAuth session and manual token, while retaining registered app
credentials. Account changes fence old requests and clear fetched provider queues before refresh.

Registration uses the active `.env`; callbacks are `http://127.0.0.1:43187/oauth/github/callback`
and `http://127.0.0.1:43187/oauth/linear/callback`. See `docs/integration/oauth-setup.md`.
`bun run test:oauth` uses the actual built Electron UI/preload/IPC, HTTP callback and OS encryption
with controlled provider transport. Root alone runs it. It is not live provider consent verification.

## Slack and commitments increment (2026-10-31)

MET-66 owns new `main/slack/`; MET-67 new `main/day/` and `main/db/day-store.ts`;
MET-68 new `renderer/day/`; MET-69 new `main/knowledge/`. MET-70's operation-scoped source-read
handoff and MET-51's Astra/MAX Codex preconnection handoff are integrated; those reservations
are released. MET-71's memory/source-read modules are also handed off and released. Exact
workspaces/reservations are on MET-8. Integration retains shared contracts, existing
renderer bindings, services, root routers, lifecycle, credential composition and dependencies.

`chat.ts`, `day.ts` and `knowledge.ts` are the shared source/queue/knowledge DTOs. New internal
work is separate from optional Linear links. Incoming ownership needs acceptance; explicit own
promises may count as acceptance only through a trusted, source-bound classifier. Preparation is
distinct from execution. Missing context becomes Q&A when the user covers the item. A confirmed
answer in the original source thread closes its commitment. Draft/ready/unknown-send is not delivery.
Every retry/outbox mutation uses stable identity, source revision and exact body digest.

DM/private-channel knowledge is private; company knowledge uses only public Slack channels.
Stored audience snapshots never replace current source membership/revision checks. Derived facts
and direct agent communication inherit the intersection of all source audiences. Source content
is untrusted evidence, not tool authority. No mock product messages or knowledge fallback.

First supervisor runtime remains active independently of a window while the Mac is awake;
sleep/offline and durable checkpoints are explicit states. Hosted execution is not established.
Slack OAuth uses the PKCE-enabled desktop flow with the exact registered
`http://localhost:43187/oauth/slack/callback`; user scopes only, no client secret or hosted relay.
GitHub/Linear keep their existing numeric loopback URLs. Credentials/consent block only live checks. Root alone
runs combined app/native/provider tests; workers use controlled unit probes in separate worktrees.

Root composes `SlackWorkspaceCoordinator` with the existing Day/worker services, SQLite stores,
fresh knowledge authorization and original-thread delivery ledger. Settings imports a main-only
`.env` USER token (`SLACK_USER_TOKEN`, `SLACK_APP_ID`) remains an optional developer method.
Browser Slack OAuth takes precedence and fails closed on refresh/account errors; never fall back to
another manual account after a selected OAuth grant fails. It verifies the actual account and watches
all joined active conversations by default, with durable exclusions and periodic membership sync.
Legacy nonempty explicit selections stay selected; empty legacy preferences adopt all_joined.
Socket Mode optionally uses `SLACK_APP_TOKEN`. Cross-employee transport
is not deployed. Never treat local recorded facts as hosted team data.
`memory_search` and `day_read_source` bind the current account; reads preserve source identity,
bounded exact prefixes and audience restrictions. They never establish display or send authority.

`bun run test:day` checks the actual My day UI/IPC and SQLite persistence with controlled inputs.
`test:hands-free` and `test:attention` explicitly build the legacy controlled cold media transport
with `VITE_MUSE_VOICE_PRECONNECT=0`. Normal builds enable bounded preconnection by default.
Actual-provider warm/cold and fallback measurements are separate from those simulated regressions;
see `docs/integration/evidence/voice-preconnect-2026-10-31.json`. Root alone runs native checks.

Slack reader increment: shared message pages retain actor/conversation/thread/source identity and
observed author labels. `center/slack` selections encode channel[/thread] through shared helpers;
main requires current joined membership and the renderer must load the exact target, then commit
two visible frames with `data-slack-target` before a positive workspace receipt. Foreground
slack_list_conversations/slack_read_messages return bounded untrusted data and command proposals,
never display proof or send authority. The read-only sidebar/view has no product fixtures or send
composer. Reader metadata is independent of background watcher startup; cached labels are not ACLs.
Only explicit owner `SLACK_INTERNAL_APP=1` enables internal-app pacing; commercial default remains
conservative and HTTP429 Retry-After always applies.

## Prepared PR comments and local fix review (2026-10-31)

MET-8 coordinates the prepared-comment/j-k/candidate-review increment. Shared `pr-work.ts`
contains PR comment inputs, private-owner candidate summaries/details and exact file target helpers.
Main `PreparedComments` uses the current ready `ReviewCoordinator`, complete RIGHT-side diff lines,
exact words/revision/body/head confirmation, cancellation tombstones and the existing durable GitHub
ledger. Account changes retire drafts and foreground history. One persistent renderer comment control
keeps ambiguous attempt identity across closing; it remains absent before a real review exists.

`main/work/pr-fixes/` composes the existing app-owned coding entry and isolated Git runtime. Admission
is durable before execution. Each source revision, owner and attempt has a private binding; unknown
executions are retained as interrupted and never automatically replayed. Speech cancellation does not
own background work. The separate Suggested fixes queue shows original feedback, inferred explanation,
actual diff/Before/Proposed after, changed files and actual checks. Mark fix reviewed records only the
inspected candidate head privately; it does not publish, merge or grant PR-author approval.

Manual and agent file selections use `encodePRFixViewTarget` and the shared workspace path. Canvas
`fixSource` pins id/base/head/path. Main validates recorded candidate metadata; renderer loads actual
fresh authorized detail, commits two matching visible frames, then main rechecks that metadata before
acceptance. A separate status marker proves only preparing/unavailable metadata, never source display.
Candidate source line actions resolve immutable app-owned runtime sources, preserving exact bytes and
inclusive line identity. Local source listing/read tools alone establish neither display nor send authority.

`test:pr-work` runs actual built Electron/IPC/Git/native-browser and controlled GitHub/model transport:
manual file navigation, typing exclusion, exact draft/edit/consent, durable posting dedup, cancellation and
stale head rejection. `test:pr-fixes` runs the actual app-owned coding child and validation command,
provider-only controlled model/GitHub responses, candidate sources/checks, two-frame receipts and
private-store reopen. They do not establish live speech, live GitHub posting or a full app restart.
Root alone launches them. Native keyboard tests whitelist their injected keys and hold focus briefly.

## Subscription coding provider (2026-10-31)

MET-8 owns `coding-provider.ts` settings/status contracts, root Settings/router/lifecycle composition
and the pinned Muse Code SDK dependency. `CODING_PROVIDER` selects new app-owned coding jobs only;
foreground voice/model configuration stays separate. Each job durably pins provider/path before work.
Old Meta checkpoints remain Meta; provider failure never silently selects API billing or a new session.
The CLI owns subscription sign-in credentials; `.env` stores selection/path, never copied account tokens.
`main/work/muse-code/` requires observed account/subscription allowance, supported protocol, isolated
app-owned worktree and restricted vendor permissions. Retain uncertain effects and actual pending
questions/approvals. Only independent runtime checks establish validation, not an SDK completion summary.
Shared organization preparation/proposal storage is proposed in `docs/integration/team-backend-plan.md`;
it is not deployed. Native subscription checks must distinguish controlled transports from real coding.
`bun run test:coding-provider` covers actual Settings/IPC/worker pins and real local Git/checks with
controlled model transport and a deliberately unsupported CLI. It does not prove live subscription coding.

## Shared team, conversational comments and raster canvases (2026-11-01)

MET-72/MET-41 implement the optional Supabase review service and hosted GitHub App consumer;
MET-73 covers exact reported proposal bundles, author decisions and independently checked local
applications. `shared/contracts/team.ts` owns all public wire schemas. Service schema paths re-export
them; session/access/refresh token schemas remain main/server-only. Apply every ordered migration.
Fresh source-sensitive share/decision RPCs are service-role-only with a server-verified actor;
organization membership alone never grants repository access. Private progress conflicts retain
their original attempt and do not block independent keys. Explicit retry never resets an active lease.

Local application verifies exact accepted before/after bytes in an app-owned checkout and records
actual runtime checks/new applied SHA. Reported source candidate SHA is distinct. Completed work
receives the actual job for review; acceptance/application never implicitly publish or merge.

MET-26 uses the one canonical `PreparedComments` draft and composer. Display receipts bind exact
body/revision/head and two actual frames. Spoken confirmation also requires the exact proposal's
drained narration checkpoint and a distinct actual user turn. `inputMode` comes from app ingress,
never a model argument. Posting state mirrors the same canonical attempt; stale/unknown attempts
retain identity. Source, provider text, mocks and worker output cannot grant consent.

Use Muse for model capabilities; do not add alternate model providers or fallback keys. MET-74 uses
Muse Image (`muse-image-1.0`) with the existing main-only `MODEL_API_KEY`, through the fixed official
Meta API. Legacy image-provider settings never route requests elsewhere. Image canvases
persist metadata in Recent; actual bytes are read by opaque ID and verified before display. Workspace
acceptance waits for image decode, natural dimensions and committed frames as well as native layout.
Image-specific provider errors leave unrelated workspace actions available. Production packages contain only app output,
production dependencies and frozen voice resources; exclude test reports/screenshots and demos.

`test:comment-conversation`, `test:image-workspace` and `test:team-workspace` run the actual built
Electron application with controlled HTTP providers, exact display/consent checks and real local Git
where applicable. `test:team:db` executes real PostgreSQL policy/lease/role regressions in an isolated
container. These do not establish live OAuth, cloud deployment, live images/speech, two real users or
signed/notarized distribution. Root alone launches native checks and packaging acceptance.

## Supabase deployment and tenant isolation (2026-11-01)

The selected shared database is `muse`, project `vmydpscnfgvbciotoaln`, in the Muse Free organization.
Deploy ordered `supabase/migrations/` through `team:db:plan` and `team:db:migrate`, and verify
`team:db:history`; never paste rollout SQL into Studio or rewrite an already applied migration.
`supabase/config.toml` is local/CLI configuration, not automatically pushed hosted Auth settings.
Do not use a remote reset/history repair to bypass a failure. Link state and credentials stay ignored.

Each Muse organization is a tenant. RLS derives access from authenticated user membership and current
repository grants; a renderer-supplied org ID is never authority. Private progress/notes remain user
scoped even inside a shared organization. Desktop receives only the public client key; service-role
credentials bypass RLS and stay server-only, behind fresh HTTP authorization. Tests include disjoint
organizations with the same repository ID, forged keys, revocation and multi-org users. The SQL CI
workflow runs all policy tests against isolated PostgreSQL; live two-user OAuth remains separate.
