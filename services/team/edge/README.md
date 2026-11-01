# Supabase Edge sharing API

The active deployment contains only `muse-team-api`. Review preparation runs from the desktop
through Muse; Edge verifies GitHub access/revisions and stores shared local findings/proposals.
No App key, server Muse key, webhook or worker trigger is required. See the
[operator guide](../../../docs/integration/team-setup.md).

`bun run team:edge:build` bundles `services/team/edge/muse-team-api.ts` to the ignored generated
`supabase/functions/muse-team-api/index.ts`; `team:edge:deploy` deploys only that function. The
tracked Supabase config disables legacy worker/webhook functions. Database migrations remain
ordered and include the source authorization/RLS/local publication rules through 006.

## Runtime boundary

The adapter strips exactly its function URL prefix, bounds JSON bodies, uses the existing validated
API/service code and performs its own Supabase session and matching GitHub identity checks. The
platform JWT gate is disabled because the API validates current authentication itself. Anonymous
requests remain rejected. New Supabase secret keys travel only as `apikey`; legacy JWT service-role
keys retain their supported Bearer handling. Neither key kind is sent to desktop.

Supabase injects URL and public/admin keys. `TEAM_ANALYSIS_VERSION` is the only custom required
API setting. `/health` reports fixed configuration metadata without secrets; configured health is
not proof of a real two-user exchange. `/v1/reviews/publish` performs fresh source authorization,
validates exact local content and uses immutable SQL publication. Legacy request/retry routes
return 410 and never schedule work. Muse is not a runtime dependency of the API execution path.

## Historical adapters

The worker/webhook source and controlled regression tests are retained for history. Their original
100-second budgets, App/model credentials, lease/fencing and HMAC/trigger policies apply only to
that inactive implementation. They are not deployment requirements. The live functions were
removed and the scheduler disabled on 2026-11-01. Do not enable them for local processing.

`bun test services/team/edge/edge.test.ts services/team/api-local.test.ts` checks controlled
configuration, auth, prefix routing and local publication. Root separately verifies deployed API
health/access denial and isolated PostgreSQL RLS. These tests do not establish live speech or
real multi-user cloud sharing.
