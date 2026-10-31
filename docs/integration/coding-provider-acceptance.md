# Muse Code subscription workers

Implementation checkpoint: `bdfaf06`. Coordination: MET-8, Voice-first PR review.

Users can choose **Settings → Background coding provider → Muse Code subscription**, save,
open the official CLI sign-in and refresh status. `CODING_PROVIDER` and optional absolute
`MUSE_CODE_PATH` are saved in the active `.env`; the vendor retains its account credentials.
The API worker remains an explicit choice. No provider error causes automatic API billing.

Jobs snapshot provider settings at admission, then create a private identity-bound provider pin
before execution. Existing Meta checkpoints remain Meta. CLI jobs resume their exact durable
session; uncertain submissions/answers retain their effects and never create a replacement session.
Account roots match between Settings, login and both coding-child paths. Coding cancellation owns
the host during initialization as well as after connection. Foreground voice remains independent.

The supported CLI requires an account subscription and current allowance, reviewed experimental
protocol, restricted toolset, one coding writer, app-owned isolated worktree and observed sandboxed
permissions. Pending actual questions and approvals remain visible decisions. A vendor completion
summary is inference; main's separate Git/validation runtime supplies actual check receipts.

## Actual checks

- Full unit suite: **1,628 passed, 13 skipped, 0 failed**, across 160 files. Skips cover
  Electron-only database checks under Bun; no skipped test is counted as native verification.
- Type-check, repository lint and production build passed.
- `test:coding-provider`: actual built Settings, renderer/preload/main IPC, coding child,
  private provider pins, isolated Git checkout, commit and npm checks. Six phases passed:
  API startup launches no CLI; explicit selection persists; missing/unsupported CLI blocks
  coding with no API fallback; explicit API work starts; an existing API job resumes with
  its original provider after preferences change.
- Controlled native V1 conversation/history/cancellation, executive jobs, OAuth and local
  PR-fix regressions passed. These use controlled model/provider transports, not live speech.
- Real read-only CLI probe: installed **1.4.13**, **sign-in-required**, billing unknown,
  not ready. It created no coding session or model turn and copied no credentials.

Run `bun run test:coding-provider` from integration. Integration alone launches native checks.
Its fake CLI deliberately lacks the supported protocol and cannot establish successful subscription
coding. The adapter's SDK-port tests cover completion, questions, resume, quota, account switches,
approvals, cancellation, unknown effects and ownership with controlled data.

## Remaining external checks

A signed-in account with an active subscription and available allowance is needed to verify real
SDK coding, session permissions, question/approval handling, restart and cancellation end to end.
Only reviewed 1.4.13/1.4.14 CLI schema versions are accepted; unsupported versions stop explicitly.
Foreground conversation/transcription/ElevenLabs still require their existing provider configuration.

Coding and SQLite remain on this Mac. GitHub shares published comments/branches. Team preparation
and proposals are not shared through an organization backend yet; see the
[Supabase proposal](team-backend-plan.md).

[Evidence](evidence/coding-provider-2026-10-31.json) and the
[controlled Settings screenshot](screenshots/coding-provider-controlled-settings.png) record test scope.
