# Shared team review service (MET-72, MET-73, MET-41)

These modules are real Supabase/PostgREST adapters and executable migration paths. The selected
`muse` database (`vmydpscnfgvbciotoaln`) has migrations 001–004 deployed through the CLI; HTTP API/consumer
hosting and GitHub identity login remain pending. No product fixture fallback exists. Root owns desktop
composition, shared DTO publication, manifests and combined acceptance. Lane-local protocol schemas
are in `services/team/protocol.ts` and reuse the existing PreparedReview contract.

## Desktop composition

Construct `EncryptedTeamStore` with separate user-data paths for session and private cache and inject
Electron `safeStorage` after app ready. Construct `TeamAuth` with `SUPABASE_URL` and the Supabase
**publishable** (or legacy anon) key. Never pass a service-role key, GitHub access token or coding
subscription credential as the Supabase session. GitHub/Linear/Slack credential stores remain separate.

`TeamLogin(auth, openExternal, port=43189).connect(signal)` owns the real temporary numeric loopback
listener and returns only the connected Supabase user ID. Root injects `shell.openExternal` and disposes
it on shutdown. The lower-level `beginLogin(loopbackOrigin)` also exists for tests or an existing
root-owned listener; forward only matching
`/team-auth/<random nonce>?code=...` callbacks to `finishLogin`; callbacks expire after five minutes and
are single-use. Register the numeric loopback callback wildcard for this dedicated port in Supabase
Auth redirect allowlist. The listener must bind `127.0.0.1`, close after success/cancel, and not log query
strings. `status()` returns only connection/user metadata. Session refresh is serialized, validated for
the same Supabase user, and fails closed. Only OS-encrypted storage holds refresh tokens.

`TeamClient` takes service HTTPS URL, `TeamAuth`, main-only `getGitHubToken`, encrypted cache and optional
injected fetch. `load(key)` returns `current`, `pending`, or `offline-cache`. Offline cache is historical
and cannot establish present source authorization/display. A forbidden response never uses cache.
`saveProgress` durably records a stable exact write before sending; `flushProgress` replays it after
reconnect. Conflicts require explicit reconciliation, never silent overwrite. Cache retains separate account records/outboxes in one encrypted file, with a 32 MB total budget.
Inject `getAccountRevision` from root's combined Supabase/GitHub account generation to reject late
requests across account changes, including changes that return to the same user. Supabase auth revision
and token/user comparisons are also checked locally. Never pass cached responses directly into a
positive workspace/display receipt.
`TeamPreparationProvider.lookup(context)` is the root review-provider seam: it derives the exact
immutable key from approved repository-only context and returns an existing prepared review or null;
it rejects offline data as current preparation. `prepare(context, signal)` enqueues a missing exact
input through the hosted service and polls the canonical result; it performs no local model call.
Failed jobs surface as unavailable; explicit `retryPreparation(key, requestId)` resets a failed job
transactionally once per request ID. Cancellation stops the local wait, independently of hosted work.
Personal questions/notes must not enter this context. Use the canonical registered repository spelling
when building context so root and hosted context digests agree. `organizations()` returns actual active
organizations and deployed analysisVersion; `repositories(orgId, offset)` returns only currently
authorized configured repositories in bounded pages, without minting access from membership alone.

## Authorization and database

Apply `supabase/migrations/*.sql` to an agreed Supabase project. A trusted administrator provisions
organizations, active memberships and repository/install mappings. No desktop endpoint can self-enroll,
change those rows, issue grants or publish analyses. HTTP independently validates Supabase Auth `/user`,
the user's GitHub `/user` stable subject linked by Supabase, current membership and current GitHub
`/repositories/{id}` on every operation. User GitHub credentials travel only over HTTPS to this trusted
service; they are never persisted or logged. Issued database grants expire after 60 seconds. Direct
PostgREST RLS therefore has bounded grant freshness; use the HTTP API for per-operation revalidation.
Revoked membership/repository settings deny reads immediately in RLS. Canonical reviews are immutable;
progress/notes are separate user-scoped records with transactionally deduplicated write IDs/revisions.

Server service-role key and GitHub App private key are never sent to desktop. Use independent backend
secret management. No local CLI sign-in credential is accepted for shared preparation.

Repository commands `team:db:link`, `team:db:plan`, `team:db:migrate` and `team:db:history` use the
official Supabase CLI and tracked migration history. See [the operator workflow](../../docs/integration/team-setup.md#versioned-database-workflow).
The local SQL runner also covers disjoint tenants using the same repository ID, forged foreign
keys, membership revocation and multi-organization users with private per-user progress. Migration
004 corrects the bundle validator's timestamp-dependent volatility without changing access rules.

## Installed desktop facade and card

`apps/desktop/src/main/team/service.ts` exports `TeamService` and `TeamServiceOptions`; root supplies
user data directory, OS encryption, configuration, selected GitHub credential/account generation,
external browser opening and actual local candidate/apply ports. `renderer/team/index.ts` exports
`createTeamController(call)` and `TeamCard`. Root mounts the card, registers named `team.*` RPCs and owns
controller/service disposal. The component provides actual connection, organization creation,
repository registration/selection, exact source/patch/check review, sharing, author acceptance/decline,
and a separate local Apply confirmation. An actual applied receipt may include `jobId` for root's
`onReviewApplied(jobId)` hook; no readiness/acceptance state invents an applied result.

The facade persists selected shared scope per authenticated user/GitHub repository. `prepare` uses only
that selected scope and never silently substitutes a local shared result. Source-only schemas live in
`schemas.ts` and UI/facade DTOs in `desktop-schemas.ts`; neither module imports Node crypto or credentials.
Root alone promotes these to shared contracts and composes Settings, routers, source readers and local
runtime application. Missing configuration/ports produce explicit unavailable states.

Migration 003 adds idempotent organization creation and repository registration. Creators become active
owners. Registration requires that owner membership, a freshly verified matching GitHub identity with
repository administrator permission, and the actual active GitHub App installation for that repository.
Existing pre-onboarding organizations require an explicit operator-assigned owner. Membership management
for the proof of concept remains an explicit trusted administrative operation.

Migration 003 also revokes every authenticated/anonymous legacy and actor-overload share/decision write.
Only the server service role can call source-sensitive RPCs, with `p_actor` taken from the freshly
validated Supabase user, never request JSON. The database rechecks that actor's active organization and
repository grant, exact consent and stable request ledger. A user JWT cannot bypass current GitHub
head/feedback verification by calling PostgREST directly with a cached witness.

Private progress conflicts are durable. A 409 moves the unchanged original write into per-account
conflict history; flushing skips only that input key and continues independent reviews. Explicit discard
retains the original attempted notes/cursor/revision. Explicit replacement requires a new supplied
request ID and the same immutable key; no automatic rebase or identity regeneration occurs. Facade
`progressConflicts`, `resolveProgressConflict`, and `flushProgress` back the card's private conflict
reload/retry/discard controls. Final generation/user checks run after encrypted cache reads/writes, so a
late online or offline result cannot return another account's artifact as current.

## Executable hosting and exact proposal exchange

Run from a clean repository root with its supplied frozen manifests (`bun install --frozen-lockfile
--ignore-scripts` is sufficient for this standalone service; no Electron is needed):

```
bun services/team/entry.ts --help
bun services/team/entry.ts serve
bun services/team/entry.ts consume
bun services/team/entry.ts consume --once
```

Required environment is listed in `.env.example` and `--help`. `serve` requires Supabase URL/public and
server-role keys, GitHub App ID/private key, webhook secret and `TEAM_ANALYSIS_VERSION`. `consume` needs
the same database/App/version configuration and server `META_API_KEY`; it does not need a webhook secret.
Pin analysisVersion to the actual model/prompt/context-policy release on both services. Supabase Auth
must enable GitHub with registered provider credentials, selected project site settings and the desktop
numeric loopback redirect allowlist. Memberships and repository-to-installation mappings must be
provisioned by a trusted operator from verified Auth/GitHub identities. No open enrollment endpoint exists.

Host `serve` behind HTTPS with request limits and a secret store. Its default bind is numeric loopback;
`TEAM_HOST`/`TEAM_PORT` configure the supervised host. Optional `TEAM_ALLOW_LOCAL_SUPABASE=1` permits only
loopback HTTP for local Supabase development. `/health` is liveness only, not database/provider readiness.
Expose `/webhooks/github` to the GitHub App's **pull_request** events. Signature validation uses HMAC
SHA-256 over the bounded raw bytes before parsing. The registered enabled organization/repository/App
installation binding must match; duplicate delivery identities/digests are durable and fenced per org.

The consumer leases webhook records, obtains repository-scoped installation tokens, verifies the current
App installation/repository, and reads bounded pinned GitHub context through the existing real reader.
It stores approved repository context under the exact immutable input key, then leases preparation.
Preparation calls the existing real `prepareReview` and `AgentModelClient`/`MetaClient` ports. It rechecks
source authorization/context after model completion and publishes only under its unexpired fencing token.
A 30s heartbeat renews a 120s lease; lost ownership aborts local preparation. Five attempts with bounded
backoff become a durable visible failure. SIGTERM stops the consumer without inventing completion;
expired leases can be reclaimed. Run server and consumer under an external supervisor. No scheduler or
laptop needs to remain open for these supervised processes, but no hosting target has been deployed.

Concurrent delivery/request retries share one key/job/canonical artifact. A crash after an external model
call can cause another paid call on retry: this is **not exactly-once model billing**. Logs include only
fixed failure notices and model usage identities/counts, not prompts, repository bodies or secrets.

All `/v1/*` operations are POST with the separate Supabase bearer and main-only `X-GitHub-Token`.
Current review reads additionally recheck actual pinned context; changed descriptions or code revisions
return conflict. The request/status/retry, private progress, organization/repository discovery, and
proposal list/read/share/decide routes are implemented in `api.ts`. Direct PostgREST artifact reads do
not establish current-PR status; use the API/provider seam for current preparation.

`shareProposal({requestId,bundle,bundleDigest})` carries exact UTF-8 before/after source, unified patch,
source feedback ID/revision/body digest, base/candidate commits, command/output/check hashes, timestamps,
exit codes and environment attribution. It is capped at 40 files and 2 MB. Data lives inline in private
RLS-protected Postgres rows, avoiding public or stale signed object URLs. `reported-local-candidate`
means submitted local evidence; the service does not independently execute or attest those checks.
Sharing rechecks the exact current GitHub feedback and PR head. The author decision requires exact
proposal ID/digest, explicit confirmation, current head, matching provider author and current feedback.
An accept/decline event is separate from inspection, application, publishing and merging. No endpoint
applies patches, pushes, posts GitHub comments, approves reviews or merges PRs.

The client persists share/decision attempts before transport and retains uncertain responses. Use
`retryExchange(requestId)` explicitly to replay the original exact payload; it never auto-applies.
Durable receipts survive response loss and resolve exact previously recorded requests even after later
source movement; a new stale confirmation still rejects. Per-user share receipts are recorded even
when another authorized submitter already shared the same bundle. Original-thread GitHub delivery and
comment posting remain in the existing confirmed-comment ledger, outside this service.

## Offline validation

```
bun test services/team apps/desktop/src/main/team
bash services/team/test-sql.sh
bunx --no-install tsc --noEmit --target ES2022 --module ESNext --moduleResolution bundler --esModuleInterop --strict --skipLibCheck --types node services/team/*.ts apps/desktop/src/main/team/*.ts
bunx --no-install biome check services/team apps/desktop/src/main/team
```

The SQL runner uses an ephemeral PostgreSQL 17 Docker container with no published ports, Supabase auth
role stand-ins, and controlled users. It applies the actual migrations and exercises two-user RLS,
private progress, expiring/revoked grants, immutable/deduplicated bundles, explicit author decisions,
share/decision retry identity and leased queue fencing/recovery. Unit tests use actual prepareReview
with controlled model/GitHub transports, exact-context rejection and main account/outbox fencing.
It does not establish hosted Supabase Auth, real user consent or live GitHub grants. Unit transports
are explicitly controlled. No combined Electron/native/microphone launch is part of these checks.

Protocol references: [Supabase PKCE](https://supabase.com/docs/guides/auth/sessions/pkce-flow),
[Auth REST schema](https://github.com/supabase/auth/blob/master/openapi.yaml),
[GitHub webhook signatures](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).
