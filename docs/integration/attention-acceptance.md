# Proactive supervision acceptance — 2026-10-30

Muse now initiates spoken job updates in the existing conversation while hands-free listening is
explicitly on and the app is focused. No user utterance is fabricated. The current browser, panes,
review file and walkthrough position stay unchanged. Subsequent user questions retain the delivered
notice and its job/head/decision references in conversation history.

## Implemented policy

- Main selects actual unannounced job notices: decisions first, failures next, then work ready for
  review. It checks current job state, exact head and pending decision identity. Accepted/cancelled,
  answered, seen or stale events cannot initiate speech. Current policy selects one event per update.
- Presence must be eligible for 2.5 seconds. Input/onset candidates, a foreground turn, playback,
  dialogs, focus loss, typing and recent native/DOM interaction defer or interrupt an update.
- Delivery is a dedicated assistant-only turn with no tools. Main revalidates before/after the
  model; there is no automatic navigation, work start, publication, acceptance or merge.
- Voice uses its existing sentence pump, peer lifecycle, observed PCM, speech-ended and drain
  checkpoint. Displayed text cannot satisfy spoken completion. Speaking interrupts output and
  captures the real utterance on the same persistent microphone session.
- Only delivered notices get announcedAt. Retry budgets and exact event fingerprints persist in
  SQLite. Interrupted attempts wait 60 seconds and stop automatic retry after three attempts; the
  queue remains available. Successful updates have a 20-second global cooldown.
- Completed spoken proof survives an immediate user followup and a lost final renderer settlement.
  Pending proof is flushed during shutdown. In-progress notifications never cancel coding workers.

## Verification

Frozen install, type-check, lint and build PASS. The full TypeScript suite has 912 passing tests;
the Python suite has 32. Seven native checks pass: V1, hands-free, prepared review, workspace,
local browser, executive workers and attention. Controlled providers are identified below.

The native `test:attention` check PASS uses the actual built default renderer, preload, main router,
attention scheduler, conversation service, voice composition and Chromium WebRTC/audio pipeline.
Providers and focus are controlled; three persisted job/notice records are test fixtures, not
execution-worker evidence. The existing executive native check establishes actual coding/commit/check
execution separately. No ambient microphone or physical speaker recording occurred.

Passing native assertions:

- No initiative before explicit Start, during a real workspace dialog, authoritative native focus
  loss or recent DOM input.
- A deliberately displayed-only narration receipt cannot settle spoken delivery.
- Actual decoded tone PCM and drain precede the genuine spoken receipt and durable announcement.
- Semantic priority and the real 20-second cooldown hold; workspace/layout/review/browser remain
  unchanged.
- A real captured waveform interrupts the next initiative, closes the old output, and submits one
  STT utterance through the same microphone. Late events cannot complete the interrupted notice.
- End and main shutdown close media/sidecar resources; a fresh SQLite connection confirms delivered
  and pending records plus retry budgets. This is reconnect evidence, not a full app restart test.

TypeScript behavior tests cover stale async admission, concurrent input, state/head/decision changes,
completion modes, ignored/duplicate/late checkpoints, immediate real followup, failed storage and
retry limits. A live Meta attention-model request with a controlled event passed in 1338ms. This
checks provider compatibility; it is not live speech or an actual completed user ticket.

## Voice latency investigation and change

The sanitized historical device sample in [the investigation](voice-latency-investigation.md) has
only six first-audio turns and is unversioned. Its median speech-end-to-first-PCM interval was about
5.1s. Derived endpoint-to-renderer-release was about 2.2s; release-to-final-transcript about 0.44s.
The 700ms local VAD silence threshold precedes that interval. Full tool-capable model output also
waits for terminal validation so discarded tool preambles cannot be spoken.

ASR connection and WebRTC initialization now overlap. The pipeline still waits for both before
accepting input. Thirty-two Python tests pass, including fourteen deterministic readiness/failure/
cancellation/late-cleanup cases. Provider pacing, FIFO order and PCM drain remain intact.

A live component probe ran two serial-baseline and two current startups against real Meta ASR with
actual local WebRTC offers, no microphone, no audio sent and no ElevenLabs request. All four passed.
ASR opening took roughly 0.7–0.9s in the warmed samples (first baseline 2.6s); RTC initialization was
about 3–8ms. The new path demonstrably overlaps them, but these small samples do not establish an
end-to-end speedup. Input backlog/realtime replay and model buffering remain the meaningful targets;
warming or decoupling transcription needs a separate provider/lifecycle implementation.

## Run

```sh
bun run build
bun run --filter @metahackathon/desktop preview
```

Click Start conversation once. Start real ticket work, continue your review, and leave a natural
pause for a completion or question update. Speak over an update to interrupt it; listening stays on.
Add LINEAR_API_KEY to the existing main checkout .env and select scopes for real assigned tickets.
Live Linear, new physical microphone/acoustic verification and full running-job process restart
remain separate acceptance checks. Review comments remain draft-only.
