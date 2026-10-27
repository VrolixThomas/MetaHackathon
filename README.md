# MetaHackathon

A macOS workspace for investigating GitHub pull requests by conversation. A compact transcript
sits alongside the main browser, code, scenario or diagram surface. The agent observes and
operates the same persistent browser page the reviewer sees. Desktop is the default viewport;
phone is available on request. GitHub comments always require explicit confirmation.

## Built during the hackathon

The starting point was the committed Electron/React foundation at `d903951`. Work added on
`hack/integration` includes:

- Typed Zod contracts for PR review, Why provenance, artifacts, confirmed comment inputs,
  agent polling, generated tests, credentials and pinned source reads.
- Deterministic illustrative data and runnable shop/finance repositories containing the
  intended promo regression, cache, checkout change and schema dependency.
- Owned PR worktrees, bounded process execution, SHA-bound scenario traces, measured local
  previews, encrypted credentials and durable submission records.
- Root tRPC/runtime lifecycle composition, packaged update checks and reproducible native
  Electron IPC validation. UI, agent and voice lane integration is tracked in Linear.

## Stack

Direct dependency versions are pinned to the versions resolved in SuperiorSwarm's `bun.lock`
at setup time.

| Layer | Setup |
| --- | --- |
| Desktop | Electron 40.8.5, electron-vite 4.0.1, Vite 6.4.1 |
| UI | React 19.2.4, Tailwind CSS 4.2.2, PostCSS |
| Language | TypeScript 5.9.3 with shared strict configs |
| State and queries | Zustand 5.0.12, TanStack Query 5.95.2 |
| RPC | tRPC 11.16.0 over a context-isolated Electron IPC bridge, SuperJSON, Zod |
| Database | SQLite with better-sqlite3 12.8.0 and Drizzle ORM 0.45.2 |
| Tooling | Bun workspaces, Turborepo 2.8.21, Biome 1.9.4 |
| Packaging | electron-builder 26.8.1, electron-updater 6.8.11, macOS DMG and ZIP |

TanStack Router is also installed to match SuperiorSwarm's dependencies. Zustand stores and
navigation can be added when features need them. Product-specific dependencies such as
Monaco, terminal/PTY tooling, OAuth integrations, and Supabase are omitted.

## Development

Use Node.js 22.12 or newer and Bun 1.3.9. SuperiorSwarm declares Bun 1.1.38 in its manifest;
this project uses the locally verified Bun 1.3.9 to support its text lockfile and explicit
hoisted workspace installs.

```sh
bun install
bun run dev
```

Installation rebuilds better-sqlite3 for Electron's native ABI. Native compilation may require
the platform's compiler tools (Xcode Command Line Tools on macOS). To repeat that rebuild,
run `bun run --filter @metahackathon/desktop postinstall`.

```sh
bun run type-check
bun run lint
bun run test:contracts
bun run test:integration
bun run build
bun run format
```

`bun run build` writes the main process, preload, and renderer to `apps/desktop/out`.
To run that production build locally, use `bun run --filter @metahackathon/desktop preview`.

Use `hack/integration` for the combined application; the other branches feed implementation
handoffs into it. On this machine the launch checkout is
`/Users/Werk/Documents/Repositories/MetaHackathon-worktrees/integration`.
Load the local demo once, then use the conversation or hold-to-talk control:

1. “Walk me through this PR.”
2. “Show me the checkout.”
3. “Apply the promo code.”
4. “Show it on a phone.”
5. “Scroll to the payment button.”
6. “Show me the code responsible.”
7. “Compare what happens before this PR.”

Typed agent turns require a Meta key in Settings. Browser controls, pinned source reads and
local scenario execution work without provider credentials. For speech, install the pinned
Python environment once (Python 3.13), then save Meta/ElevenLabs keys and a voice ID in Settings:

```sh
python3.13 -m venv services/voice/.venv
services/voice/.venv/bin/python -m pip install -r services/voice/requirements.lock
```

Choose Prepare voice and wait for Ready before capture. Local startup can take up to three
minutes on the first launch; readiness does not prove live provider entitlement. Keys remain
in the OS-encrypted main-process store. `METAHACKATHON_VOICE_PYTHON` can select an existing
Python executable; `ELEVENLABS_VOICE_ID` supplies an optional default public voice identifier.
Interruption stops audio and cancels the active agent/voice turn. Closing the review window
shuts down its browser, voice sidecar, preview servers and owned worktrees.

## Layout

```text
apps/desktop/
  src/main/          Electron lifecycle, SQLite, and the tRPC root router
  src/preload/       Narrow, context-isolated IPC bridge
  src/renderer/      Review workspace, artifacts and typed service adapters
  src/shared/        Validated review contracts, deterministic fixtures, IPC types
tooling/typescript/  Shared strict TypeScript configs
```

The preload compiles to CommonJS (`index.cjs`) for Electron's sandbox. Node integration is
disabled in the renderer. IPC is restricted to the app window's main frame.

The app creates `metahackathon.db` in Electron's per-user application data directory, including
runtime submission and budget records.
Add tables in `apps/desktop/src/main/db/schema.ts`, then generate migrations with
`bun run --filter @metahackathon/desktop db:generate`. Generated migrations are copied into
build output; add migration execution before introducing additional schema-managed tables.

## Shared contracts and lane bootstrap

See [AGENTS.md](AGENTS.md) for ownership, ticket mapping, handoff requirements and interface rules.
Zod schemas and inferred TypeScript types live in `apps/desktop/src/shared/contracts/`.
`apps/desktop/src/shared/fixtures/review.ts` exports `getReviewFixture()` and its validation schema.
It returns fresh, deterministic examples for PR preparation, triage, recorded/inferred Why notes,
screen context, agent actions, scenario C, diagrams, phone preview markers, comment drafts and
confirmations, voice state and cancellation.

The registered `bootstrap.contract` query describes the contract version and fixture IDs.
`bootstrap.fixture({ fixtureId: "shop-web-promo-v1" })` returns the bundle over the existing
typed tRPC client and isolated preload bridge. Both inputs and outputs are validated.
There are no subscriptions yet; lane routers and event transport are registered by integration.

All sample evidence is explicitly marked `fixture`. The source URLs, commit hashes, code lines
and marker bounds are illustrative. Fetching a fixture does not execute a scenario, start a
preview server, access a microphone or post a GitHub comment. Real execution evidence requires
a run ID, full commit SHA, command, timestamps, exit code and log URL. Posting requires a
separate explicit confirmation of the exact draft revision, body and PR head.

## Integrated runtime validation

The `runtime` router exposes local demo preparation, pinned source/diff reads, scenario A–D
execution, measured phone/desktop previews, credential status/set/delete and GitHub reads.
The runtime starts after Electron is ready and disposes its processes/worktrees before the
database closes. Credentials remain in the main process; there is no secret getter or raw
command RPC. See [runtime integration ports](apps/desktop/src/main/runtime/README.md).

`bun run test:integration` builds and launches the actual app with temporary user data, calls
these routes through the sandboxed preload bridge, checks scenario C and preview geometry,
and verifies that app shutdown closes the remaining preview and removes owned seed repositories.
The report is written to `apps/desktop/out/integration-smoke-report.json`. These are real local
executions of seeded repositories. The check does not use provider credentials, voice, or
GitHub comment writes. Signed distribution and real upgrades require separate verification.

The `agent`, `review`, `artifacts` and `screen` routers provide main-process turns, preparation,
catalog lookup and ordered screen updates. Preparation includes bounded, verbatim source
excerpts pinned to repository/SHA/line ranges, so the model receives code as well as triage
metadata. Excerpts do not claim recorded intent or execution. Without a configured Meta key,
the native check verifies acknowledgement and the explicit setup error without an external call.

The `browser` router owns one visible page per review session and exposes validated navigation,
observation, click, type, scroll and viewport commands. It restricts the page to its owned preview
origin. Ref-based actions reject stale observations. The `voice` router adds readiness/setup and
the generation-aware speech pipeline. Scripted-provider acceptance tests exercise real local
browser/scenario results but are separate from live microphone, STT, model and TTS verification.

## Local packaging

On macOS:

```sh
bun run pack  # Signed unpacked .app; requires signing credentials
bun run dist  # Signed/notarized DMG and ZIP; requires release credentials
```

Artifacts are written to `apps/desktop/dist`. For a local unsigned development probe, build
the app and use the explicit unsigned profile:

```sh
bun run build
cd apps/desktop
METAHACKATHON_UNSIGNED_LOCAL=1 bunx --no-install electron-builder --config electron-builder.unsigned.yml --mac --dir --publish never
```

See [packaging instructions](apps/desktop/packaging/README.md) for local probes and release
gates. Ad-hoc/local validation is separate from Developer ID, notarization and signed-update
acceptance. Publishing is disabled during builds.
