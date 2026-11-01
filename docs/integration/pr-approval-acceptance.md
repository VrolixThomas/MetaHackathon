# MET-75 conditional PR approval

Implementation is on `conditional-pr-approval`. Native integration and live acceptance remain pending; this document does not establish an approval on GitHub.

## Product behavior

Open an actual ready PR file, then **PR follow-up**. Create a policy, choose notification only or automatic GitHub approval, set its UTC expiry (at most 30 days), and review the exact server-returned conditions before confirming. Existing policies remain inspectable after closing a review. Editing pauses the prior delegation immediately and requires a new policy revision and confirmation. Revocation fences evaluation independently of foreground conversation cancellation.

Foreground tools `inspect_pr_delegations`, `draft_pr_delegation`, `confirm_pr_delegation` and `revoke_pr_delegation` use that same service and UI. Model arguments cannot grant confirmation. A conversational proposal waits for two visible renderer frames; voice additionally waits for the existing exact narration checkpoint to drain. A distinct actual user turn saying “confirm this delegation” grants consent to that exact policy for two minutes. The manual confirmation checkbox/button remains available. Foreground cancellation retires the proposal, not an already admitted background delegation.

Each policy binds a GitHub numeric account ID, opaque credential connection binding, repository/PR, actually displayed prepared review, inspected base/head and a revision/digest. PR title, description, base branch and author identity are also pinned by a main-generated context digest. Credential/account changes fence pending operations and hide the old account's approval notices. Manual token replacement requires renewed consent; ordinary OAuth refresh preserves the selected account identity.

## Evidence and scope

- Check-only policies cover the inspected head. Required named checks must resolve to one successful current result, with an optional pinned GitHub App ID. Pending, absent, failed, skipped, neutral or ambiguous results block approval. Both branch ruleset and classic required status checks are included, and unsuccessful observed checks also block it.
- Later commits must descend from the inspected head, preserve the base and PR context, and change only explicitly authorized files. Each such file must match the confirmed **complete UTF-8 contents**, including line endings. Binary, symlink, executable-mode, rename/delete, unrelated, truncated or unverifiable changes cannot silently expand consent. Git blob identity and unchanged regular-file modes are verified separately from the contents response.
- Conditions requiring semantic judgment are labeled inference and always return to human review. A textual claim that tests passed never becomes execution evidence. GitHub check success is stored as a `github-check` provider result, with actual result ID when available and the evaluated head. It is separate from the existing local `Evidence` execution contract; no command or local run receipt is invented.
- GitHub account, current PR/source, permissions, active branch requirements and current checks are read through bounded official HTTP requests. Automatic approval repeats the full observation immediately before durable write admission, then rechecks PR/context/head and account before `POST /repos/{owner}/{repo}/pulls/{number}/reviews` with `event: APPROVE` and explicit `commit_id`. No merge endpoint is reachable here.

## Durability and attention

Policies, condition evaluations and action attempts are an additive optional `HubPersistence.approvalPolicies` field on the existing SQLite `hub_state` transaction. Old version-1 rows remain valid. Policy IDs are unique. One unresolved delegation per actor/PR is admitted; an uncertain attempt must be explicitly inspected/revoked before another policy can be created. Submitted policies cannot be edited.

The local monitor runs every 30 seconds while the app is running/awake. Sleep aborts its network work and records paused status; network/source failures retain offline status. Restart resumes unattempted monitoring, while a persisted submitting attempt becomes uncertain. The exact attempt ID, evaluated head and provider receipt persist. A timeout, rejected response, cancelled dispatch, receipt validation failure or lost outcome never causes automatic write retries, including after restart. Revocation can retain a late actual provider receipt without reactivating the policy. It stops future Muse actions and does not withdraw an already submitted GitHub review. There is no hosted watcher or sleeping-Mac execution.

`pr-approval` notices use the existing attention lease/cooldown/quiet/modal/focus/typing/speech gates and delivery ledger. They identify policy IDs, not fabricated coding jobs. Read-only attention narration preserves the workspace and cannot approve a PR. Approval, notification only, human judgment, expiry and uncertain writes have distinct outcomes. None accepts local work, publishes a branch, merges or completes Linear.

## Validation

Author checks are recorded in the final handoff. Focused controlled tests cover the canonical service, provider requests, confirmation gate/tool path, actual SQLite reopen, scoped source/check transitions, stale evaluations, editing/revocation races, account changes, quiet/focus/modal/input deferral and uncertain writes. They do not establish native rendering, live GitHub writes or microphone acoustics.

Root/integration-only native gate:

```sh
bun run test:pr-approvals
```

The new `pr-approval-smoke.cjs` uses the actual built App, prepared source, UI controls, preload/IPC, monitor and SQLite; only HTTP model/GitHub transport is controlled. It exercises manual policy creation/consent, exact-revision editing, success and real review-write path, renderer reload, revocation, unrelated head changes and lost provider responses. It denies Chromium remote traffic, scrubs ambient credentials, owns its temporary Git/profile, verifies preservation of dirty source, and requires a durable confirmed submitting attempt before its controlled POST can succeed. Its artifact is `apps/desktop/out/pr-approval-smoke-report.json`. This harness is authored and syntax-checked here, **not executed**: repository rules reserve combined native launches for the integration checkout. Renderer reload and SQLite reopen do not constitute a full app process restart.

Remaining acceptance: run the new native gate and relevant combined regressions in integration, exercise the conversational path with actual controlled speech/media, then separately demonstrate a freshly authorized approval on a user-owned test PR with live GitHub. No real test PR approval was authorized or performed during development. Keep MET-75 out of Done until its integrated and live acceptance is established.

### Author results (2026-11-01)

- `bun install --frozen-lockfile`: PASS; no dependency or lockfile changes.
- Full desktop source suite: 1,776 PASS, 13 pre-existing SQLite-adapter skips, zero failures. Subsequent final policy/tool/account-notice refinements were verified by the focused suite rather than repeating unrelated runtime tests.
- Final focused service/provider/consent/tool/SQLite/attention/contracts/startup suite: 47 PASS, zero failures.
- `bun run type-check`, `bun run lint`, `bun run build`, native harness `node --check`, and `git diff --check`: PASS on the final implementation.
- `bun run test:contracts`: 40 PASS at the initial contract pass; the new approval-contract regression also passes in the final focused suite.
- Combined native gates, full app process restart, physical voice and live GitHub approval: NOT RUN in this author checkout. No issue marked Done from these controlled results.
