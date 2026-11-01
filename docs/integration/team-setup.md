# Shared team reviews and proposed fixes

The shared database is deployed to the selected `muse` Supabase project (`vmydpscnfgvbciotoaln`).
GitHub identity sign-in/PKCE and the deployed Supabase Edge endpoints pass their checks. Hosted
preparation is waiting for the GitHub App ID/private key and repository installation; Cron is off.
The desktop remains useful with its existing local providers. No coding subscription credential or
private conversation is uploaded to the team service. See [deployment evidence](supabase-deployment-2026-11-01.md).

## Configure the backend

1. Select a dedicated Supabase project and apply **all** ordered `supabase/migrations/*.sql`
   through the CLI workflow below.
   Configure Supabase Auth's GitHub provider with its required callback. This identity login is
   separate from the desktop's existing GitHub repository grant; preserve GitHub/Linear/Slack login.
2. Allow the numeric loopback redirect `http://127.0.0.1:43189/team-auth/**` in Supabase Auth.
3. Create/install the GitHub App for the intended repositories, with read access to PR metadata,
   repository content and review feedback. Point its signed webhook at the service's webhook route
   described in [the server guide](../../services/team/README.md). Register the webhook secret.
4. Keep operator Supabase credentials in private `services/team/.env`; Edge custom secrets live in
   private `services/team/.env.edge`. Supabase injects its own server keys. Keep the GitHub App
   private key and Muse `MODEL_API_KEY` server-only. `TEAM_ANALYSIS_VERSION`
   identifies the deployed prompt/model/context policy; change it when those inputs change.
5. Build/deploy the three Edge Functions, then explicitly enable the scheduler after provider
   configuration passes. See [the Edge acceptance/operations guide](supabase-edge-acceptance.md).

```sh
bun install --frozen-lockfile
bun run team:edge:build
supabase secrets set --project-ref vmydpscnfgvbciotoaln --env-file services/team/.env.edge
bun run team:edge:deploy
bun run team:worker:enable
```

Supabase serves HTTPS. Webhook ingress verifies the raw HMAC; consumers use durable leases,
heartbeats and fencing. Duplicate events reuse the preparation input. A crash after a model call
can still require another paid call; only the canonical stored result is deduplicated.

`team:worker:enable` verifies function configuration and the dedicated wakeup key before storing it
in Vault and scheduling the two queues. It refuses the current missing-App configuration.
`team:worker:disable` removes only Muse's two schedules. The existing `team:serve` / `team:consume`
Bun entrypoints remain available for local development; production uses Supabase Edge.

## Versioned database workflow

The schema and access policies live in `supabase/migrations/`; `supabase/config.toml` configures
the local CLI project with PostgreSQL 17 and no product seed data. Use the official Supabase CLI
(validated with 2.75.0) from the repository root:

```sh
supabase login
bun run team:db:link --project-ref vmydpscnfgvbciotoaln
bun run team:db:plan
bun run team:db:migrate
bun run team:db:history
```

The explicit link selects the hosted `muse` project in the Muse organization. Other environments
must supply their own project reference. Plan performs a dry run; migrate applies pending files
and records them in Supabase migration history. Keep `.temp`, `.branches`, tokens and passwords out
of Git. `db push` does not push `config.toml` or hosted OAuth settings. Do not use a remote database
reset or repair history to bypass a failed migration. Add a new ordered migration for later changes.

The database supports multiple organizations. RLS checks the authenticated user, active membership
and repository grant; a client-supplied team ID cannot grant access. Shared reviews/proposals are
organization scoped, while progress and notes are also user scoped. Desktop configuration contains
only the public key; the backend service-role key bypasses RLS and must stay server-only. HTTP
revalidates repository access before using that privileged key.

`bun run test:team:db` applies the same files to isolated PostgreSQL and asserts policy behavior.
The Team database isolation GitHub Actions workflow runs these checks for schema/test changes.
Read the [official migration workflow](https://supabase.com/docs/guides/local-development/database-migrations)
for creating additional migrations with `supabase migration new`.

## Connect the desktop

Add these values to the active desktop `.env`, then open **Settings → Team reviews**:

```dotenv
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_PUBLISHABLE_KEY=your-public-key
MUSE_TEAM_SERVICE_URL=https://vmydpscnfgvbciotoaln.supabase.co/functions/v1/muse-team-api
```

Never put a service-role key in the desktop configuration. Choose **Connect team**, finish the
Supabase GitHub login in your browser, then select an organization and repository for shared
preparation. You can create an organization and register a repository from this panel. Registration
requires current GitHub administration rights and the actual GitHub App installation.

The configured identity OAuth app is **Muse Team Sign-in** (GitHub app `3982722`, public client ID
`Ov23lip27BYD7idL1jvn`). Its callback is `https://vmydpscnfgvbciotoaln.supabase.co/auth/v1/callback`.
The client secret stays in Supabase's managed provider settings. Do not replace the desktop's
separate repository OAuth client with this identity client. When connecting the app, use the same
GitHub user for the Supabase identity and repository-access grant.

For the POC, a trusted administrator adds other already-signed-in users to `team_memberships` using
their Supabase user UUID and the organization UUID. Membership alone grants no repository access:
every service operation also verifies the current GitHub identity and repository permission.

Prepared reviews are immutable per organization/repository/PR/base/head/context/analysis-version.
Review progress and notes are user scoped. Private progress conflicts retain the original attempt;
Settings can list them, retry independent pending work or explicitly discard/replace a conflicted edit.
The app's explicit Retry also reopens a terminal hosted preparation without resetting an active lease.

## Share and review a fix

Open a ready local Suggested fix, inspect its files/checks and **Mark fix reviewed**. Open Settings
while that candidate is displayed. **Review local fix for sharing** previews the exact bounded
UTF-8 sources, patch, original feedback and reported local checks. Confirm **Share exact proposal**.
Only complete available source can be shared; no source or log is silently truncated into proof.

An authorized teammate can browse the same proposal in Team reviews and inspect highlighted
Before/Proposed after, the patch, digests and check provenance. The current PR author can explicitly
accept or decline the exact proposal. Acceptance records a decision; it applies no files.

**Apply accepted fix locally** uses an app-owned checkout at the current PR head, verifies original
bytes, applies the exact accepted files and runs the repository's declared checks. **Review applied
fix** opens the actual result in Completed work. Publication uses the existing explicit reviewed-work
flow; application does not push or merge. Changes to execution scripts/conventions require separate
review. Unknown interrupted applications retain their files and attempt identity instead of replaying.

## Verify locally

```sh
bun run test:team
bun run test:team:db
bun run test:team-workspace
```

The database check uses isolated PostgreSQL. Native acceptance uses the actual app, IPC, encryption,
workspace, local Git and checks with controlled HTTP providers. Neither establishes deployed hosting,
live OAuth consent, two real user accounts or live preparation-model access. Root alone runs native
acceptance; signing/notarization and installed-app speech remain separate release checks.
