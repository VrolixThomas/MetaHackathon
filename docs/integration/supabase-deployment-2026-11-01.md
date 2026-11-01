# Shared Supabase database deployment — 2026-11-01

Selected project: **muse**, `vmydpscnfgvbciotoaln`, Muse Free organization, eu-west-1 (Ireland).
Project URL: `https://vmydpscnfgvbciotoaln.supabase.co`.

The user created the database and entered its password. CLI login and explicit project link then
deployed versioned SQL from `supabase/migrations/`. No migration was executed from the prepared
browser editor. Remote history matches 001–004, and a final dry run reports up to date. Migration
004 corrects the exact-bundle validator's timestamp-dependent volatility; applied files stay unchanged.

The database contains 13 public application tables with RLS and four non-exposed private ledger
tables. A team is represented by a Muse organization. Database access requires the authenticated
user's active membership and repository grant, independent of any team ID supplied by the app.
Progress and notes are additionally private per user. The backend's privileged service role bypasses
RLS, so it remains server-only and every HTTP request independently revalidates source access.

Actual verification:

- Supabase CLI 2.75.0 dry run, deployment, history and final no-pending check pass.
- Remote database lint has no errors. Two unused-variable warnings remain in the proposal-sharing
  overloads; the timestamp-volatility warning is fixed by the additive migration.
- Actual isolated PostgreSQL 17 applies all migrations and passes both security suites, including
  two disjoint teams sharing a repository ID, explicit foreign IDs/forged keys, denied writes,
  anonymous/nonmembers, revoked membership, multi-team membership and private progress. Test rows
  roll back; the ephemeral container is removed.
- Live Supabase REST checks deny anonymous access to all 13 public tables. Selecting the private
  schema is rejected with HTTP 406. These are live role/exposure checks, not two real user sessions.
- Only the public URL/key were added to the existing main-checkout desktop `.env`, preserving other
  values. Backend credentials are in owner-only, Git-ignored `services/team/.env` in integration.
  No credential values are logged, committed, placed in desktop configuration or sent to a host.

[Machine-readable evidence](evidence/supabase-deployment-2026-11-01.json) records migration hashes
and acceptance scope. [CLI/operator commands](team-setup.md#versioned-database-workflow) are reusable
for later migrations. [Hosted role/RLS screenshot](screenshots/supabase-rls-deployed-2026-11-01.jpg)
shows the deployed table controls. Linux CI runs the SQL policy suite on schema/test changes.

GitHub identity-provider registration/secret entry, the desktop callback allowlist, GitHub App
installation, hosted HTTP API/consumer and real two-user exchange remain pending. The OAuth form is
prepared in Chrome; creating credentials requires the user's security confirmation. This database
deployment alone does not claim the full team review service is live.
