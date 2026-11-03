# MET-8 standing voice native acceptance

Root must execute this gate alongside the integrated typed standing gate to close
standing acceptance. This is the executable remaining voice gate, not a permanent
waiver or a substitute unit test. Author validation never launches Electron.

From the integration checkout, root builds the cold controlled-media configuration
used by attention/hands-free, then launches the actual default built App:

```sh
VITE_MUSE_VOICE_PRECONNECT=0 bun run build
cd apps/desktop
env -u ELECTRON_RUN_AS_NODE -u ELECTRON_RENDERER_URL ../../node_modules/.bin/electron src/main/standing-voice-smoke.cjs out/main/index.js
```

Run native gates serially. The actual app process must already have microphone
permission and the normal local voice sidecar resources must be installed. The
harness does not fake manager readiness or permission. Rebuild normally afterward
to restore default preconnection. No package scripts or existing files change.

Report: `apps/desktop/out/standing-voice-smoke-report.json`, overwritten per run.
It contains built main/renderer hashes, actual voice ingress, ASR capture PCM,
canonical TTS text, checkpoints, renderer-origin narration receipts and measured
Chromium drain, source messages, standing rules/admissions, original-thread outbox
and controlled provider receipts. SQLite is reopened read-only after app shutdown.
Failures exit nonzero with partial evidence. A nine-minute hard deadline retains
the owned profile; normal cleanup verifies inode/device/owner before removing it.
There is no native pass claim until root executes this command successfully.

The scenario selects the controlled Slack channel through Settings/sidebar and
acknowledged workspace state. Actual Start acquires the synthetic WebAudio
microphone. Its waveform travels through the default VAD/worklet/RTC/release path;
only the controlled ASR transport supplies recognized text. No harness call starts
a conversation or supplies a narration receipt.

First, Stop response interrupts an undrained proposal. A new actual voice `yes`
must not activate it. Second, every canonical proposal segment decodes PCM and
receives matching speech-ended; actual product drain produces the spoken receipt.
Only a distinct subsequent voice `yes` may activate the exact durable policy.
Third, a fresh trusted incoming mention enters the normal classifier/watcher and
is admitted independently. While its analysis response is held, a new foreground
proposal speaks and an actual ASR `Stop` cancels that speech. Releasing background
analysis must still produce exactly one bounded original-thread clarification and
a durable delivery receipt. Prior intake remains unadmitted; no acceptance, coding
job, final answer, completion or real Slack send is authorized.

Reuses the exported hands-free media fixture used by attention-smoke, the actual
comment-conversation controlled SSE helper, and the typed standing HTTP provider.
Existing helpers are imported unchanged. The new transport handles rejected
confirmation tool output without representing it as activation. The report and
SQLite assertions decide success, not controlled model prose. No clocks, SQLite
rows, controllers, action receipts or narration receipts are injected.

All ASR/TTS/model/Slack data is explicitly controlled. TTS uses synthetic tone PCM,
not synthesized intelligible speech; exact text is checked at the TTS transport
boundary. Chromium decoding/drain is real, speakers are muted, and the microphone
is synthetic. This proves neither live acoustics nor live providers nor restart.
Credentials are scrubbed and replaced by fake values in an isolated `.env`.
Main HTTP is fully intercepted; Chromium remote network, WebSockets and external
browser launches are blocked. The real voice manager may launch its normal local
sidecar, but all its request endpoints terminate in the controlled transport.

If root encounters a product failure, retain the report and fix the source seam;
never manufacture a receipt or weaken the gate. Relevant seams are:
`renderer/voice/controller.ts` (speech queue, narration checkpoint and media drain),
`renderer/conversation/voice.ts` (actual ingress binding),
`main/composition/standing-clarification.ts` (`userIngress`, `narrateProposal`,
`confirm`), and `main/composition/voice.ts` (complete Stop callback). The author
found no confirmed product gap by source inspection; native behavior is unrun.

Node-only author checks:

```sh
node --check apps/desktop/src/main/standing-voice-smoke.cjs
node --check apps/desktop/src/main/standing-voice-smoke/media.cjs
node --check apps/desktop/src/main/standing-voice-smoke/scenario.cjs
node --check apps/desktop/src/main/standing-voice-smoke/self-check.cjs
node apps/desktop/src/main/standing-voice-smoke.cjs --self-check
```
