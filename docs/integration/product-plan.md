# Muse implementation plan

The current increment is a local, voice-led PR review. It uses the existing Electron/tRPC
application. There is no separate FastAPI service.

## Implemented slice

1. Connect GitHub using the existing `gh` login or an explicitly configured token. Choose a
   local clone, verify its GitHub origin, and fetch its real open PRs.
2. Poll the connected repository while the app is running. Prepare a sensible file order,
   explanations and suggested comments from the actual PR description and available patches.
   Validate model output and bind it to the exact PR base/head. Keep incomplete coverage visible.
3. Store the connection, prepared review and navigation progress in SQLite. Publish ready
   results only after durable storage succeeds. Reuse unchanged revisions and invalidate moved
   heads. Leave the accepted connection intact when a replacement cannot be saved.
4. Show pinned Changes/Before/After source and guide the review with open, next, previous,
   pause and resume tools. Read local Git objects when available without changing user work.
   Ground answers in the displayed source and wait for the renderer acknowledgement before
   claiming navigation completed.
5. Keep voice available without a PR. Use a quiet review-first workspace, optional transcript
   and typing, and a resizable native browser pane for an explicitly supplied local website.
   Desktop is default; phone is available through the browser controls.

SQLite lives behind an asynchronous `load`/`save` cache port. The schema separates connection,
prepared plans and progress. A later Supabase implementation still needs authenticated tenant
ownership, conflict handling and a migration; changing the adapter alone does not create a team
service.

## Following increments

- Validate the real review flow against the user's forthcoming test repository, including
  model explanations and human-spoken requests. Existing controlled acceptance cases are tests,
  not product demo content.
- Connect the current real conversation to browser observation/actions. The manually opened
  local page currently makes no claim about which PR revision is running. Restore revision-aware
  before/after execution only with actual runtime evidence.
- Add explicit draft editing and confirmed GitHub review submission to this real review flow.
  Suggestions never post automatically. Existing confirmation guards must remain mandatory.
- Add team installation through a GitHub App, webhook-driven preparation and a hosted worker
  so preparation continues with the desktop closed; move shared data to Supabase with tenant
  isolation and keep individual review progress scoped to each reviewer.
- Add the daily GitHub/Linear briefing and separately authorized background ticket execution.
  Background code changes need isolated worktrees and reviewable handoffs.

## Coordination

MET-8 is the integration record. UI owns presentation, agent owns preparation/tool selection,
runtime owns GitHub/local Git/SQLite/native execution, voice owns speech, and integration owns
contracts, lifecycle, router registration and final acceptance. Separate SuperiorSwarm worktrees
feed small commits into `hack/integration`; only integration launches the combined app.

The visual reference is Macro's public design guidance and the user's Codex split-view example.
Components and styles are implemented locally without importing Macro code or assets.
