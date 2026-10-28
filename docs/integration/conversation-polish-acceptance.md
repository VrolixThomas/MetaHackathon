# Hands-free conversation and clearer review

Validated on 2026-10-28. Application checkpoint: `c8f2062`; native harness checkpoint: `4f322ef`.
This supersedes the hold-to-talk instructions in earlier acceptance reports.

## Use

Restart the older app window from the integration checkout:

```sh
cd /Users/Werk/Documents/Repositories/MetaHackathon-worktrees/integration
bun run build
bun run --filter @metahackathon/desktop preview
```

When Voice ready appears, click **Start conversation** once. Speak, pause for a reply, and keep
talking. Speaking during an answer interrupts it. **Stop response** interrupts the answer and
keeps listening; **End conversation** stops microphone capture. Command–Shift–Space starts/ends
the session. Escape closes an open dialog first, otherwise ends voice.

The repository/PR identity at the top left opens the chooser. **More** contains Settings,
optional conversation/typing, and local preview. Opening these controls preserves the workspace
and microphone session. Selecting another PR/file interrupts the old reply while keeping the
microphone ready. Existing `.env` credentials and GitHub CLI connection remain unchanged.

## Changes

- One explicitly started microphone/AudioContext session survives between utterances. Each
  utterance has its own cancellable voice/model turn. Local speech detection ends capture after
  a pause; a bounded PCM buffer preserves the beginning while the RTC connection is prepared.
- Detected interruption disconnects old output immediately and cancels both voice and model work. Late
  signaling, results and cleanup errors cannot reopen the microphone or stop a newer session.
  Quiet reading does not automatically time out by default.
- The echo detector compares a longer trajectory instead of a short vowel-sized frame. This
  avoids suppressing a separate, similar-pitch voice. Confirmed playback echo is removed from
  pre-roll before a new utterance, with regressions for preserved independent speech.
- Explanations lead with behavior and impact. New preparation generates concise summaries and
  reasons for each file's position. Guided speech covers one acknowledged step at a time and
  uses the displayed source. Redundant “Inferred” prefixes are removed while uncertainty and
  provenance remain available.
- The review prioritizes code, with compact **What changes** and **Why this file now** sections.
  Full cached explanations, overview, reading order, evidence and draft suggestions remain
  available in bounded disclosures. Source text, highlighting, pins and receipts are preserved.
- Fixed overlays replace the disruptive header panels. Native browser hiding bypasses both
  presentation queues; stale show/resize completions cannot cover a dialog. Hiding preserves the
  real page and its input state. Focus returns to the opener when a dialog closes.

## Verification

542 TypeScript tests and 18 Python voice tests pass, along with type-check, lint and build.
The bundled AudioWorklet is a separate local asset compatible with the existing CSP; no new
dependencies or provider protocol changes were introduced.

Native Electron checks verify:

- No-PR conversation, history, cancellation and audio activation.
- Six guided review actions with actual pinned Git source, durable SQLite progress, unchanged
  dirty work and exact source text in all three syntax-highlighted views.
- One visible browser through navigation/form/history/reload, phone/desktop, modal hide/restore,
  divider resizing, preserved input, close/reopen and shutdown.
- One microphone acquisition call, supplied by the synthetic fixture, across automatic utterance/reply cycles. A deliberately
  delayed offer retains the early PCM marker before the later one. Actual product Worklet/RTC
  and decoded output run, with controlled STT/model/TTS responses and real sidecar readiness.
- Speaking over a response aborts the model stream and closes the old product peer. The next
  turn replies while the same microphone stays live. Settings → Escape preserves the session;
  unhandled Escape and End stop tracks, contexts and peers. A late offer cannot rearm capture.

The live-provider test also passed using generated speech through actual Meta STT, the model,
and ElevenLabs TTS. It completed a reply, interrupted the next one, completed another reply and
ended capture using one synthetic microphone stream. In the final same-voice test, the interrupted input's
full 54-character transcript was retained. Interruption was observed after 572 ms from clip start,
including approximately 280 ms of deliberate leading silence; this is a test measurement, not
a general latency guarantee. A separate generated voice also passed during baseline testing.

No ambient microphone was recorded. Test speaker output was muted; decoded output PCM was
measured before the physical device. Real-room microphone, loudspeaker and background-noise
quality still need human use. Speech detection is signal-based, not semantic turn detection;
continuous utterances currently have a 30-second limit and roughly 700 ms of silence ends a turn.
Provider/setup failures end the session rather than silently restarting the microphone.

Live review-preparation quality was checked separately with controlled source: output explained
the visible behavior change and why each file followed the previous step, without repeated
provenance labels or an architecture/disclaimer dump.

[Native review screenshot](screenshots/clear-review-workspace.png) uses an isolated test repository
and unconfigured speech credentials. It illustrates the actual layout; it is not demo content
loaded into the normal app. [Sanitized results](conversation-polish-acceptance.json) distinguish
controlled transports from live-provider verification.

Broader agent-driven repository selection/browser operation, GitHub App login, team hosting,
Supabase and signed distribution remain separate tracked work. This pass changes conversation
and review usability; it does not claim those capabilities or enable automatic comment posting.
