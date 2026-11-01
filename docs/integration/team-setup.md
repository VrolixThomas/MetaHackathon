# Local Muse analysis and shared team findings

The desktop performs review preparation through the Muse API and persists it in local SQLite.
Supabase optionally shares that inferred analysis, proposed fixes and team decisions. No hosted
model worker, GitHub App installation, webhook or Cron is required. Closed desktops do not prepare
new reviews. This supersedes the earlier hosted-preparation plan.

The selected `muse` project is `vmydpscnfgvbciotoaln`. Migrations 001–006 and the sharing API are
live. The worker/webhook functions were deleted, their custom credentials removed and the scheduler
disabled. See [current acceptance](local-sharing-acceptance-2026-11-01.md); earlier deployment reports
are historical. A real two-user exchange remains a separate acceptance check.

## Configure the desktop

The existing GitHub repository login and Muse API key power local reviews. Team sharing is optional.
Add these public settings to the active desktop `.env`:

```dotenv
SUPABASE_URL=https://vmydpscnfgvbciotoaln.supabase.co
SUPABASE_PUBLISHABLE_KEY=your-public-key
MUSE_TEAM_SERVICE_URL=https://vmydpscnfgvbciotoaln.supabase.co/functions/v1/muse-team-api
```

Never put the service-role key in desktop configuration. In **Settings → Team reviews**, choose
**Connect team** and finish the Supabase GitHub identity login. Use the same GitHub account for
that identity and the desktop's separate repository-access grant. Choose or create an organization,
register an actual repository you administer, and choose **Share local findings** for it.
Registration requires current GitHub administration rights and organization ownership; no GitHub
App installation is needed. An organization membership alone grants no repository access.

For the POC, an administrator adds other already-signed-in users to `team_memberships` using their
Supabase user UUID and the organization UUID. Each user must also have actual GitHub repository
access. The server checks identity, membership and repository permission on each request.

A current authorized exact cache hit can be reused without another model call. On a miss, the
installed app invokes Muse locally and then attempts publication. Optional lookup and publication
each have a four-second bound. Missing team settings/login/scope, denied or unavailable sharing,
and a competing publisher leave successful local preparation available. User cancellation still
cancels its own active work. Local preparation errors remain errors; there is no mock fallback.

Canonical shared analysis is immutable per organization/repository/PR/base/head/context/version.
The first valid publisher wins; another user's local report is not replaced after a race.
`reported-local-analysis` and server-derived `preparedBy` identify local provenance. Generated
explanations remain inference, and shared checks remain reported local evidence. Neither means
that Supabase executed the code or verified an explanation mechanically.

## Backend and authentication

Configure Supabase Auth's GitHub provider and allow the numeric loopback redirect
`http://127.0.0.1:43189/team-auth/**`. The configured identity app is **Muse Team Sign-in**
(GitHub app `3982722`, public client ID `Ov23lip27BYD7idL1jvn`), with callback
`https://vmydpscnfgvbciotoaln.supabase.co/auth/v1/callback`. Its client secret stays in Supabase's
managed provider settings. This is separate from the desktop repository OAuth client.

Supabase injects the server URL/public/service-role keys into Edge. The only required custom API
secret is `TEAM_ANALYSIS_VERSION=muse-local-review-v1`, identifying the shared cache policy. Keep
operator configuration in private `services/team/.env`, and custom Edge values in private
`services/team/.env.edge`. Do not upload the desktop `.env`, Muse key, coding subscription login,
private conversation or Apple signing credentials.

The authenticated HTTPS sharing API reads GitHub to verify current permissions, PR revisions,
source context and proposal feedback. It does not call Muse. End-user GitHub tokens travel to the
trusted API for these checks; they are neither persisted nor logged. Service-role credentials stay
server-only, and source-sensitive writes are denied to direct anonymous/authenticated SQL callers.

## Versioned database and API deployment

The schema and RLS policies live in `supabase/migrations/`. From the repository root, using the
official Supabase CLI (validated with 2.75.0):

```sh
supabase login
bun run team:db:link --project-ref vmydpscnfgvbciotoaln
bun run team:db:plan
bun run team:db:migrate
bun run team:db:history
supabase secrets set --project-ref vmydpscnfgvbciotoaln --env-file services/team/.env.edge
bun run team:edge:deploy
```

Build/deploy now includes **only `muse-team-api`**. Use `--env-file` only with the server custom
secret file described above. Secret updates may redeploy existing functions: if retiring an old
worker deployment, update secrets first, then delete `muse-team-worker` and `muse-team-webhook`,
and confirm the final function list. `bun run team:worker:disable` removes the old Muse schedules.
Do not enable queues for this increment. Archived consumer/webhook code is not a deployment step.

Add a new ordered migration for later changes; never reset the remote database or rewrite applied
migration history. `.temp`, `.branches` and credentials stay out of Git. `db push` does not configure
hosted OAuth settings. See [Supabase's migration workflow](https://supabase.com/docs/guides/local-development/database-migrations).

RLS checks the authenticated user, active organization membership and repository grant. A
client-supplied team ID cannot grant access. Reviews/proposals are team scoped; progress/notes are
also user scoped. HTTP revalidates access before using the privileged server key. Issued grants
expire after 60 seconds; direct PostgREST has bounded grant freshness. Revoked membership or
repository settings deny access in RLS. Progress conflicts retain the original attempt and require
explicit reconciliation; retries never silently overwrite another revision.

## Share and review a fix

Open a ready local Suggested fix, inspect its files/checks and **Mark fix reviewed**. Open Settings
while that candidate is displayed. **Review local fix for sharing** previews the exact bounded UTF-8
sources, patch, original feedback and reported local checks. Confirm **Share exact proposal**. Only
complete available source can be shared; no truncated source or log becomes proof.

An authorized teammate can inspect highlighted Before/Proposed after, the patch, digests and check
provenance. The current PR author explicitly accepts or declines the exact proposal. Acceptance
records a decision and applies no files.

**Apply accepted fix locally** uses an app-owned checkout at the current PR head, verifies original
bytes, applies the exact accepted files and runs the repository's declared checks. **Review applied
fix** opens the actual result in Completed work. Publication still uses explicit reviewed-work
confirmation; application does not push or merge. Changes to execution scripts/conventions require
separate review. Unknown interrupted applications retain their files and attempt identity.

## Validation

```sh
bun run test:team
bun run test:team:db
bun run test:team-workspace
TEAM_SMOKE_LOCAL_PREPARATION=1 bun run test:team-workspace
```

Root alone runs native checks. The SQL check uses real isolated PostgreSQL with tenant-isolation,
source-sensitive write, current revision, publication and request-ledger assertions. Both native
modes use actual UI/IPC, OS encryption, SQLite, Git and local checks with controlled provider HTTP.
The second mode exercises the actual MetaClient, one local preparation and one exact publication;
the first proves reuse without a model call. These do not establish live microphone/provider
behavior or two real cloud users. Separate live GitHub/Muse and cloud configuration checks are
reported with their limits in current acceptance.
