# Shared team review service (MET-72, MET-73, MET-41)

These modules are real Supabase/PostgREST adapters and executable migration paths. No project is
selected, no migration is deployed, and no product fixture fallback exists. Root owns desktop
composition, shared DTO publication, manifests and combined acceptance. Lane-local protocol schemas
are in `services/team/protocol.ts` and reuse the existing PreparedReview contract.

## Desktop composition

Construct `EncryptedTeamStore` with separate user-data paths for session and private cache and inject
Electron `safeStorage` after app ready. Construct `TeamAuth` with `SUPABASE_URL` and the Supabase
**publishable** (or legacy anon) key. Never pass a service-role key, GitHub access token or coding
subscription credential as the Supabase session. GitHub/Linear/Slack credential stores remain separate.

`beginLogin(loopbackOrigin)` returns a Supabase GitHub PKCE authorize URL. Root opens it externally and
runs a temporary listener on the given numeric loopback origin. Forward only matching
`/team-auth/<random nonce>?code=...` callbacks to `finishLogin`; callbacks expire after five minutes and
are single-use. Register the numeric loopback callback wildcard for this dedicated port in Supabase
Auth redirect allowlist. The listener must bind `127.0.0.1`, close after success/cancel, and not log query
strings. `status()` returns only connection/user metadata. Session refresh is serialized, validated for
the same Supabase user, and fails closed. Only OS-encrypted storage holds refresh tokens.

`TeamClient` takes service HTTPS URL, `TeamAuth`, main-only `getGitHubToken`, encrypted cache and optional
injected fetch. `load(key)` returns `current`, `pending`, or `offline-cache`. Offline cache is historical
and cannot establish present source authorization/display. A forbidden response never uses cache.
`saveProgress` durably records a stable exact write before sending; `flushProgress` replays it after
reconnect. Conflicts require explicit reconciliation, never silent overwrite. Cache is account scoped.
`TeamPreparationProvider.lookup(context)` is the root review-provider seam: it derives the exact
immutable key from approved repository-only context and returns an existing prepared review or null;
it rejects offline data as current preparation. Personal questions/notes must not enter this context.

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

## Offline validation

```
bun test services/team apps/desktop/src/main/team
bash services/team/test-sql.sh
bunx --no-install tsc --noEmit --target ES2022 --module ESNext --moduleResolution bundler --esModuleInterop --strict --skipLibCheck --types node services/team/*.ts apps/desktop/src/main/team/*.ts
bunx --no-install biome check services/team apps/desktop/src/main/team
```

The SQL runner uses an ephemeral PostgreSQL 17 Docker container with no published ports, Supabase auth
role stand-ins, and controlled users. It applies the actual migrations and exercises RLS/transactions.
It does not establish hosted Supabase Auth, real user consent or live GitHub grants. Unit transports
are explicitly controlled. No combined Electron/native/microphone launch is part of these checks.

Protocol references: [Supabase PKCE](https://supabase.com/docs/guides/auth/sessions/pkce-flow),
[Auth REST schema](https://github.com/supabase/auth/blob/master/openapi.yaml),
[GitHub webhook signatures](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).
