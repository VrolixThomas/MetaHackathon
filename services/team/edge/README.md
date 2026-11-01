# Supabase Edge adapters (MET-72 / MET-73 / MET-41)

These adapters retain Supabase Auth/Postgres and the existing team implementation. They do not
import `services/team/entry.ts`, start a Bun server, or run a perpetual consumer. Source files are
not deployment bundles: root owns the reproducible Bun build, function config and deployment.

## Exports and build contract

| Build input | Root-generated deployment entrypoint |
| --- | --- |
| `services/team/edge/muse-team-api.ts` | `supabase/functions/muse-team-api/index.ts` |
| `services/team/edge/muse-team-webhook.ts` | `supabase/functions/muse-team-webhook/index.ts` |
| `services/team/edge/muse-team-worker.ts` | `supabase/functions/muse-team-worker/index.ts` |

Each input invokes `startEdge(factory, background?)`. Root should bundle ESM with Bun, resolve
extensionless/directory imports and the repository's existing pinned Zod, and retain supported
`node:*` imports for the Deno runtime. No new package is needed. Do not overwrite source with the
bundle. Build commands/manifests/config.toml and generated deployment outputs are root-owned.

Reusable factories (no startup side effects):

- `api.ts`: `createTeamApiHandler(env: EdgeEnvironment, ports?: EdgePorts): EdgeHandler`.
- `webhook.ts`: `createTeamWebhookHandler(env, ports?): EdgeHandler`.
- `worker.ts`: `createTeamWorkerHandler(env, ports?: WorkerPorts): EdgeHandler`.
- `http.ts`: `EdgeHandler = (request: Request) => Promise<Response>`;
  `EdgePorts = {fetch?, signal?, maxRunMs?}`. `signal` is the shutdown signal; `maxRunMs` can only
  shorten the default/hard maximum **100,000 ms**, below the requested 110-second ceiling.
- `WorkerPorts` adds `waitUntil(promise)`, optional numeric `recordOutcome(httpStatus)`, optional
  existing `UsageRecord` observer and the controlled `createConsumer(options)` test port.

The runtime uses `Deno.serve`, reads `Deno.env.toObject()` only at startup, explicitly supplies
the Node-compatible `Buffer` global for existing services, and aborts work on `beforeunload`.
The worker entrypoint requires `EdgeRuntime.waitUntil`. API/webhook only await the request.

The import graph reuses `createTeamApi`, `TeamAccess`, `SupabaseRest`, `HostedGitHub`, `MetaClient`,
`TeamConsumer`, and the original raw HMAC verifier. `HostedGitHub` currently imports the canonical
desktop HTTP reader, whose module imports `node:child_process` for an unused CLI fallback.
HostedGitHub injects a rejecting CLI reader; no subprocess is authorized here. Root must prove that
graph loads in the actual Edge runtime or supply a build-time fail-closed shim for the unused CLI
import. Bun-only units do not prove Deno compatibility. The finite `TeamConsumer.maxRunMs` and
caller-signal ports are a separate peer handoff and must be integrated before deployment.

## HTTP boundaries

Only exact leading `/<function-name>` or `/functions/v1/<function-name>` segments are stripped.
Bare service paths also work for direct handler probes. Similar names, unrelated prefixes and
unknown paths return 404; the adapter does not decode path segments or strip arbitrary prefixes.
Query strings, headers and raw body bytes survive URL adaptation. Every response has `no-store`
and `nosniff`. `GET <function>/health` reports **configuration presence/validity only**, without
provider calls or credential values. `configured` is not a live readiness/completion assertion.

| Function | Action |
| --- | --- |
| `muse-team-api` | POST to the existing explicit `/v1/organizations`, `/v1/repositories`, `/v1/reviews/*`, `/v1/progress/*`, `/v1/proposals/*` operations enumerated in `api.ts`. Requires user `Authorization: Bearer …` plus `x-github-token`; delegates all fresh issuer/identity, tenant, repository, revision and RLS checks to the existing API. Unknown `/v1` operations are rejected before dispatch. |
| `muse-team-webhook` | POST to the function root (also exact `/webhooks/github`). Requires the original `x-hub-signature-256` HMAC. The existing verifier bounds original bytes at 1,000,000, authenticates before parsing/enqueueing, and retains scoped durable delivery identity. |
| `muse-team-worker` | POST to the function root, `Content-Type: application/json`, `Authorization: Bearer <TEAM_WORKER_INVOKE_SECRET>`, exactly `{"queue":"webhook"}` or `{"queue":"preparation"}`. Body limit 1,024 UTF-8 bytes. Other keys, queues, methods and paths are rejected. |

Root sets `verify_jwt = false` for these functions. This does not remove application auth:
API actions still validate both user credentials freshly; webhooks require the original HMAC;
worker actions require their dedicated secret, compared through fixed-size hashes with
`timingSafeEqual`. A publishable/anon key, service-role key or ordinary user JWT cannot serve as
the configured dedicated trigger secret. Health contains no action or protected source data.

Absent/invalid configuration yields safe 503 with fixed setting names. Unknown provider failures
are sanitized. No App ID, repository binding, model response or review is fabricated.

## Server-only configuration

| Setting | Required by / mapping |
| --- | --- |
| `SUPABASE_URL` | All; HTTPS origin only. `TEAM_SUPABASE_URL` may explicitly override. |
| `SUPABASE_SERVICE_ROLE_KEY` | All; backend-only legacy service-role JWT or modern `sb_secret_` key. `TEAM_SUPABASE_SERVICE_ROLE_KEY` may override; injected `SUPABASE_SECRET_KEYS.default` is also supported. Modern keys use only the apikey header; user JWTs remain separate. |
| Public key | API: first `TEAM_SUPABASE_PUBLISHABLE_KEY`, then `SUPABASE_PUBLISHABLE_KEY`, then injected `SUPABASE_PUBLISHABLE_KEYS` JSON's `default`, then legacy injected `SUPABASE_ANON_KEY`. User JWT remains the REST Authorization header. |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | API and worker; actual numeric App ID and parseable RSA private key. Escaped PEM newlines are accepted. OAuth identity login does not create an App installation. |
| `TEAM_ANALYSIS_VERSION` | API and worker; explicit shared analysis identity. |
| `GITHUB_WEBHOOK_SECRET` | Webhook only; raw payload HMAC secret. |
| `TEAM_WORKER_INVOKE_SECRET` | Worker only; separate 32–4,096 character high-entropy secret, different from known database/public/model/webhook keys. Root stores the matching trigger credential in Vault/scheduler configuration. |
| `MODEL_API_KEY` or `META_API_KEY` | Worker only; existing server-side Muse inference key, first nonempty wins. No subscription/desktop coding credentials. |

Use injected Supabase variables or the explicit `TEAM_` aliases; root must not upload an entire
development `.env` or attempt to set reserved `SUPABASE_` names. Privileged keys remain in Edge
environment only, never client configuration/responses. Separate function names do not provide
secret isolation within the project. Secrets, registration, installation and credential checks
are root-owned external gates.

## Finite background execution and recovery

The deployed worker authenticates, validates config and reads the small body before returning
**202 accepted** and passing **one selected queue tick** to `waitUntil`. The background task has
its own live timer using only the invocation's remaining 100-second budget; returning 202 does
not clear or extend it. Accepted work survives the HTTP caller disconnecting, while runtime
shutdown still aborts it. Before acceptance, request cancellation stops admission. For controlled
tests, omitting `waitUntil` awaits the same bounded tick and returns `idle` or `attempted`.

The tick receives `maxRunMs` and an abort signal. All transport calls and streamed reads are also
scoped to that signal, including older service paths without explicit signal parameters. A
70-second maximum model budget (less when time was spent on admission) leaves 30 seconds for
source/authorization revalidation and database settlement within the total cap. Heartbeat,
claim/renewal, fencing and lease recovery remain the existing consumer/Postgres implementation.
Deadline/shutdown cannot publish a later success through this adapter. A task killed after claim
leaves durable work for expiry recovery; shutdown callbacks are best effort.

202 proves acceptance only. `attempted` includes handled failure, and logs record only a fixed
numeric HTTP outcome plus the existing model usage records. The durable database job/artifact
state is completion authority. This adapter adds no invocation retry loop or scheduler.

Practical background requirements: root must deploy all three bundles, provide actual App/model
credentials and an authorized App installation, and enable periodic calls for **both** queue
selectors. Cron uses its dedicated Vault trigger secret and a short HTTP timeout because the
worker acknowledges promptly. Cron must keep scanning queued/expired work after lost calls or
killed functions; `waitUntil` does not extend platform execution limits or guarantee completion.
Monitor the durable backlog and failed attempts. A repeated paid model call after an ambiguous
interruption remains possible even when the final artifact is deduplicated. Desktop coding
worktrees/CLI jobs are not moved into these functions.

## Local controlled validation / limitations

`bun test services/team/edge/edge.test.ts` exercises real service authorization over controlled
fetch, exact prefix routing and UTF-8 HMAC bytes, unauthenticated rejection, missing/invalid
config, bounded queue parsing, one real idle claim, one selected tick, 202 admission, shutdown,
request cancellation, hard deadline and late transport/body cancellation. It uses generated
local RSA keys and inert test credentials, with no network, cloud, native app or live provider.

Root owns final bundle/import/crypto/SSE probes in the actual Supabase runtime, integrated peer
deadline/lease checks, max-size CPU/memory measurements, config/build/deploy/secrets/cron migration,
desktop service-URL prefix support and installed-app/two-user/provider acceptance. Local tests
do not establish that a full real preparation fits the hosted plan, live GitHub delivery, a
deployed scheduler or production availability.
