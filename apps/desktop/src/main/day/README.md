# MET-67 day service

Root composes this standalone main-process service. It does not register IPC, migrate the shared
database, start Electron, call a provider itself, or create another worker runtime. Shared DTOs come
from `shared/contracts/day.ts` and `chat.ts` (bootstrap `689f66a`). The worker origin marker requires
root `d37f93c`, following its root-reviewed `6216b42` dependency; these are consumed unchanged.

## Composition

1. Execute `DAY_STORE_MIGRATION_SQL` on the existing SQLite connection, then construct `DayStore`.
   Its validated JSON row has an atomic compare-and-swap sequence; never create a second active
   `DayService` writer against that row. Corrupt or oversized data fails without an empty fallback.
2. Construct `DayService({store, actor, availability, worker?, replies?, linearTicket?, ...})`.
   The actor is immutable for the instance. Dispose and recreate it on account changes; queued old
   work is retained privately and snapshots/operations select only that actor. Provider adapters
   must also fence account changes and revalidate current access; stored audience capture is evidence.
3. Wire `snapshot()` to `day.snapshot` and `operate({requestId, operation})` to `day.operate`.
   Root is responsible for requiring actual user intent for acceptance, work start and exact reply
   confirmation. Source labels/text are untrusted data and cannot supply that authority.
4. Call `start()` from app lifecycle, independently of BrowserWindow creation or foreground speech.
   Inject real awake/online state and call `availabilityChanged()` on suspend/resume/network changes.
   The synchronous abort fences adapters which ignore cancellation. `dispose()` aborts a pending
   check and saves a stopped checkpoint before root closes SQLite. It never disposes shared workers.

Defaults are a 60s successful check cadence, exponential backoff up to 30 minutes, a 30s bounded
check and at most 20 due items per cycle. All timestamps are UTC. Durable `nextCheckAt` and failed or
interrupted outboxes survive recreation. Sleeping/offline periods run no ports and record no
successful completion. Supervisor cycle timestamps describe a queue scan, never execution checks.
Only actual `WorkJob.checks` are retained as check evidence. There is no sleep/offline execution claim.

## Capture and clarification

`capture({requestId, message: ChatMessage, title, summary, kind, repositoryId?})` captures inferred
candidate metadata beside the exact source identity, source revision, text and digest. External
requests remain pending. A separate trusted `{explicitOwnPromise:true, actor}` argument may accept
an explicit promise only when the exact message author is that actor; a message claiming authority
cannot pass this argument. Manual user captures are accepted user actions and need no source/ticket.

Same-revision conflicts and out-of-order source updates reject. New source revisions clear current
acceptance, questions, review and drafts; old jobs get durable cancellation controls and old answers
become superseded. Deleted source text is erased and the item cancelled. Prepared/worker text never
becomes user instructions. Nothing infers a Linear issue: `link_linear` requires a validated actual
`linearTicket` result and stores it without updating the provider.

`queueContext({requestId,itemId,expectedRevision,questions})` adds inferred context questions even
without a worker. Actual worker decisions also queue questions. Only an explicit `cover` operation
marks them presented; `answer_question` requires that item still be current. User answers persist
before any idempotent worker-answer call. Neither path sends questions to peers. Main-only
`scheduleCheck({requestId,itemId,expectedRevision,nextCheckAt})` supports an explicit future check.
Root can publish an additive shared operation later; no public schema is duplicated here.

## Existing worker bridge

`DayWorkerPort` is declared in `service.ts`. Root bridges it to the existing `WorkJobCoordinator`:

- `prepare` receives a durable request ID, real repository ID, source evidence, inferred brief and
  an optional actual Linear ticket. It must isolate preparation and honor `isolated-no-publication`.
  No fake ticket is permitted and the existing Linear-start path must not be used to claim ownership.
- `execute` is called only after accepted ownership and explicit `start_work`. It reuses the prepared
  job. `observe` must return an actual `WorkJob` with matching job/repository identity.
- `answer` and `control` receive durable request IDs and must replay safely. Manual pause persists;
  normal app restart does not resume it. Speech cancellation never owns these jobs.
- There is no publish/approve capability here. Root must fence existing hub publication and Linear
  completion paths for preparation jobs too. A pending job becoming ready is private preparation,
  never acceptance, review, publication or ticket completion.

Review binds an actual ready job head. Changed heads clear review and supersede unsent answers.
No configured checks means an empty actual check list; the service creates no successful check.
Observed jobs must carry the exact configured actor, item and preparation request in `internal`.
`internal.stage: prepared` means private preparation is ready to start; only admitted ready execution
can become `ready_review` or receive reviewed-head acknowledgement. Failed/paused/cancelled workers
are not projected as working. Foreground cancellation has no worker-disposal capability here.

## Answer outbox

`draft_reply` is local. `send_reply` must match the current item revision, exact draft revision/body,
accepted ownership, answered questions and (for jobs) the reviewed ready head. Slack send staging
rejects bodies over 4000 characters rather than accepting provider truncation. It durably creates a
pending outbox before calling any provider. The provider input has a stable request ID and the exact
original source revision; body SHA-256 is persisted alongside it.

Before `send`, the outbox becomes uncertain. Any error, cancellation or process interruption keeps
that uncertainty. A later `reconcile` can return a verified delivered receipt, authoritative
`not_found`, or `uncertain`. Only authoritative absence permits the same request/body to retry; an
eventually consistent search miss is uncertain. A provider without reconciliation can always return
uncertain and retain the item rather than duplicate a reply. Root may implement reconciliation from
the Slack adapter's durable delivery ledger. Stable request IDs do not by themselves prove that a
provider supports idempotency.

`day.replyLedger` implements the Slack adapter's separate durable reservation hooks. Inject it as
`SlackClientOptions.replyLedger` and map the day reply port's `reconcile` to `day.reconcileReply`.
The key is exactly `connectionId:requestId`, binding is SHA-256 of `JSON.stringify([source, body])`,
and first provider reservation is distinct from the outer day outbox's uncertain attempt. A repeated
reservation without receipt returns uncertain; a recorded receipt returns delivered. The provider's
`delivered` callback persists its receipt and eligible closure before the outer send returns, so lost
outer acknowledgements do not lose proof. A different connection or binding cannot reuse the slot.
`reconcileReply` may report authoritative absence only when this mandatory-reservation adapter is
used: no reservation then proves no POST was admitted. Do not use it to infer absence for arbitrary
provider implementations that bypass the ledger.

The receipt identifies the delivered reply message, original workspace/conversation/thread, exact
request ID/body digest and delivery time. The original source revision remains in the outbox.
Only a matching verified receipt for a current eligible outbox atomically records `answerReceipt`
and `phase: closed`. A superseded reply can settle its own ledger but cannot close newer work.
Receipt write failure is recovered through reconciliation, without another send.

## Validation

Lane unit checks use fake store/worker/reply/clock/power ports:

```sh
bun test apps/desktop/src/main/day/service.test.ts apps/desktop/src/main/day/supervisor.test.ts
bunx tsc --noEmit -p apps/desktop/tsconfig.main.json
bunx biome check apps/desktop/src/main/day apps/desktop/src/main/db/day-store.ts apps/desktop/src/main/db/day-store.test.ts
```

`main/db/day-store.test.ts` is authored for root's actual SQLite run: additive migration, CAS conflict,
durable reopen including exact outbox/Q&A/next-check state, corruption, rollback and size limits.
This lane does not run that file or any native/app/provider/microphone check. Root's integrated
acceptance must exercise real SQLite/lifecycle, existing workers, current provider access and actual
delivery before MET-67 can be Done.

Storage bounds (1000 retained items, 100 replies per item, 10000 operation IDs, 32 MiB total) reject
new oversized writes without evicting pending work, delivery proof or idempotency history.
