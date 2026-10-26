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

## Branches, integration and handoffs

- Start lane branches from the published MET-8 bootstrap on `hack/integration`.
- Preserve uncommitted work. Stage explicit paths; never sweep unrelated files into commits.
- Use one checkout per active worker. Bounded SuperiorSwarm workers get separate worktrees.
- Hand off small commits with ticket IDs, branch/SHAs, changed files, validation results and
  unresolved dependencies in Linear. Integration reviews and integrates them, then publishes
  any composition/dependency commits all lanes need. Do not merge another lane directly.
- Mark tickets Done only after their acceptance criteria work in the integrated app.
- Demo priority: open PR → Why notes → voice question → scenario C → phone preview →
  confirmed comment. Fixtures support development; they do not prove a feature executes.

## Validation

```sh
bun install --frozen-lockfile
bun run type-check
bun run lint
bun run test:contracts
bun run build
bun run --filter @metahackathon/desktop preview
```

Run behavior checks appropriate to the handoff; include actual results and limitations.
Use targeted formatting instead of formatting unrelated files. Runtime owns packaging checks.

## Shared interfaces (v1)

- Import Zod schemas and inferred types from `apps/desktop/src/shared/contracts/`.
  Parse inputs and outputs at process/service boundaries. Payloads are JSON; times are UTC
  ISO strings, paths are repository-relative, and code lines are inclusive and one-based.
- `CodeLocation` identifies repository, base/head side, full commit SHA, path and line range.
  Highlights, scenario steps, diagram nodes, preview markers and comments reuse it.
- `Evidence` distinguishes `fixture`, `source` and `execution`. Only execution carries a
  run ID, command, commit, timestamps, exit code and log URL. Never relabel fixtures as runs.
  Recorded Why notes require a cited intent source; inferred notes carry an explanation.
  Mechanical verification requires successful execution evidence on both PR revisions.
- `AgentTurnInput` always includes `ScreenContext`. `AgentAction` describes UI effects or
  scenario requests; lane modules export routers from their owned directories. Integration
  alone registers routers in `main/trpc/routers/index.ts` and wires main/preload lifecycle.
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
