# Suggested fix review binding

The renderer uses the current PR-fix contracts and the actual runtime `WorkReview`.
It never enters the ordinary Hub feedback worker or offers apply, publish, merge,
reply, ticket completion, or author-approval actions.

## Root lifecycle and optional props

```ts
const fixes = createPRFixController(api.call, {
  actor: () => currentGitHubIdentity,
});
void fixes.start(); // observes local IPC immediately, then every three seconds
// On account/source transition, before publishing any new account data:
fixes.reset(); // synchronously clears all items, detail, target, pending generations
void fixes.start();
// On app teardown:
fixes.dispose();
```

Import from `renderer/pr-fixes` (includes scoped CSS). `actor()` returns a stable
account/credential-generation string or null, never a token. The controller checks
it before dispatch and after every awaited read/mutation. Root must also call
`reset()` synchronously on account/source transition; summaries do not carry
invented actor metadata. Main remains responsible for current authorization and
credential fencing. Reset retires UI observations and does not cancel background
workers; explicit `cancel(id)` is the separate worker operation.

Pass optional `fixes?: PRFixController` through App / ConversationApp /
CanvasWorkspace to the included `CenterCanvas` and `CommandSidebar` props.
Existing bindings without the controller keep their original rail/test fixtures.
The sidebar dynamically adds Suggested fixes with the independent list's actual
count and job status. `CenterCanvas` intercepts `section: "fixes"` before Hub
lookup and renders the exact selected candidate. Account reset/remount and source
port composition remain integration-owned.

## Navigation and display acknowledgement

Main/WorkspaceCoordinator must await `fixes.ensureTarget(encodedSelectedId)`.
Every call refreshes actual detail (concurrent identical reads coalesce), clears
the prior loaded marker, validates all source identities, and verifies any
requested path exists in `detail.review.files`. The public store exposes
`target`, `loadedTarget` (both canonical encoded IDs), `selectedPath`,
`detail`, `detailLoading`, and `detailError`.

Use shared `encodePRFixViewTarget({id,path})` /
`decodePRFixViewTarget(selectedId)`. The overview selects the actual first
candidate file; a null review selects no file. File buttons, the selector and
Previous/Next file emit `open-center` with the encoded target through the same
workspace command path. They never advance only local React file state. Before /
Proposed after / Diff are local views of that same pinned selected file.

After ensureTarget, root must recheck cancellation/generation, exact loaded target,
source pins and error state, then wait for two committed visible frames:

- `data-pr-fix-id` is the raw fix ID **only** while an exact matching candidate's
  selected diff or available source is actually rendered.
- `data-pr-fix-head` and `data-pr-fix-base` are the loaded candidate SHA and
  source PR head; null head is the literal `pending`.
- `data-pr-fix-path` is the actual shown file, or an empty string for status-only
  detail without a candidate file.
- `data-pr-fix-status-id` is a separate marker for the exact loaded original
  feedback/status view when source cannot be shown. It is never proof of a diff.

Markers are absent for another selection, failed reads and pending refreshes.
Status-only acknowledgement must be distinguished from source display in main.
Root owns the new optional canvas `fixSource` snapshot, exact source port,
generation checks and durable workspace receipts. The diff/source line controls
emit existing pinned `open-source` commands; root must resolve the candidate's
app-owned source at those exact SHAs without falling back to a live PR checkout.

## RPC adapter

The call signature is `ConversationApi["call"]`; all boundaries parse shared schemas.

| Method | Route | Input / result |
| --- | --- | --- |
| `start()`, `poll()` | query `prFixes.list` | `{}` → `PRFixSummary[]` |
| `ensureTarget(target)` | query `prFixes.detail` | `{id: rawId}` → `PRFixDetail` |
| `start(input)` / `prepare(input)` | mutation `prFixes.start` | `{prId,feedbackId,requestId?}` → summary or null on failure |
| `markReviewed(id,headSha)` | mutation `prFixes.reviewed` | `{id,headSha,confirmed:true}` → summary or null |
| `cancel(id)` | mutation `prFixes.cancel` | `{id}` → void, then refresh actual state |

Start generates one request ID per PR/feedback pair and retains it for an
unconfirmed response. There is no automatic mutation retry. Main must durably
deduplicate and revalidate source revisions, not assume a lost response means no
candidate started. Explicit requestId is available to an integration-owned caller.
Lifecycle start is idempotent. Tests use poll/ensureTarget and `pollInterval: 0`;
they never start a live timer/provider loop.

The feedback entry now offers **Prepare suggested fix** for every real nonempty
feedback body, including ordinary prose without a suggestion fence. It calls
`fixes.start`, then opens the exact returned fix ID. With no optional fix
controller it offers no fallback to `hub.start-feedback-work`.

## Review identity and evidence

The candidate's raw ID is its request ID; its separate `jobId` must match
`review.job.id`. Repository, base/head, original PR, captured original feedback,
check receipts, changed-file membership and every file's source SHA/path must
match. The candidate base is the **original PR head**, not the PR merge base.
Reads of an existing fix cannot silently replace its immutable source revision.
Newer list/detail observations retire stale source markers; actor/target epochs
reject late data. Backend authorization remains authoritative.

Original feedback is escaped verbatim. Explanation is explicitly **Agent summary**.
Line counts come from the actual patch; absent patches say unavailable. Checks
show actual command/args, exit code, full commit and times. Empty receipts say
checks not run; a receipt on a different commit is labelled explicitly.

**Mark fix reviewed** is enabled only for the current ready, loaded, exactly
matching review while candidate source is shown. It sends the loaded head SHA and
waits for the actual local review receipt; it makes no author-approval claim.
No checks/summary alone can enable acceptance. Needs-input, errors, interruption,
missing source and no-change candidates remain explicit. There is no Q&A or
automatic resume control in this read-only candidate view.

## Controlled verification

`bun test apps/desktop/src/renderer/pr-fixes apps/desktop/src/renderer/command-center/presentation.test.tsx`
uses controlled IPC, actual controller schemas, SSR, bundled syntax highlighting,
and the existing WorkDiff/SourceBlock. It covers account resets, late data,
source/head/file mismatch, stable admission IDs, local reviewed receipts, exact
CRLF source, navigation targets, markers, optional sidebar count and legacy views.
It launches no Electron/app, providers, native SQLite, microphone or network.
Native layout, actual child/provider integration and frame acknowledgements remain
root acceptance work.
