# New coding-job model pins (MET-8)

The coding seam is implemented on `demo-story-conversation-fix-20261102`, after the
five unchanged foreground commits `3a05390` through `55017ea`. New Meta API coding
jobs pin `muse-wonder-1.0` / `high`. Historical jobs retain
`muse-spark-1.3` / `minimal`, including jobs already admitted without any worker
checkpoint. An existing explicit model pin remains authoritative. Conflicts stop
execution; no provider, billing, model, or checkpoint fallback is introduced.

Implementation commits, in order:

- `0c74b33`: main-only model schema, worker checkpoint/request handling and exact
  Meta HTTP model/reasoning selection; worker and transport regressions.
- `daba2ed`: immutable provider model selection, checkpoint conflict checks,
  dispatch propagation and private admission metadata helpers; pin/dispatch tests.
- `662c7ac`: all admission consumers and their regressions, including
  subscription-session compatibility.

## Durable admission and compatibility

Regular ticket, feedback and internal jobs allocate a new ID and persist a private
`.coding-model-<sha256(jobId)>.json` in the configured jobs directory before the
job enters the public durable queue. The record binds job/repository/ticket/brief
and provider identity by digest. It contains no prompt/source text. Create-only
publication, private file permissions, symlink/hardlink checks and directory sync
reuse the provider-pin boundary. A failed metadata write prevents public admission.
A failed subsequent public write may leave an unused record for that allocated ID;
it grants neither execution nor publication authority.

`WorkJobCoordinator` reads that record when constructing `CodingTaskInput`. Missing
metadata is historical; it is never inferred to be new from a missing checkpoint,
current settings, a creation timestamp, restoration or a user decision. New
coordinator instances reopen the same metadata. Decisions, validation feedback,
manual resume and review revisions keep the original selection.

Private PR-fix entries persist the same optional `codingModel` alongside their
existing provider and source binding before preparation/execution. Legacy entries
remain unmodified and uncertain executions are still never replayed. Locally
applied team proposals record admission metadata before publishing their new
Completed work job, so later coding revisions use the pinned choice. Reopening an
already recorded team job does not upgrade it.

`CodingTaskInput`, the provider sidecar and coding checkpoint accept an optional
main-only exact model/reasoning pair. No shared/public DTO, router, renderer,
provider settings, dependency or `services.ts` change was required. Task hashes,
source/repository identity, provider/billing identity and subscription session keys
remain unchanged. Subscription admissions carry no Meta model choice; the CLI
adapter and its production protocol are unchanged.

Provider sidecars without a model mean Spark/minimal and are not rewritten. A
checkpoint without a model also means Spark/minimal. Checkpoint-only explicit
model metadata can be adopted when no provider sidecar exists. Explicit admission,
sidecar and checkpoint model conflicts reject before model/tool work, including
when the checkpoint already contains a settled result. Dispatch rechecks the
sidecar after logging and the worker rechecks the actual checkpoint. New checkpoints
persist their exact pair before the first request. Every model round and output-limit
retry sends that pair, independent of future generic workload routing changes.
A wrong-model completion is rejected before executing returned tools.

## Validation

At the three implementation commits above, all **193 tests passed**, with **zero
failures or skips**, using one fresh Bun process per exact source file:

| Test file under `apps/desktop/src/main/` | Passed |
| --- | ---: |
| `agent/coding-worker.test.ts` | 21 |
| `agent/meta-client.test.ts` | 17 |
| `agent/pr-comment-fixes.test.ts` | 31 |
| `work/coding-provider/pin.test.ts` | 14 |
| `work/coding-provider/dispatch.test.ts` | 7 |
| `work/jobs.test.ts` | 30 |
| `work/pr-fixes/index.test.ts` | 29 |
| `work/pr-fixes/child.test.ts` | 8 |
| `work/muse-code/index.test.ts` | 28 |
| `work/muse-code/acceptance/runner.test.ts` | 7 |
| `composition/team.test.ts` | 1 |

Run each as `bun test ./apps/desktop/src/main/<path-above>` from the repository
root. The explicit `./` avoids matching historical source snapshots in ignored
`out/` directories. The subscription acceptance runner here uses controlled ports
and temporary local repositories; it does not launch the installed CLI or Electron.

`bun run type-check`, `bun run lint` (725 files), `bun run build`, targeted Biome
and `git diff --check` also passed. No dependency installation was performed.

Coverage includes new API admission, old queued jobs without checkpoints, new
coordinator reopen, legacy marker byte preservation, explicit checkpoint reuse,
model mismatch before settled-result reuse, decisions and validation feedback,
failed metadata admission, source/provider drift, malformed private metadata,
dispatch mutation, exact child IPC, unchanged CLI session identity, private PR-fix
reopen and team-application deduplication. Controlled HTTP verifies the exact model
and reasoning body; provider rejection never retries through another model/provider.

## Integration handoff

Root must integrate these commits after the five foreground commits, rebuild, and
own combined native acceptance. In particular, `executive-smoke.cjs` around line
317 currently asserts Spark for every coding request. Update its controlled
**new-job** expectation to Wonder/high and preserve Spark assertions for historical
jobs; its SSE helper already echoes `body.model`. Corresponding self-check inputs
around lines 1189–1208 also need alignment. Root was notified before handoff. PR-fix
SSE responses already echo `body.model`; review exact new-job reasoning assertions
there as appropriate.

Suggested root checks: `test:executive`, `test:pr-fixes`, `test:coding-provider`,
`test:team-workspace`, then the foreground/native acceptance already owned by root.
No native tests, installed app/profile, live MET-77 job, live providers, credentials,
push, merge or installation were touched by this worker. Controlled results do not
establish live Wonder entitlement, live subscription coding, microphone behavior,
installed upgrade/downgrade compatibility or a user-perceived latency improvement.
