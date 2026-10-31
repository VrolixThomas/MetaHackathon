# PR comment composer integration

These exports target the current `PreparedController` / `ReviewCoordinator` flow.
They do not mount the legacy fixture review or depend on its preparation catalog.
No new dependencies or existing main-module changes are required by this handoff.

## Renderer binding (integration-owned)

Mount **one persistent** control in the default app's review/header controls:

```tsx
<PRCommentControl
  call={runtime.api.call}
  reviews={runtime.reviews}
  beforeOpen={hideNativePage}
  onOpenError={overlayFailed}
/>
```

Import from `renderer/pr-comments`. Pass the existing stable modal/native-browser
hide callback and keep native presentation suppressed for the open dialog just as
for other workspace dialogs. `WorkspaceDialog` contains Escape and restores focus.
Do not mount separately per canvas or unmount on file navigation: the controller
retains the exact request identity and ambiguous outcome across dialog closes.
On provider-account change, dispose/remount this control together with clearing
the prepared-review source state; a PR ID alone cannot identify an account change.

For composition with an existing controller, inject a `PRCommentApi` into
`createPRCommentController(api, readContext)` and render `PRCommentButton` plus
`PRCommentComposer`. Subscribe `reviews.store` to `controller.refreshContext` and
dispose at lifecycle/account teardown. `readContext` should return
`preparedCommentContext(reviews.store.getState())`; every meaningful operation
rechecks that source synchronously as well.

The UI creates a draft on **Review comment**, displays the exact returned body,
and requires an unchecked explicit confirmation plus **Post comment to GitHub**.
Edits require another review and invalidate confirmation. General comments omit
`location`; inline comments use exactly one RIGHT-side diff line. An existing
head-side range highlight defaults to its last line and the UI labels that single
line explicitly. The current runtime adapter does not post multiline anchors.

## Required main routes (integration-owned, not included here)

`createPRCommentApi(call)` uses these proposed routes; a typed injected adapter can
use other route names without changing the controller/UI:

| Path | Input | Output |
| --- | --- | --- |
| `prComments.create` | `{ requestId, prId, reviewId, headSha, body, location? }` | `DraftedComment` |
| `prComments.edit` | `{ draftId, body }` | `DraftedComment` |
| `prComments.confirm` | existing `ConfirmCommentInput` | `{ url }` |
| `prComments.cancel` | `{ requestId }` | ignored by renderer |

All IDs use `IdSchema`; head uses `CommitShaSchema`; body is 1–20,000 characters;
location uses `CodeLocationSchema`. The transport adapter parses those schemas and
shared output schemas. Integration publishes/validates the matching shared/main
boundary. No router, main service, or App binding is added by this bounded worker.

Main must derive the authoritative PR and source evidence from the actual ready
`ReviewCoordinator` record. Check review ID/head, repository and pinned file/line
identity. Derive `originalWords` from the exact user body and source evidence from
the actual PR/source, never from renderer-provided provenance. Use the shared
`CommentDrafts` core or equivalent exact draft/revision/body/head checks plus the
runtime GitHub posting ledger. Do not route through legacy `sources.prepared`
without establishing the real prepared-review record there.

Before writing, recheck the live PR head and pinned location; bind explicit
confirmation to the current draft ID, revision, body and head. Reserve/deduplicate
the stable request ID before the external write, retain unknown outcomes, and
never blind-repost after an ambiguous result. A renderer/main restart must retain
runtime-ledger protection. Account changes must fence old operations/credentials.

Main cancellation must own an `AbortController` keyed by confirmation request ID,
including the preflight period. A cancellation arriving before dispatch must be
remembered so it cannot race request registration. Pass that signal through
`CommentDrafts.confirmAndPost` and the actual runtime. Closing the dialog requests
that cancellation and retains the request, because a dispatched write may already
have completed. The renderer never claims cancellation proves no write occurred.
It blocks edits/new attempts after any uncertain result and offers only an
explicit retry of the identical request. After a verified success receipt the
user can choose **Write another comment**.

## Controlled validation

`bun test apps/desktop/src/renderer/pr-comments/pr-comments.test.tsx apps/desktop/src/main/agent/comments.test.ts`
uses the actual prepared renderer controller and actual `CommentDrafts` with
controlled ports, plus SSR. It checks exact body/revision confirmation, single-line
source identity, stale head/revision rejection, cancellation before write,
ambiguous-result dedup, close/reopen identity, and invalid responses/receipts.
It makes no network/provider calls and launches no Electron, SQLite or microphone.
Integrated renderer/native-modal/IPC/provider acceptance remains root-owned.
