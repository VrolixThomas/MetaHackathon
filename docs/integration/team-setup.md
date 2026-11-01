# Shared team reviews and proposed fixes

The shared database is deployed to the selected `muse` Supabase project (`vmydpscnfgvbciotoaln`).
The HTTP API/consumer still need a hosting target, and GitHub identity-provider setup is pending.
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
4. Configure the **server-only** variables from `services/team/.env.example`. Keep the service-role
   key, GitHub App private key and preparation model key on the server. `TEAM_ANALYSIS_VERSION`
   identifies the deployed prompt/model/context policy; change it when those inputs change.
5. Run and supervise both processes from a clean repository install:

```sh
bun install --frozen-lockfile
bun run team:serve
bun run team:consume
```

Expose the API over HTTPS. Webhook ingress verifies the raw HMAC; consumers use durable leases,
heartbeats and fencing. Duplicate events reuse the preparation input. A crash after a model call
can still require another paid call; only the canonical stored result is deduplicated.

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
MUSE_TEAM_SERVICE_URL=https://your-team-api.example
```

Never put a service-role key in the desktop configuration. Choose **Connect team**, finish the
Supabase GitHub login in your browser, then select an organization and repository for shared
preparation. You can create an organization and register a repository from this panel. Registration
requires current GitHub administration rights and the actual GitHub App installation.

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
