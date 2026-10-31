# Muse Code subscription worker adapter

Exports from `index.ts`:

- `resolveMuseCodeBinary(explicitPath: string | null): Promise<string | null>`
- `probeMuseCode({ musePath }, signal?): Promise<MuseCodeStatus>`
- `runMuseCodeTask(input: CodingTaskInput, { musePath, log, redact }, signal): Promise<CodingTaskResult>`

The optional final dependency argument is for controlled tests. Production uses
the pinned `@muse-code/sdk` 1.4.14 and the actual signed-in vendor CLI. It never
extracts, decrypts, copies or proxies a CLI key into the Meta API. There is no API
fallback, echo provider, automatic login or installation path.

## Account and billing

[Vendor authentication](https://dev.meta.ai/docs/muse-code/auth) gives environment
keys priority, then stored keys, then browser login. A
[subscription](https://dev.meta.ai/docs/muse-code/subscriptions) applies through
the vendor CLI credential; additional API keys are pay-as-you-go.

Installed CLI 1.4.13's offline **experimental** schema exports `account/read`
(`accountLogin`, `envKey`, `apiKey`, `loggedOut`) and `usage/refresh` (fresh
`subscriptionActive`, optional usage/tier name). These carry metadata, not keys.
Missing subscription evidence is unknown; inactive subscription is not proof of
PAYG. Stable `usage/read` is cache-only and cannot establish current readiness.

SDK 1.4.14 has no typed account helper. Its official public `spawnMspConnection`
plus `MuseClient` construction supports generic requests, validated here with
narrow local schemas after negotiating `experimentalApi: true`. Unknown shapes,
missing current usage, exhausted window/weekly allowance or an API-key lane
block. Proven account/billing facts survive a separate execution-capability block.

Reviewed stable schema pins:

- CLI 1.4.13: `7fddaf646dbc317e5fcac0785e135eb04df14fbb0db1863089dfd6da21730e5b`
- SDK 1.4.14: `c94c3d1f2f51e6424074b9ec43eac3eedcf532d3dcd77351ec1383a87d3049c6`

The SDK normally warns about additive fingerprint drift; this adapter accepts
only reviewed version/fingerprint pairs. CLI 1.4.14 was not installed or launched.
The 1.4.13 CLI/1.4.14 SDK combination was metadata-probed. Its experimental
interfaces still have no stable compatibility guarantee.

## Execution boundary

The vendor environment explicitly allows PATH/HOME/LANG/TMPDIR/XDG directories.
Provider keys, alternate endpoints, Node hooks, fail-open and tracing flags are
absent. `MUSE_NO_AUTO_UPDATE=1` (supported by the installed launcher) prevents
worker-triggered updates. HOME remains the user's so the CLI owns login and
durable bookkeeping. The adapter itself never reads auth files.

Process-only arguments: provider `meta`, preset `miniswe`, restricted shell
network, `agents.execution_capacity=1`, and explicit `run.toolset` array containing
only `read_file`, `edit_file`, `write_file`, `bash`, `request_user_input`. No
peer/computer/browser/workflow/MCP/publication tools are selected. `hooks={}` and
`managed_hooks_path=null` are process-only overrides; unsupported or enforced
policy conflicts must fail rather than weaken fallback. See vendor
[configuration](https://dev.meta.ai/docs/muse-code/configuration) and
[toolset guidance](https://dev.meta.ai/docs/muse-code/extending).

`mcp_servers={}` was rejected as a per-run CLI override and is not passed.
Instead, effective host `mcpServer/list` must be empty before session admission.
Read-only `muse plugins list --json` must show no enabled installed records
before admission; it never disables or modifies them. Actual session MCP/plugin/
hook projections are checked before coding and while observing the turn.
Configured extensions, unknown projections or unexpected hooks block execution.

Catalog-native `:ask-me` must be available. New sessions require the SDK's
`requirePermissionProfile: true`. Resumes reread committed profile, provider,
workspace root and axes; absent/unknown axes are not assumed safe. Only sandboxed
filesystem, human/on-request approval and restricted/off shell network pass.
No yolo, approval disabling or unrestricted profile is used.

The root must be an existing `WorkJobRuntime` private worktree: ownership JSON,
id/repository/device/inode and private `.git` pointer must match. New turns choose
only that root. Ordinary user checkouts are rejected. Vendor-owned durable state
still uses its normal HOME directories; this is not a claim of zero vendor
bookkeeping outside the worktree. Main owns Git finalization, check receipts,
review and publication.

## Persistence and interaction

The adapter owns `checkpointPath + '.muse-code.json'` and its `.lock`: bounded,
single-link 0600 atomic/fsynced files. The router peer separately owns the immutable
provider pin. No Meta checkpoint or provider marker is converted/overwritten.
Canonical task/worktree/inode/checkpoint, binary version and session identity are
pinned before effects. The SDK's single minter supplies command IDs; a persisted
turn intent is submitted using `Connection.command` with `maxAttempts: 1`.
Lost submission/answer receipts are never blindly retried. Only actual server/fold
identity can reconcile a retained turn; otherwise needs-input is returned without
a new session. Incomplete opening/answering states may require explicit inspection.

Resume uses the exact durable SDK session. Fresh main user decisions reach it.
For one still-pending question, a new canonical
`question + '\nUser decision: ' + answer` from `decisionContext` can answer that
exact prompt/question ID, up to the SDK's 500-character limit. Source, summaries
and validation logs cannot authorize an answer. Multiple questions, ambiguous/
oversized context or unknown answer receipts remain needs-input. Tool approvals
are never automatically answered, including by an unstructured "yes"; review the
exact request in the vendor session. There is no blanket approval path.

Worker cancellation cancels its known SDK turn, closes/drains the host and retains
intent; a late connection is also closed. The SDK owns bounded EOF/SIGTERM/SIGKILL
cleanup. Foreground speech must not own this signal. Unknown, failed or cancelled
terminals never become completed. Redacted/bounded CLI summaries remain inference;
only independent main-runtime execution creates actual check receipts.

## Actual evidence and gaps

Author validation: 26 fake SDK-port/temp-file tests, full main TypeScript and scoped
Biome pass. Cases cover status/version/quota, credential/extension/profile blocks,
question identity/new answers, approvals, resume/unknown effects, cancellation/
late cleanup, locking, pin mismatch, checkout and symlink isolation.

Authorized read-only CLI checks: help/version/offline stable+experimental schemas;
enterprise validation of the explicit toolset array; SDK metadata-only host with
the complete safe arguments; zero enabled plugins, zero effective global MCP,
sandbox available, native `:ask-me` available. No SDK session/model turn was created.
The actual exported probe reports **sign-in-required**, billing **unknown**,
ready **false**. No subscription or allowance is verified on this machine yet.

No coding/model turn, authenticated subscription run, real question/approval
resume, session-start hook projection or real coding-turn cancellation was launched
by the author. Root must verify those after user-authorized vendor login and real
local work/checks. Experimental API absence, configured extensions, incompatible
policy or missing safe axes must remain blocked. No stable account ID is exposed:
display labels are not ownership proof. The native CLI owns credential selection;
the adapter rechecks its effective lane and does not claim an auth-key lock.
