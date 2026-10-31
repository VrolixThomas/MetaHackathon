# Local PR-fix supervision

`PRFixService` composes `PrCommentFixes`, `WorkJobRuntime` and the existing
`coding-worker.js` / `coding-entry.ts` child protocol. It owns a separate private
store and never admits records to `WorkJobCoordinator`. There are no publication,
apply, reply, comment-resolution, merge or author-approval capabilities.

## Root wiring

Import `PRFixService` from `main/work/pr-fixes`. Supply:

- `directory`: canonical absolute app-owned storage outside registered repositories;
  one main process owns this directory. Owner/record mutexes and the two-worker
  scheduler are process-wide, shared across service instances using that directory.
- `runtime`: the existing runtime's `prepare`, `finalize`, `review` methods.
- `workerEntry`: the built `coding-worker.js`; `envPath`: main's actual active
  configuration path. Child environment contains only the existing safe execution
  environment and `ELECTRON_RUN_AS_NODE=1`; tokens are not inherited.
- `getAccount`: the actual active GitHub login (or null), bound to root's selected
  credential session; `getEpoch`: root's GitHub credential/connection epoch.
- `readSource({prId,feedbackId}, signal)`: reload the actual PR, exact feedback and
  registered repository with current authorization. No cached fixture fallback.
- Optional `redact`, `onChanged` (refresh the current account's UI). Notifications
  contain no source payload. `runWorker` is an injection seam for controlled tests.

Use the shared `pr-work.ts` DTOs at root IPC/tool boundaries. This implementation
consumes integration's required `PRFixSummary.jobId` addition in `0744e53`.
`fix.id` is the original admission request ID. `fix.jobId` is the actual owner-scoped
candidate job identity, available at admission; it is deliberately separate.

Call `invalidate()` on credential/account change and sleep, incrementing root's
GitHub epoch when the credential identity changes. It synchronously aborts this
instance's contexts and workers. Call and await `dispose()` on shutdown; owned real
children retain their capacity lease until exit (SIGTERM, then SIGKILL after 2s).
Foreground speech cancellation must never call these methods.

## Review behavior

`start(input)` reads and captures immutable exact source, durably admits it, then
returns before worktree preparation. Up to two attempts per owner/store run at once;
each has a 20-minute execution bound. The queue retains at most 100 attempts and
1000 idempotency aliases. Queue overflow fails closed without evicting retained work.

`list()` returns up to 100 actual captured attempts. Exact-source repeated starts
dedupe to the original ID; changed bodies, timestamps, PR heads or registration
snapshots are distinct revisions. Reusing a request ID for another revision rejects.
`detail(id)` returns the actual `runtime.review(job)` candidate diff/source/checks,
or null before a finalized candidate exists. Detail and local reviewed mutations
require the captured exact source fingerprint to match fresh authorized source;
missing access or moved/edited source rejects without exposing a candidate. Private
records remain retained. Detail checks job identity, full source pins and the exact
changed-file set. Inspection failures return a fixed safe error
and null review rather than inventing a patch.

`markReviewed({id,headSha,confirmed:true})` rereads the actual candidate and records
only the local viewed revision. A reading reviewer may use it; it neither asserts
PR-author approval nor sets `WorkJob.reviewedAt`, completes Linear, or publishes.
Failed checks and zero configured checks remain explicit. Root should show the exact
source comment/revision, pinned base/candidate head, file diff and checks together.

`cancel(id)` retains files and records an interrupted pending attempt. Reopening the
service never automatically executes incomplete admissions or uncertain children.
The same request ID returns the retained interruption. An explicitly new request ID
after failure/interruption creates a fresh isolated job/checkpoint/worktree; it does
not replay or overwrite the old attempt. Needs-input outcomes retain their actual
worker question. This service has no decision-answer or uncertain-worktree resume API.

## Persistence and validation limits

State is owner-scoped by actual login, in 0700 directories with 0600 atomic files,
file and directory fsync, bounded reads, symlink/hardlink rejection and source/job
binding validation. Active leases distinguish live instances from interrupted
durable records. All boundary operations check owner and epoch before and after;
the final atomic rename also checks the synchronous epoch/lifecycle fence.
Store failures throw fixed safe errors; asynchronous failures persist safe summaries
where storage and the current owner still permit it, otherwise retain admission
for read-time interruption recovery. Provider exception text never becomes UI error copy.

Controlled tests use temporary private state, injected runtime/worker ports and fake
child event emitters. They do not launch Electron, a native app, real worker children,
SQLite, live providers or microphones. Root still owns real app/child/provider
composition and acceptance. This is a local main-process supervisor, not hosted
execution or coordination across separate app processes.
