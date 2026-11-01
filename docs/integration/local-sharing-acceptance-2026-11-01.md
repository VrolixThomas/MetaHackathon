# Desktop Muse preparation and MuseFocus acceptance — 2026-11-01

Application source: `d286e2d90aceb67fceae6bfc4f3a80a59f7c62be`. Later documentation changes do not
alter that accepted application payload. [Structured evidence](evidence/local-sharing-2026-11-01.json).

## Result

Reviews prepare from the desktop through the Muse API and persist locally. An optional authorized
shared cache can avoid another model call. A miss or unavailable sharing still performs local
preparation, followed by bounded best-effort publication. The first valid shared publisher wins;
publication errors/races preserve the user's successful local report. Inference remains inference.

Supabase project `vmydpscnfgvbciotoaln` has migrations 001–006 and only `muse-team-api` deployed.
Its health returns configured/200 without App/model credentials. Anonymous sharing requests return
401 and the retired hosted-queue route returns 410. Worker/webhook endpoints return 404; their
functions and custom secrets were removed. Cron is disabled with zero Muse jobs. No hosted model
call telemetry was measured; the active API has no preparation-model execution path.

Exact proposed fixes remain inspectable before author decision and separate local application.
Application uses real isolated Git/checks and opens the actual result in Completed work. Acceptance
and application do not implicitly post, publish or merge.

## Verification

- Frozen install, type-check, lint and root build pass. Full unit suite: **1816 passed, 13 skipped,
  zero failed** across 186 files. Skips are not counted as verified native behavior.
- Real isolated PostgreSQL applies all six migrations and passes tenant/RLS, current source,
  immutable first-writer publication and actor/request-ledger checks.
- Native Electron local-preparation mode passes six phases with actual UI, IPC, OS-encrypted login,
  SQLite and the real MetaClient over controlled HTTP: one model preparation and one exact
  publication, source display, proposal review/decision, actual Git/check application and disconnect.
- Native cache-reuse mode passes the same six phases with zero model calls/publications. Navigation
  controls now wait for the preceding workspace display acknowledgement; the fast source-tab change
  that formerly returned to Home passes the actual native check.
- Native V1 conversation passes empty startup, history and late-result cancellation with a simulated
  model. It records no microphone and does not verify live speech.
- A separate **live GitHub + Muse** probe prepares all four changed files in
  `VrolixThomas/duckdemo#2`, base `9f707f6abb0ca135532531ecf0dd9aab225c6668`, head
  `9bfff2421846732f23d7bb8347f7afd55eb62fa6`, once through the actual TeamService/local callback
  with sharing unconfigured. This probe has no native renderer and posts no comments.
- Thirteen offline packaging-policy checks pass. The actual Apple Silicon unsigned MuseFocus DMG
  and ZIP build and pass production payload checks, including SDK 1.4.14, native SQLite and 274
  arm64 voice Mach-O files. Output is ignored local evidence, not a signed release.

## MuseFocus release setup

Product/bundle identity is **MuseFocus** / `app.musefocus.desktop`; the window, menu and About panel
use the new name. The existing MetaHackathon data directory and encryption identity are retained;
isolated/custom profiles remain respected. Signed upgrade/keychain/TCC compatibility still requires
an actual signed installed-app check.

The release workflow supports the same five signing inputs and SuperiorSwarm aliases. See
[Apple setup](../../apps/desktop/packaging/README.md#operator-checklist). This Mac reports zero valid
code-signing identities, so Developer ID signing/notarization has not run. The planned
`musefocus.app` domain is not configured; no callback/feed URL was moved to an unowned domain.
The local unsigned package was not launched or published and cannot prove installed voice or updates.
The GitHub `release` environment has been created; its environment-secret list is empty. Existing
organization-level secret availability was not established, and no signing credentials were copied.

## Remaining external checks

Supply a Developer ID Application certificate including its private key/export password, matching
Team ID, Apple account email and app-specific notarization password in the repository's `release`
environment. Then run the signed candidate and installed microphone/update checks. Complete one
real two-user Supabase findings/proposal exchange with matching GitHub identity/access. Live speech,
image generation and GitHub posting were not rechecked by this increment.

## Launch the integrated source

```sh
cd /Users/Werk/Documents/Repositories/MetaHackathon-worktrees/integration
bun run --filter @metahackathon/desktop preview
```

The build is current; development uses the existing main checkout `.env`. Use `bun run build` after
later source edits. No Supabase worker, App installation or remote model credential is needed.
