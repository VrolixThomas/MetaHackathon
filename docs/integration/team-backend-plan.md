# Shared team review backend — proposed next increment

Implementation update (2026-11-01): the backend, desktop onboarding, shared preparation, proposal
review and explicit local application are now integrated and locally verified. This document retains
the original design context. The Supabase database is now deployed; HTTP API/consumer hosting and
live team login remain pending. See [deployment](supabase-deployment-2026-11-01.md), [setup](team-setup.md) and
[acceptance evidence](all-features-acceptance.md) for the implemented behavior and remaining inputs.

Current checkpoint: `d4207f7`. The desktop runs coding commands locally in app-owned Git checkouts.
Meta model calls are remote; SQLite and private local files store review plans, progress, work and
proposed fixes. Confirmed posted comments are shared through GitHub. No Muse organization backend,
shared review cache, shared proposal storage or hosted company brain is deployed.

## Target ownership

- Supabase Postgres: organizations, verified memberships, repository grants, immutable prepared
  reviews, preparation jobs, shareable proposal metadata and per-user progress.
- Private object storage: bounded proposal patches/source snapshots/check bundles, with digest,
  repository/base/candidate identity and access controls. Local paths and CLI sessions stay local.
- GitHub: canonical PR revisions, comments and applied branches. Organization GitHub App/webhooks
  authorize repository-scoped preparation when PRs open or update.
- Hosted preparation consumer: fetch approved pinned repository context, prepare analysis, publish
  a shared artifact. It runs independently of laptops, so reviews can be ready before anyone opens
  Muse. Long coding/build tasks remain local device workers in this increment.
- Desktop: voice, native browser, code presentation, local coding and SQLite offline cache. A
  developer's Muse Code login/credential is never uploaded or pooled across the organization.

## Reuse and deduplication

Use a unique preparation input key containing organization ID, GitHub repository ID, PR number,
base SHA, head SHA, analysis/model/prompt version and a digest of approved shared source context.
A new description/source revision can invalidate analysis even if code SHAs remain unchanged.
Store the result immutably and let every authorized reviewer load that same artifact.

Transactional enqueue and an expiring worker lease/fencing token prevent simultaneous clients from
publishing duplicate work. Redeliveries reuse the input key; old lease completions cannot overwrite
new work. A process dying after an external model call can still require a retry; the guarantee is
one canonical shared result per input version, not a claim of exactly-once external API billing.

Reading cursor, pauses, personal notes, private questions, drafts and private brain context are
separate user-scoped records. Shared preparation initially uses repository-approved sources only;
private DMs or restricted personal context must never be baked into an organization-wide artifact.
Personalized explanations may overlay the immutable shared reading plan.

## Access and auth

A Muse user/org identity layer must link verified provider identities. Organization membership
alone never grants every repository: reads and writes also require current repository permission.
Use server-managed memberships and grants with row-level policies. Backend administration/GitHub
App secrets stay server-side; desktop gets only user-scoped authorization. Preserve current
GitHub/Linear/Slack provider grants during any sign-in migration; do not treat a GitHub access token
as an unverified Supabase JWT. The selected project determines final callback/auth migration.

A proposal is shared as an exact patch/source artifact with source feedback revision, base/candidate
commit, digest and actual checks/environment attribution. Reviewing it, author acceptance, applying,
posting and merging are distinct events. Existing comment confirmation remains exact body/head
bound. Team sharing does not imply permission to push a branch or approve for another author.

## First acceptance slice

1. Two real users join the same test organization and authorized repository.
2. A PR revision gets one prepared result. Both users load the same artifact/digest; the second
   app performs no second model preparation. Their cursors and private notes remain independent.
3. A new head/base/context version gets a new result; old data cannot be narrated as current.
4. A local worker shares one proposal's exact patch/checks. The other authorized user can review
   it; unauthorized org/repository users cannot read it. Personal context remains private.
5. GitHub comment delivery stays in GitHub and is indexed with provider source identity; posting
   still requires explicit confirmation and cannot blindly duplicate after a lost response.
6. Offline clients retain a local cache and pending progress; reconnect is version-aware and
   idempotent. Revoked source access stops new retrieval and artifact URL issuance.

## Deployment inputs and scope

No Supabase project URL/keys are configured in this repository. A project-choice question is pending;
CLI project discovery did not return within its bounded read-only probe. No cloud resources were
created and no company/private source was uploaded. Prepare migrations and policy tests independently
of those credentials, then connect/deploy only to the agreed project.

Supabase supplies [Auth](https://supabase.com/docs/guides/auth),
[row-level policies](https://supabase.com/docs/guides/database/postgres/row-level-security) and
[durable queues](https://supabase.com/docs/guides/queues). Edge Functions can receive webhooks and
coordinate work; [runtime limits](https://supabase.com/docs/guides/functions/limits) make them a poor
place for long Git/build workers. Use a supervised queue consumer for unbounded preparation workloads.
