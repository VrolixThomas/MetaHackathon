# Shared local review findings (MET-72, MET-73, MET-41)

All review analysis is initiated by the desktop through Muse. Supabase optionally stores and shares
those findings and exact proposed fixes; it does not run the preparation model. The selected `muse`
project has migrations 001–006 and `muse-team-api` deployed. The former hosted worker/webhook are
retired, their custom secrets removed and Cron disabled. No GitHub App is required.

See the [setup and database workflow](../../docs/integration/team-setup.md) and
[current acceptance](../../docs/integration/local-sharing-acceptance-2026-11-01.md).

## Desktop composition

Root supplies `TeamService` with user-data paths, Electron `safeStorage` after app ready, public
Supabase configuration, the selected main-only GitHub credential/account generation, external
browser opening and actual local candidate/apply ports. GitHub/Linear/Slack credentials remain
separate from the Supabase session. Never use service-role, GitHub or coding credentials as a
Supabase session.

`TeamLogin(auth, openExternal, port=43189).connect(signal)` owns a temporary numeric loopback
listener. It accepts only matching random-nonce callbacks, expires them after five minutes, binds
127.0.0.1, closes on completion/cancellation and does not log query strings. Root disposes it on
shutdown. Register `http://127.0.0.1:43189/team-auth/**` in Supabase Auth. Refresh is serialized,
validated for the same user and fails closed. Only OS-encrypted storage holds refresh tokens.

`TeamService.prepare(context, signal, localPrepare)` validates repository-only context and tries a
bounded optional exact current lookup. An authorized hit can be reused. Missing settings/login/scope,
offline/denied lookup or a miss invokes the injected local callback once. Successful local preparation
then attempts bounded optional publication and remains available if sharing fails or another publisher
wins. Lookup and publication each have a four-second bound, while parent cancellation propagates.
Personal conversation and notes never enter shared model context.

`TeamPreparationProvider` derives immutable keys from validated context. `TeamClient.publishReview`
validates the exact strict submission and returned canonical key/digest, bounding both fetch and
body reads. Hosted request/retry routes return 410; desktop preparation no longer enqueues or polls
workers. Review Retry starts local preparation through the existing coordinator.

`TeamClient.load` distinguishes current/pending/offline-cache. Historical offline cache cannot prove
current source authorization or display, and denied access never uses it. Account-revision fences
reject late results across Supabase/GitHub changes, including changes back to the same identity.
Encrypted private cache/outboxes are separated per account within a 32 MB budget. Stable progress
writes are durable before send. Conflicts retain the original notes/cursor/revision, skip only that
input while flushing independent work and require explicit discard or replacement with a new ID.

## Sharing API and database

`POST /v1/reviews/publish` accepts `{requestId,key,review,digest}`. The server authenticates the
Supabase user and matching stable GitHub identity, rechecks active membership and current repository
access, and rereads current PR base/head/source context using the end user's GitHub token. It checks
exact key/context/file coverage and digest before invoking the service-role SQL publication RPC.
No server model call is made. The user token is not persisted or logged.

Migration 006 permits repository registration without a GitHub App installation, with fresh GitHub
administrator rights and organization ownership. It adds immutable first-writer local publication,
actor/request deduplication and server-derived `prepared_by`/local origin. The RPC rechecks current
membership/grant/revision/context witnesses; clients cannot bypass the API's source checks through
PostgREST. Shared artifacts expose optional `reported-local-analysis` provenance and `preparedBy`;
legacy artifacts without that metadata are not relabeled as locally prepared.

The API checks access per operation; issued SQL repository grants expire after 60 seconds. RLS also
checks organization membership/repository configuration on every query, and private progress/notes
include user identity. A supplied organization ID never grants access. Service-role credentials
bypass RLS and remain server-only. Trusted administrator membership management is still required for
the POC. `team:db:*` uses ordered CLI migrations; no reset or history rewriting is part of setup.

## UI and exact proposals

`renderer/team` provides actual connection, organization creation, repository registration/selection,
local sharing, exact source/patch/check review, author acceptance/decline and separate Apply
confirmation. Root owns the card, controllers, routers, source readers and runtime composition.

A local fix must be reviewed before sharing its exact bounded sources, patch, feedback and reported
checks. An accepted proposal applies no files. Explicit local application rechecks the current PR
head, original bytes and exact accepted bundle in an app-owned checkout, then runs declared checks.
Only an actual application receipt can open Completed work. Publication/push/merge remain separate
explicit actions. Unknown interrupted apply attempts preserve their identity/files instead of blind
replay. No token, private conversation or coding subscription credential is part of a shared artifact.

## Commands and archived code

```sh
bun run team:serve                 # local API with private services/team/.env
bun run team:db:plan
bun run team:db:migrate
bun run team:edge:deploy           # API only
bun run test:team
bun run test:team:db
```

The local API needs Supabase URL/public/service-role keys and `TEAM_ANALYSIS_VERSION`; the hosted
API uses injected Supabase keys plus that version. Muse credentials belong only to desktop. See
[Edge notes](edge/README.md).

Consumer/webhook/worker adapters and historical migrations remain to preserve prior schema and
regression coverage. They are not built/deployed by the active path. `team:consume` is archival
operator tooling, not a prerequisite or supported automatic local-review path. Do not enable its
scheduler or install an App for this increment. Historical worker tests use controlled transport
and prove no current hosted preparation capability.

Native acceptance uses real Electron/IPC/encryption/SQLite/Git with controlled provider responses.
Live cloud health and a separate actual GitHub/Muse preparation probe pass; actual two-user sharing,
installed speech, signed distribution and updates remain separate acceptance gates.
