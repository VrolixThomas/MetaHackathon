# Day renderer handoff — MET-68

Only new `renderer/day/**` files are authored by this lane. Canonical shared contracts come
from root `689f66a`, based on `1e32978`; the local consumed bootstrap is `7d71ce0`.

## Root bindings

- Create one `createDayController(createDayApi(conversation.api.call))`, call `start()` from
  the app lifecycle, then `dispose()` on retirement. Recreate both API and controller when
  the configured source actor/account changes; their snapshots and unconfirmed requests
  belong to that actor. Polling only observes local `day.snapshot`; main owns background work.
- Root registers `day.snapshot` query `{}` returning `DaySnapshot`, and `day.operate` mutation
  `DayOperateInput` returning `DayOperationResult`. Schemas are parsed at the renderer boundary.
  Responses bind the exact request/item identity. Unconfirmed identical operations reuse their
  request ID after acknowledgement loss, including manual capture. Main still owns durable
  source revision, exact-body/outbox deduplication and provider delivery receipts.
- Import `day/day.css` once in the renderer entry or owning root composition. It uses the existing
  colors, `quiet` controls and `command-item` sidebar patterns. No entry/stylesheet outside this
  directory was edited.
- Mount `DayQueue({ controller, selectedId, onOpenItem })` inside the existing contextual sidebar.
  `selectedId` is the acknowledged visible work item. `onOpenItem(id)` must open that actual
  item through root's workspace command path. Category browsing remains a sidebar-only command;
  this component has no category navigation or secondary main-pane queue.
- Mount `DayWorkItem({ controller, itemId, command })` in the selected day canvas. `command` uses
  the existing acknowledged workspace controller. Real job links use
  `{ kind: "open-center", section: "activity", selectedId: jobId }`; source and resolved Linear
  URLs use `open-browser`. No local diff, worker result, check receipt or review readiness is made up.
- Optional `onCoverItem(id)` lets root enter its existing foreground voice conversation after a
  user cover action is durably acknowledged and still current. It must use the actual current
  session/generation; root retains microphone, speech cancellation and transcript controls.
  Q&A content appears only when `snapshot.currentItemId` matches this item. Typed answers/capture
  are closed disclosures. Rendering, polling and selecting an item never ask another person anything.
- Optional `linear: { id, identifier, url }` supplies a resolved real issue. It is shown only if its
  ID matches `item.linearIssueId`; otherwise the saved issue ID is shown without an invented URL.

## Source context and existing worker review

The source link, visibility, original workspace/conversation/thread/message/revision identity
are available from `ChatCitation`. Private channels/DMs and team public channels have distinct
labels. Main must freshly revalidate membership and source revision before reading any source text.
To render exact thread messages, supply optional
`thread: { itemId, expectedRevision, loading, error, messages: ChatMessage[] | null }` plus
`onLoadThread(itemId, expectedRevision)`. The user explicitly requests a source load. Main may
implement that via the Slack adapter; this lane adds no unapproved provider/router surface.
The UI hides stale item/revision payloads and rejects a whole batch containing another thread.
Deleted messages expose no text; truncation and exact message revision remain visible.

Existing worker start/control and pinned diff/check/approval views remain main/work + the
established job view. Root must connect a genuine job ID and any `mark_reviewed` transition to
the reviewed actual head; this compact detail does not synthesize those results. A saved draft
stays a draft. The explicit send button binds item revision, draft revision and exact saved body;
only main's verified original-thread answer receipt establishes closure. No manual Close action
or Linear completion is inferred here.

## Lane verification

`bun install --frozen-lockfile --ignore-scripts` supplies dependencies without changing tracked
manifests. Unit/SSR checks run with `bun test apps/desktop/src/renderer/day
apps/desktop/src/shared/day.test.ts`; renderer/shared type-check uses
`bunx --no-install tsc --noEmit -p apps/desktop/tsconfig.renderer.json`; scoped formatting/lint uses
`bunx --no-install biome check apps/desktop/src/renderer/day`.

No Electron, browser, microphone, live provider, build/packaging or combined acceptance launch
was made in this lane. Root owns integration bindings and native acceptance. MET-68 stays open
until those integrated acceptance criteria pass.
