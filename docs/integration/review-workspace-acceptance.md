# Real review workspace acceptance

Validated on 2026-10-27. Application checkpoint: `bf3e138` on `hack/integration`.
Machine-readable results: [sanitized report](review-workspace-acceptance.json).

## Run the combined app

Quit the older app window and launch from the integration checkout:

```sh
cd /Users/Werk/Documents/Repositories/MetaHackathon-worktrees/integration
bun run build
bun run --filter @metahackathon/desktop preview
```

The user's normal app was preserved during testing, so an already-open older window does not
automatically acquire the new main-process features. Configuration remains in the private root
`.env`. Hold the microphone button or use Command–Shift–Space; Escape/Stop interrupts. Conversation
and typing are optional. GitHub sign-in is available in Configuration, then Repository connects
an actual local clone or `owner/repo`.

## Verified

- Frozen dependency installation, type-check, lint and build pass. 496 TypeScript tests and
  18 Python voice-service tests pass.
- Native conversation works with no PR, preserves follow-up history, cancels an outstanding turn
  and rejects its late result. Text is hidden by default, voice controls remain visible, and an
  actual AudioContext starts without a renderer gesture for native-shortcut speech.
- Native prepared-review flow caches one structured plan in actual SQLite before opening it.
  Start, next, previous, jump/highlight, pause and resume work through the actual renderer/IPC
  and acknowledgements. Twelve model packets contain actual pinned source; no remote content
  reads substitute for locally available commits. Dirty files, Git status and HEAD are unchanged.
- Changes, Before and After each show eight distinct token colors in the controlled TypeScript
  case while retaining exact source text. Focused tests cover multiline context outside a hunk,
  independent base/head grammar state, renames, CRLF/tabs/Unicode, unsupported files and safe text
  rendering. Fifteen grammars and the theme are bundled locally using Shiki's JavaScript engine.
- Native browser checks use one actual WebContentsView and local HTTP server. Links, a submitted
  form, back/forward, navigation and reload return actual page results. Desktop/Phone controls,
  matching chrome dimensions, responsive page layout, modal hiding, split resizing, hidden-page
  draft preservation, external-navigation blocking, close/reopen and app shutdown all pass.
- Each native harness removes its owned temporary profile/server and disposes guest contents.
  Visual QA used a temporary copy of the same Electron binary with a distinct bundle ID so the
  user's existing app and conversation could remain open. Source/build/launch stayed in integration.

The prepared-review model/GitHub responses are controlled tests with an actual temporary Git
repository. The browser screenshot page is an actual locally served acceptance page. Neither is
product startup/demo content, real PR execution proof, live speech or a live-provider result.

Separate read-only checks in this session verified a real GitHub/local-clone connection and open
PR metadata, and a live model preparation call with controlled PR input. Live STT → model → TTS
with synthetic audio was verified at the preceding [V1 checkpoint](v1-acceptance.md); this change
did not record ambient microphone audio or repeat that provider test.

## Screenshots

- [Highlighted review, optional transcript hidden](screenshots/prepared-review-syntax.png)
- [Actual browser beside the workspace](screenshots/review-browser-desktop.png)
- [Phone viewport, same native browser](screenshots/review-browser-phone.png)

Screenshots use isolated test configuration, so their “Voice needs configuration” status is
expected. The normal app reads the user's existing `.env` instead.

## Remaining work

The current agent guides an already selected prepared review. Full no-PR repository/PR selection
and observation/control of the new local browser are not implemented by this checkpoint. The
specific [agent-first navigation plan](agent-navigation-plan.md) extends the existing session,
semantic actions and receipts and reuses the same visible page. It does not create a parallel agent
or browser. Screenshot/model vision capability must be verified before claiming visual perception.

The local preview does not start a server or establish its PR revision. Suggested comments are
unposted drafts; the new flow has no submission control. Existing explicit confirmation guards
remain in main. Team accounts, GitHub App/webhooks, preparation while the desktop is closed,
Supabase, background coding tasks and signed distribution remain separate increments. The user's
forthcoming test repository and human-spoken review flow still need acceptance.

The quiet workspace uses original React/CSS informed by
[Macro's design guidance](https://github.com/macro-inc/macro/blob/main/.agents/rules/web/design-system.md)
and the user's Codex split-view reference. SuperiorSwarm's GitHub, editor and action architecture
were inspected for reuse; no account token or private configuration file was copied into source.
