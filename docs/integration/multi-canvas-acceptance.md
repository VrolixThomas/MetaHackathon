# Multi-canvas workspace and conversational review

Integrated on `hack/integration`, 2026-10-28. Implementation handoffs and file reservations are
recorded on MET-8. Reviewed worker handoffs were produced by Codex through SuperiorSwarm.

## Run and try

```sh
cd /Users/Werk/Documents/Repositories/MetaHackathon-worktrees/integration
bun run build
bun run --filter @metahackathon/desktop preview
```

The existing repository `.env` remains the configuration source. Click **Start conversation**
once after Voice ready. No review is required to create a canvas or open a website.

Try these requests in one conversation:

1. “Create a short explanation document about this change.”
2. “Make a checkout mockup beside it.”
3. “Open http://localhost:3000.” Supply a URL that is actually running, or an explicit HTTPS URL.
4. “Show it on a phone.” / “Scroll to the payment button.”
5. “Show me the code.”
6. With a prepared PR selected: “Walk me through this PR.” Ask a question or speak over it at any time.
7. “Continue.” Muse advances through the next group in prepared order.

Documents, visual mocks, code and browser share tabs and optional split panes. The agent uses the
same commands as manual controls. It sees a validated canvas/layout snapshot, the current pinned
source, and bounded observations of the actual native page. Each mutation needs a distinct request
ID and a settled renderer/native receipt before narration can claim it was displayed.

A walkthrough covers up to three files, then pauses naturally. The next file waits for the
current explanation's TTS playback and PCM drain; typed conversations acknowledge published text.
There are no synthetic user “next” turns. Cancellation retires the turn and pending effects.

## Verified

- Frozen install, type-check, lint and production build pass.
- 684 TypeScript tests and 18 Python voice-service tests pass.
- `test:workspace`: actual built Electron/default renderer/preload/IPC creates a Markdown document,
  renders a typed SVG visual, changes the two-pane layout in the same user turn, opens a real
  loopback website, observes/types/clicks its actual page, opens a prepared review and tours all
  three pinned source files from one request. Three narration receipts occur between the matching
  display and subsequent file transition. Late duplicate narration receipts are rejected.
- Native persistence: actual SQLite holds the prepared plan and final visited-file progress;
  private `workspace/canvases.json` holds the document/visual. The document closes into Recent and
  reopens through the actual UI with its content preserved. Store tests additionally verify
  recreation, private permissions, invalid/cancelled writes and retained corrupt data.
- `test:prepared-reviews`: resume, next, previous, jump/highlight, pause and resume all pass in the
  canvas workspace. Changes/Before/After retain exact pinned source with syntax colors. Dirty
  files, Git status and HEAD remain unchanged; no GitHub comment is posted.
- `test:local-browser`: same native webContents across real links, form submission, navigation,
  back/forward and reload; desktop/phone, split resizing, source/browser tab changes, modal hiding,
  unsubmitted input preservation, URL rejection, explicit destruction/reopen and shutdown pass.
- `test:integration`: empty startup, no-PR conversation, actual follow-up history and cancellation.
- `test:hands-free`: actual Chromium controlled PCM/WebRTC, one microphone stream, automatic
  utterances, barge-in during reply playback, continued listening, modal Escape and End cleanup.
  Separate controlled agent failure + app Escape check also passes without losing the healthy
  listening session. The transport/provider responses are simulated, not a physical microphone.
- Live Meta provider, controlled source and simulated display receipts: the model chooses the
  semantic walkthrough and narrates three files in one turn, with three checkpoints. This run
  completed in 5.17 seconds, first published answer at 2.54 seconds. These are observations from
  one run, not a latency guarantee. A separate live provider check creates a document and then a
  visual/layout in two follow-up requests (2.23 / 4.12 seconds). No microphone/TTS was used there.

Three real integration seams were fixed: repeated tool operations sharing an idempotency key;
late connection polling closing the agent's newly opened matching review; and a source highlight
not switching the controlled code view. A live model also invented a new draft ID: creation now
explicitly omits IDs, update IDs must be observed, and one rejected argument correction is allowed
before execution. Applied/failed effects are never automatically replayed.

## Commands and evidence limits

```sh
bun run type-check
bun run lint
bun test apps/desktop/src
services/voice/.venv/bin/python -m unittest discover -s services/voice/tests
bun run test:integration
bun run test:hands-free
bun run test:prepared-reviews
bun run test:local-browser
bun run test:workspace
```

Native reports are generated under `apps/desktop/out/*-smoke-report.json`. The workspace harness
has an optional visual hold for watching the actual controlled flow:

```sh
WORKSPACE_SMOKE_HOLD_MS=30000 WORKSPACE_SMOKE_HOLD_STAGE=browser bun run test:workspace
```

The hold is test-only, does not read real keys, and introduces no startup fixtures. Browser pages
are unverified revision evidence. Generated explanations and SVG scenes are agent drafts. Visual
mocks currently use rectangles/text/lines; raster image-provider generation is not connected.
Suggested PR comments remain unposted, and existing confirmation safeguards are preserved.

The complete new walkthrough was verified with the live language model and separately through the
native UI, but not through live microphone → speech provider → three-file playback in this pass.
Room-acoustic interruption and live speech latency still need a user-device session. Earlier live
voice results are historical, not evidence for that new full flow. Signing/notarization are separate.

Screenshot capture of the temporary QA app could not complete: Computer Use waited until the
owned app quit. No screenshot was substituted or presented as current UI evidence. The runnable
native hold above demonstrates the browser workspace directly.
