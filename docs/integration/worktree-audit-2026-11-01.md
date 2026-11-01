# Worktree and user-feature integration audit — 2026-11-01

The audit started against `main` **4a5599b**, which already contained the user's MET-75 conditional
PR approval and MET-76 Slack clarification merges. Integration fast-forwarded to that source before
review. No uncommitted work existed in any of the **80** inspected worktrees. No earlier agent was
still building at the start. [Per-worktree inventory](evidence/worktree-audit-2026-11-01.json).

## Lane disposition

| Worktrees | Result |
| --- | --- |
| 71 | Changes already reachable or patch-equivalent on main |
| 6 | App changes integrated under matching commit subjects with subsequent integration adaptations |
| 1 identity/site branch | Final selected asset kit and MuseFocus site brought in; ten earlier design studies remain archived |
| 2 historical runtime checkouts | Current runtime adaptations retained; old seeded preparation/judge proxy and packaging probes remain archived |

The historical `background`/seeded judge proxy predates the real local Muse preparation service and
the explicit decision to exclude remote preprocessing. Reintroducing it would regress current scope.
The old finance-module smoke enhancement and mounted demo-package probe are test-only history,
not missing user functionality. Existing current migration/runtime/package checks remain in place.
No old lane snapshot was merged over newer application code.

The final design commits `38d7c1d` and `14f9d6a` were integrated as `23701b2` and `393b866`.
The reviewed adoption `a3b8246` is integrated as `12e014b`: actual MuseFocus homepage, local fonts and
selected macOS icon, with existing setup/launch metadata retained. Frozen generated assets retain
exact bytes and have narrow formatter exclusions plus their own validators. No domain or publication
was changed. A later scan of branches without checked-out worktrees also found `cc0c0a9`: the completed
desktop identity binding. It is integrated as `981e3fc`, retaining storage/encryption identity,
root privacy hooks and shared approval state, and standardizing the icon under `resources/branding`.
The old `design/pr-review-workspace` scaffold remains archived as a superseded prototype.

The already-integrated signing fix ancestry was merged so its original feature branch
is also reachable, without changing application files.

## Review findings resolved

Three separate Codex-only SuperiorSwarm workers reviewed the two user features and asset handoff
in separate existing worktrees. Follow-up changes stayed in disjoint scopes; root alone built and
launched the combined app.

- **MET-75:** expiry is rechecked after asynchronous preflight and immediately before dispatch;
  expired policies cannot post. Notification-only policies support own/read-only PRs, while approval
  retains its permission/author gates. Real GitHub account/author/review envelopes normalize into
  strict identity DTOs instead of rejecting normal extra profile fields. The latter was reproduced
  as an actual native-dialog failure before the fix.
- **MET-76:** worker-head/status changes no longer supersede clarification questions. Proven-unsent
  attempts reconcile with their original identity; ambiguous reserved writes never blindly retry.
  Confirmation and expiry derive from one clock read.
- **MET-76 privacy:** ordinary public snapshots contain clarification metadata, not stored thread
  text or inferred briefs. Explicit UI/agent inspection rechecks current source membership,
  message revisions, account and item identity. A new proposal receipt exposes only its freshly
  read target, and replayed receipts remain redacted. Private persisted records are preserved.

Source handoffs: `2b1990c`, `a97c099`, `a3fa3d5`, `d49ac2d`; integrated as `71e94ef`, `fb95599`,
`8cb30fb`, `ade02c5`. Root's privacy boundary is `10116e6`, with JSON wire omission corrected in `23077db`. No dependency additions were required. Accepted source head before this documentation-only handoff: `b915fadfab551ae239d0b2e943b505f7c573d1aa`.

## Verification and limits

- Full canonical unit validation: **1,919 passed, 13 skipped, zero failures across 194 files**.
  Type-check, lint and build pass. The skips are existing Bun/SQLite adapter cases; native checks
  separately exercise actual Electron SQLite.
- The new **native PR approval gate passes all seven phases** using the actual renderer, IPC,
  SQLite, pinned Git sources and controlled HTTP: exact manual confirmation, edit/reconfirmation,
  successful-check approval path and durable head-bound receipt, renderer reload without replay,
  revocation, unrelated-head review, and an uncertain response without automatic reposting.
- The **native Slack clarification gate passes seven checks** on the final branded app: real
  manual credential verification/intake/classification and Day capture over controlled transport,
  actual two-frame selection receipts, pause/revoke of in-flight analysis, exact real-clock expiry,
  one authorized original-thread question/receipt and inferred requester-answer brief, metadata-only
  reload, fresh membership/source denial and account-switch rejection with private state retained.
- The **native OAuth regression passes five checks** on the branded app: actual local callbacks,
  PKCE exchange, profile validation, token refresh, encrypted sessions, disconnect/account isolation,
  reconnect cancellation and app-quit cleanup. Providers remain controlled.
- The actual **My day native regression passes on the final branded app**. Targeted combined feature checks pass 165 tests;
  privacy coverage also checks denied/changed sources, account retirement, scoped proposal receipts,
  idempotent replay and foreground inspection. These counts overlap broader suites.
- Frozen kit validation passes 606 poses and controller lifecycle/reduced-motion checks. The adopted
  site passes actual controlled DOM events, keyboard tabs, local references, font licensing,
  unchanged asset bytes and truthful pending-release metadata.
- Current unsigned arm64 DMG/ZIP package construction and production payload checks pass, including
  SDK 1.4.14, native SQLite and 274 voice Mach-O files. The packaged ICNS and extra PNG match their selected sources
  byte-for-byte. This is package evidence, not a new signed/installed-app check.

The mixed shared-process Bun runner lost subprocess output after build/HTTP checks; each affected
suite passed independently. The final canonical `bun run test:unit` therefore runs every discovered
file in a fresh Bun process, supervised by Node. CI uses the same command, including the complete
runtime/renderer/server/packaging test coverage. No test or assertion is bypassed by the runner. The experimental timer/bundler changes were reverted; OAuth app behavior
is unchanged. Final suite/native results are recorded on MET-8.

The website's supplied preview PNGs are design compositions, not browser screenshots. The Chrome
computer-use entry point timed out during this audit, so rendered website/browser/accessibility
acceptance is not claimed. Actual live GitHub approval, live Slack question delivery, physical voice,
full process restart and a newly signed release are separate gates. No external messages, reviews,
PR merges through the app, production deployment or provider keys were used by controlled tests.
