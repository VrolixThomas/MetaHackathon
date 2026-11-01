# Open-feature acceptance — 2026-11-01

All three Codex-only SuperiorSwarm workstreams were followed through review and integration from
published `42b40f2`. Functional code checkpoint: `39e75ad`; native test cleanup: `8d8ef57`.
Ownership, reservations and handoffs are on MET-8. The app remains standalone from SuperiorSwarm.

## Implemented

- Conversational PR comment inspection/drafting/editing uses the actual canonical composer. A new
  explicit user confirmation authorizes the exact body/revision/head. Voice additionally waits for
  proposal playback. Cancellation, stale heads and uncertain posting retain their existing guards.
- Raster generation uses a configured Gemini provider, private validated PNG/JPEG storage and
  decoded, acknowledged image canvases. Saved images reopen through Recent without regeneration.
  Missing image credentials affect image generation only. The fixed API URL matches Google's
  [documented REST endpoint](https://ai.google.dev/gemini-api/docs/generate-content/image-generation).
- Team sign-in, organization/repository onboarding, immutable shared preparation, private progress,
  offline conflict handling and an executable GitHub App webhook/leased consumer are integrated.
  Source-sensitive requests verify current user and repository permission. The consumer can run
  independently of desktops after deployment.
- Shared suggested fixes show exact highlighted before/after, patch, revision and reported checks.
  Author acceptance, local application, review and publication are separate actions. Explicit apply
  verifies original bytes in an isolated checkout, runs real repository checks and adds the actual
  result to Completed work. It neither pushes nor merges. No submitted check command is executed.
- The official Muse Code subscription adapter and opt-in live acceptance harness are available.
  Provider choice persists with jobs. The real CLI probe requires sign-in before coding can start.
- Production packaging includes the frozen voice payload, coding SDK/child and native SQLite;
  demo repositories, environment files and test reports/screenshots are excluded.

## Verification

Type-check, lint and build pass. Full unit run: **1708 passed, 13 skipped, 0 failed** across 177 files.
The skipped tests require Electron SQLite; native suites exercise actual SQLite separately.
Isolated PostgreSQL migrations, access policies, queue leases and service-role restrictions pass.

Native Electron suites pass for conversational comments, raster generation/reopen/cancellation,
Team login/shared-plan reuse/proposal/application, empty V1 conversation/history/cancellation,
executive workers and hands-free interruption. The Team flow runs actual Git and `npm run test`,
opens the applied diff and preserves the original dirty source. Product SQLite closes before the
test removes its profile. [Compact machine-readable evidence](evidence/all-features-2026-11-01.json)
records the scope of each check.

These are actual application/IPC/rendering/local-runtime checks with **controlled provider HTTP,
model, STT and TTS inputs**. They do not establish live microphone/provider behavior, live GitHub
posting, a deployed cloud service or two real users sharing data.

Actual screenshots from the controlled Team acceptance:

- [Exact suggested fix, syntax-highlighted before/after and patch](screenshots/team-proposal-controlled-2026-11-01.png)
- [Applied work, actual successful check and local diff](screenshots/team-application-controlled-2026-11-01.png)

Unsigned arm64 DMG/ZIP construction and payload verification passed in
`apps/desktop/dist/acceptance-unsigned-1793493561894/`. These are local artifacts; packaged-app
launch, installed microphone behavior, signing, notarization and updater installation are unverified.

## External acceptance still pending

- Supabase project selection, hosting, server secrets/GitHub App installation and two real test users.
  No project has been provisioned or source uploaded. Follow [team setup](team-setup.md).
- `IMAGE_PROVIDER=gemini` and `GEMINI_API_KEY` for live raster generation.
- Muse Code CLI sign-in and subscription availability for the live coding/question/resume check.
- Developer ID identity, Apple notarization credentials and installed-app/update acceptance.
- User-driven live speech and confirmed real GitHub posting checks.

## Launch

Use the integration checkout for the combined app:

```sh
cd /Users/Werk/Documents/Repositories/MetaHackathon-worktrees/integration
bun run --filter @metahackathon/desktop preview
```

Development reuses the existing main-checkout `.env`; no keys were copied into commits. Team and
image credentials are optional for ordinary local conversation/review. The full roadmap's hosted
company brain and multi-device worker scheduling are outside this six-feature increment.
