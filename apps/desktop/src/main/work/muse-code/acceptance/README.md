# Root-only Muse Code subscription acceptance (MET-46 / MET-8)

This is an opt-in live adapter/runtime harness, separate from the controlled
Settings/Electron smoke test. Importing its modules makes no provider call.
Bounded workers run only its controlled unit tests and CLI help/refusal path.

Author read-only observation on 2026-11-01, using the existing exported
`probeMuseCode` with its safe environment: CLI **1.4.13**, installed **true**,
auth **sign-in-required**, billing **unknown**, ready **false**, fixed error
**sign-in-required**. No session or coding/model turn was created. User sign-in
is pending. No auth files were inspected, credentials copied, login/logout run,
CLI installed, global config changed or API-billing fallback selected.

## Run after user sign-in

Root/integration alone may run this after the user has signed in through the
vendor's own supported flow. The command creates real subscription model turns
and consumes actual allowance. It does not sign in or install anything:

```sh
MUSE_ROOT_LIVE_ACCEPTANCE=1 bun run apps/desktop/src/main/work/muse-code/acceptance/cli.ts --live-subscription --answer Aurora
```

Optional `--muse-path /absolute/path/to/muse` pins the CLI; `--keep-fixture`
retains the isolated fixture even after success. `--answer Aurora` is the root
operator's explicit answer to the one known fixture question. It does not grant
tool approval. Other answers, unknown flags or absent opt-in refuse execution.
Help is offline:

```sh
bun run apps/desktop/src/main/work/muse-code/acceptance/cli.ts --help
bun test apps/desktop/src/main/work/muse-code/acceptance
```

## Actual gates and evidence

1. The production adapter probes effective account, subscription allowance,
   reviewed CLI/protocol and extension guardrails. A blocked status creates no
   task. The safe environment is the adapter's existing allowlist; this harness
   forwards no new provider key, endpoint, hook or permission override.
2. `WorkJobRuntime` creates private owned Git repositories/worktrees from a new
   local fixture. Its GitHub-shaped identity is explicitly local-only: no remote
   is contacted and the token getter always fails. No user checkout is used.
3. A real coding turn must ask exactly `Which greeting should the fixture return?`
   using actual `request_user_input`, with one persisted pending question and no
   preceding edits. The first adapter invocation closes its host. The next uses
   the exact persisted session/turn/question and explicit canonical decision.
   A new session/turn, approval, unknown receipt or edited validation blocks.
4. Only `greeting.cjs` may change. Main's actual runtime commits it privately and
   executes baseline `bun run test` -> `node check.cjs`, requiring successful
   checks pinned to the finalized head. Provider summaries are not evidence.
   The original local fixture's HEAD/refs/index/config/files remain unchanged.
5. A separate task writes an observed `cancel-started.txt` then waits in a
   foreground command. The harness cancels only after observing its persisted
   running turn and file. It requires AbortError, an accepted exact-turn
   `turn/cancel` response, and reattachment of the unchanged input observing that
   same turn's actual `cancelled` terminal. Failed/completed/unknown terminals
   cannot pass. No replacement turn is allowed. All connected hosts must close;
   a bounded two-second check rejects a late `cancel-finished.txt` write. This
   interval does not establish indefinite absence of arbitrary detached effects.

`live-ports.ts` transparently wraps the exported production connection dependency
for bounded metadata observation; every request, command, start and resume still
uses the real adapter/SDK/CLI. It stores only session/turn identifiers, fixed
terminal/status metadata and lifecycle counts, never raw protocol frames, provider
messages, credentials or account labels. All normal adapter guardrails remain.
No approvals are answered; if an actual approval blocks either task, inspect its
exact request in the retained vendor session and report the gate as blocked.
Do not weaken permissions or substitute an API provider to make acceptance pass.

The CLI prints a private temporary `report.json` path and exits zero only after
all gates pass. JSON includes explicit `live-subscription` or `controlled-test`
transport, observed status/stage/failure, session/turn receipts, actual base/head,
changed files and check receipts with log digest/byte counts. It excludes vendor
summaries and raw check output. Ctrl-C aborts the current adapter call and retains
uncertain work. Failures never automatically replay a coding task.

On success only the newly owned `fixture/` child is removed, after checking the
root's device/inode/token and rejecting replaced/symlink roots. Report and marker
remain. On failure or `--keep-fixture`, private work/checkpoints remain for root
inspection. The harness never removes CLI auth/session bookkeeping in HOME, user
repositories or files outside its owned fixture. Retained unknown sessions must
be reconciled before manual fixture cleanup; this is not a full app restart test.

## Evidence limits

The controlled unit suite executes actual local Git worktrees and actual checks
with an explicitly controlled adapter port; it is not live subscription evidence.
The author has not run the opt-in live command. A successful live run would prove
this isolated adapter/runtime task, question/resume and bounded cancellation only.
It would not prove Settings/UI, installed package, native microphone/speaker,
foreground voice cancellation ownership, GitHub/Linear publication or updates.
