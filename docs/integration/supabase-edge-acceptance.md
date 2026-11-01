> Historical hosted-preparation design/evidence. Superseded on 2026-11-01 by
> [desktop Muse processing with optional Supabase sharing](team-setup.md). Worker/webhook
> functions and scheduler are disabled; their setup instructions below are not current requirements.

# Supabase-only hosted review preparation — 2026-11-01

Three functions are deployed in `vmydpscnfgvbciotoaln`:

| Function | Purpose | Actual current readiness |
| --- | --- | --- |
| `muse-team-api` | Fresh user/GitHub authorization and shared artifacts/progress/proposals | Deployed; missing App ID/private key |
| `muse-team-webhook` | Verify raw GitHub HMAC and enqueue approved repository events | Configured; signed ping and unsigned rejection verified |
| `muse-team-worker` | One bounded webhook-context or preparation job | Deployed; missing App ID/private key; scheduler off |

The application API base is
`https://vmydpscnfgvbciotoaln.supabase.co/functions/v1/muse-team-api`.
The desktop now preserves this prefix; database/Auth origins remain strictly origin-only. Its private
`.env` contains the public URL/key/API base, with other credentials preserved.

## Worker lifecycle

Migration 005 installs pg_cron/pg_net/Vault and administrative controls. Explicit enable creates two
minute schedules; each invokes the worker with one queue name and a dedicated wakeup key. The key
is scoped to waking existing jobs, never a database/public API key. Vault stores the scheduler copy;
Edge secrets hold the runtime copy. SQL management RPCs are service-role only. Vendor net objects
emitted ownership warnings during revoke; no success changing their default ACLs is assumed. Vault,
Cron and net schemas are not exposed through REST, and the queued header carries only the scoped key.

The worker authenticates, validates a bounded body, returns 202 and registers one finite task with
`EdgeRuntime.waitUntil`. It has 100 seconds total; the Muse call reserves 30 seconds for final source
checks/settlement. Claim, heartbeat, reads, provider calls and terminal writes carry cancellation.
Expired leases recover interrupted work; source/head/context changes and stale tokens cannot publish
later results. Only the database's actual state establishes readiness, never an accepted response.

Source collection and preparation are separate durable job stages. There is no mid-model checkpoint
or large-PR chunking yet: a request exceeding the budget may retry and eventually report failure.
Live preparation fit remains unverified until the real GitHub App is configured. Edge Functions'
[runtime limits](https://supabase.com/docs/guides/functions/limits) also apply to background promises.
Git checkouts, coding CLIs, development servers and repository checks stay on the user's Mac.

## Configuration and operation

Supabase supplies project server keys. Modern secret/public keys travel on `apikey`, not as JWTs;
user access tokens remain on Authorization. Custom server secrets in private `services/team/.env.edge`
are `MODEL_API_KEY`, `TEAM_ANALYSIS_VERSION`, `TEAM_WORKER_INVOKE_SECRET`, `GITHUB_WEBHOOK_SECRET`,
`GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`. The existing Muse key and scoped invocation/webhook
keys are stored in Edge secrets. The App ID/private key are absent; no fake values are substituted.

Complete [GitHub App setup](github-app-worker-setup.md), then use the explicitly linked project:

```sh
bun run team:edge:build
supabase secrets set --project-ref vmydpscnfgvbciotoaln --env-file services/team/.env.edge
bun run team:edge:deploy
bun run team:worker:enable
```

The enable command checks all three function health responses and probes the dedicated key with an
invalid queue (no job claim), then configures Vault/Cron. Its current missing-provider preflight
rejects without creating schedules. `bun run team:worker:disable` removes only Muse's two schedules.
No private key belongs in desktop configuration, a GitHub URL, source control or chat.

## Evidence

- Full units: **1766 pass, 13 Electron-only skips, 0 fail**. Final adapter suite: 13 pass. App and
  standalone service TypeScript, lint and actual built native Team flow pass. Turbo now tracks
  shared service TS inputs so outside-workspace changes cannot reuse stale app validation.
- Actual isolated PostgreSQL 17 applies 001–005 and passes tenant, lease and scheduler-role tests.
  Managed extensions are absent locally; real extension availability/status was checked in Supabase.
- Remote migration history matches 001–005, with no pending migrations. All three deployed Deno
  bundles load; imported Node compatibility modules did not prevent startup.
- Live unauthenticated API/worker requests return 401; unsigned webhook returns 401, signed ping
  returns 202 ignored. API/worker health returns 503 only for missing App ID/private key; webhook
  health returns 200. A correctly keyed worker request also returns configuration 503 without work.
- Live scheduler status is available, unconfigured, zero jobs. Anonymous administration is denied;
  Vault/Cron/net profile requests return 406. Enable preflight leaves the scheduler unchanged.

[Machine-readable evidence](evidence/supabase-edge-2026-11-01.json) separates controlled job tests
from live deployment/signature checks. No real PR preparation, scheduled consumer run, hosted
two-user exchange or installed-app live team flow is claimed. Those require the real GitHub App
installation and provider credentials. A standalone local modern-key probe could not use the masked
key returned by CLI listing; no masked value was treated as a verified credential or copied into runtime.
