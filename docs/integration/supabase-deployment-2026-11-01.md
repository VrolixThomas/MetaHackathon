# Shared Supabase database deployment — 2026-11-01

Selected project: **muse**, `vmydpscnfgvbciotoaln`, Muse Free organization, eu-west-1 (Ireland).
Project URL: `https://vmydpscnfgvbciotoaln.supabase.co`.

The user created the database and entered its password. CLI login and explicit project link then
deployed versioned SQL from `supabase/migrations/`. No migration was executed from the prepared
browser editor. Remote history matches 001–004, and a final dry run reports up to date. Migration
004 corrects the exact-bundle validator's timestamp-dependent volatility; applied files stay unchanged.

Subsequent [Supabase-only Edge deployment](supabase-edge-acceptance.md) adds migration 005 for
administrator-controlled scheduling; current history matches 001–005. The three Edge Functions are
deployed, with preparation and scheduling gated on the actual GitHub App configuration.

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
  The service-role key was not logged, committed, placed in desktop configuration or uploaded to
  an API/worker host.
- **Live GitHub OAuth passes.** Muse Team Sign-in (GitHub app `3982722`, owned by
  `thomasaltacc-a11y`) uses the exact Supabase `/auth/v1/callback`. The user entered the secret
  directly in Supabase. Its public settings now report GitHub enabled and anonymous users disabled.
  The desktop allowlist contains `http://127.0.0.1:43189/team-auth/**`. A real authorization completed
  through the actual `TeamAuth`/`TeamLogin` modules, PKCE exchange and nonce-bound loopback receiver;
  a fresh `/auth/v1/user` response matched the returned user and GitHub identity. This probe used
  memory-only session storage and cleared it afterwards; it did not sign in the installed app or
  exercise a hosted team API.

[Machine-readable evidence](evidence/supabase-deployment-2026-11-01.json) records migration hashes
and acceptance scope. [CLI/operator commands](team-setup.md#versioned-database-workflow) are reusable
for later migrations. [Hosted role/RLS screenshot](screenshots/supabase-rls-deployed-2026-11-01.jpg)
shows the deployed table controls. Linux CI runs the SQL policy suite on schema/test changes.

GitHub App installation/provider activation, installed-app connection with the hosted service and
real two-user exchange remain pending. The Supabase dashboard account, app Supabase identity and
repository-access grant are separate; team requests require the latter two to represent the same
GitHub user. This database/auth deployment does not claim the full team review service is live.
