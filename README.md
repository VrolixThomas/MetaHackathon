# MetaHackathon

A voice-enabled macOS workspace for investigating GitHub pull requests. The committed Electron
foundation currently opens an empty window. The integration bootstrap adds shared validated
contracts and a fixture-only tRPC router so feature lanes can build in parallel.

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
| Packaging | electron-builder 26.8.1, macOS DMG and ZIP |

TanStack Router is also installed to match SuperiorSwarm's dependencies. Zustand stores and
navigation can be added when features need them. Product-specific dependencies such as
Monaco, terminal/PTY tooling, OAuth integrations, Supabase, and updater services are omitted.

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
bun run build
bun run format
```

`bun run build` writes the main process, preload, and renderer to `apps/desktop/out`.
To run that production build locally, use `bun run --filter @metahackathon/desktop preview`.

## Layout

```text
apps/desktop/
  src/main/          Electron lifecycle, SQLite, and the tRPC root router
  src/preload/       Narrow, context-isolated IPC bridge
  src/renderer/      Empty React app with tRPC and TanStack Query providers
  src/shared/        Validated review contracts, deterministic fixtures, IPC types
tooling/typescript/  Shared strict TypeScript configs
```

The preload compiles to CommonJS (`index.cjs`) for Electron's sandbox. Node integration is
disabled in the renderer. IPC is restricted to the app window's main frame.

The app creates an empty `metahackathon.db` in Electron's per-user application data directory.
Add tables in `apps/desktop/src/main/db/schema.ts`, then generate migrations with
`bun run --filter @metahackathon/desktop db:generate`. Generated migrations are copied into
build output; add migration execution before introducing tables that the app uses.

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

## Local packaging

On macOS:

```sh
bun run pack  # Unpacked .app
bun run dist  # DMG and ZIP
```

Artifacts are written to `apps/desktop/dist`. The initial configuration builds unsigned local
artifacts and disables publishing. Configure app identity, icons, signing, and notarization
in `apps/desktop/electron-builder.yml` before distributing the app.
