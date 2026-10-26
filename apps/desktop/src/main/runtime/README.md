# Runtime service integration

Create one `RuntimeService` after Electron is ready. The integration lane registers
`createRuntimeRouter(() => runtime)` under `runtime` and awaits `runtime.dispose()`
before closing the database during shutdown.

```ts
const runtime = new RuntimeService({
  userDataPath: app.getPath("userData"),
  fixturesPath: app.isPackaged
    ? join(process.resourcesPath, "demo")
    : resolve(repositoryRoot, "fixtures/demo"),
  encryption: safeStorage,
  createPreviewPage: createElectronPreviewPage,
  submissionLedger: database.runtime,
});
```

`prepareDemo()` materializes two local Git repositories and detached base/head
worktrees, returning actual `PullRequest` contracts. Demo PR IDs match
`demo/shop-web#1284` and `demo/finance-service#412`. The URLs use example.invalid:
these are seeded local PRs, not published GitHub PRs. Source/diff reads use the
committed revisions. Fixture bugs are intentional and must remain.

Renderer RPCs include credential status/set/delete, GitHub CLI token import,
account/review-request reads, demo preparation, changed files, source/diff,
scenarios A–D, preview start/stop, and cancellation. No secret getter, arbitrary
command execution, or GitHub posting endpoint is exposed. Settings may send a
user-entered key once; it must clear the input and never persist it in renderer
storage. CredentialStore uses Electron 40 safeStorage, whose encryption keys use
macOS Keychain, plus an atomic 0600 encrypted file. Plaintext fallback is rejected.

Main-only ports:

- `runtime.credentials.get(provider)` for agent/voice key injection.
- `runtime.prepareGitHub(pr, localClone?, signal)` for actual GitHub worktrees.
- `runtime.getPrepared(prId)` supplies `{pr, worktrees}` to agent tools.
- `runtime.scenarios.runBuilds(...)`, `runScenario(...)`, `runGeneratedTest(...)`.
- `runtime.github.postConfirmedComment(pr, authoritativeDraft, confirmation)`.
  This compares exact body, revision, location, and current GitHub head, and uses
  SQLite to deduplicate submissions across restarts. Ambiguous network writes
  require inspection before a new confirmation; they are never silently retried.
- `pollReviewRequests(...)` supplies bounded sequential polling and a stop handle.

Each execution has a UUID, timeout, capped logs, SHA-specific source locations,
and a shared execution-evidence object. Generated tests run as `.mjs` in both
owned worktree roots with Node type stripping, then only those temporary files
are removed. The trace protocol is one JSON object per stdout line:

```text
METAHACKATHON_TRACE {"id":"step","file":"pricing/applyDiscounts.ts","line":16,"label":"Observed branch","values":{"total":72},"outcome":"return"}
METAHACKATHON_RESULT {"total":72}
```

Trace files must be tracked in the pinned checkout. The line number must exist.
`value` maps to shared `continue`; other outcomes are `continue`, `return`,
`throw`, and `stopped`. Outputs exceeding the capture limit fail explicitly.
These processes execute reviewed repository code with a stripped environment;
they are not an OS sandbox for hostile programs.
Tracked source and HEAD are checked before and after execution; trace locations
are checked against the committed blob. Source mutation fails attribution and
preserves the worktree for inspection. `runBuilds` rejects interrupted/truncated
runs even when a signal handler exits 0. Scenario evidence retains the actual
child exit code together with the run's timed-out/cancelled status. The runner
tracks direct main-only calls too, so service disposal aborts and awaits them
before cleaning worktrees.

Preview uses an OS-assigned loopback port and checks its UUID with a separate
readiness process. The evidence's exit code is that completed probe's actual
exit code; the server remains live until stop/dispose. The isolated Electron
page has no preload, Node, persistent cookies, or granted permissions. Marker
bounds are measured from the rendered DOM in document CSS pixels, at 390×640
or 1024×768. UI must use the same viewport and subtract scroll offsets for overlays.
When switching viewport, stop the old preview and request a new measured one.

Validation from the repository root:

```sh
bun test apps/desktop/src/main/runtime
bun run type-check
bun run lint
bun run test:contracts
bun run build
bunx esbuild apps/desktop/src/main/runtime/smoke-electron.ts --bundle --platform=node --format=cjs --external:electron --external:better-sqlite3 --outfile=apps/desktop/out/runtime-smoke.cjs
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron apps/desktop/out/runtime-smoke.cjs
```

The standalone Electron smoke writes a `report.json` and logs in its own temporary
directory, checks actual scenario C, DOM measurements, closed ports, finance SQL
dependency, safeStorage, and SQLite limits. Set `METAHACKATHON_VERIFY_GITHUB=1`
to also test authenticated GitHub read access using the existing gh login. It
posts no GitHub comments. Live posting, voice integration, signed distribution,
and updating between signed releases require separate integrated verification.
