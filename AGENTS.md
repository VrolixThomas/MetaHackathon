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
