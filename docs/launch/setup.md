# Voice development setup and launch requirements

Voice runs in a local Python Pipecat sidecar. The Electron renderer owns capture/playback;
main owns the child process, local signaling and provider credentials. Agent reasoning and
review tools remain in the agent lane. The global Space handler and visible microphone
controls remain in UI. The Node-only fallback is dormant until an actual C-1 packaging failure.

## Provider setup

- Meta: configure a Model API key through the main-process credential store (`meta`). Live
  speech uses `muse-voice-transcribe-1.0`; intelligence uses the agent lane’s Muse Spark model.
  A key existing is not proof that both models are enabled for its account.
- ElevenLabs: configure `elevenlabs` through the same secure store and a voice ID accessible
  to that account. TTS requires text-to-speech permission. Voice ID is configuration, not a key.
- Developer sidecar environment names are `MODEL_API_KEY`, `ELEVENLABS_API_KEY` and
  `ELEVENLABS_VOICE_ID`. Main injects them into its child. Do not put keys in renderer code,
  Git, command-line arguments, screenshots, transcripts or Linear comments.

[Meta’s current speech guide](https://dev.meta.ai/docs/speech-to-text) specifies the realtime
WebSocket, PCM formats, push-to-talk mode and vocabulary biasing. The first JSON handshake
carries authentication; releasing capture sends `endStream` and waits for the final transcript.
[Meta’s voice schemas](https://dev.meta.ai/docs/api-reference/voice/schemas) define the event
fields. Checked 2026-10-26. Authenticated availability must be tested separately.

## Build and integration

Install the repository’s locked Bun dependencies. Follow `services/voice/README.md` for
Python setup, self-test, local provider mocks and the frozen sidecar build. Runtime copies
the frozen tree to `Contents/Resources/voice`, preserving `_internal`; every Mach-O binary
must pass the runtime signing inventory. The executable must run without system Python.

Root integration registers the exported voice router and owns startup/shutdown. See
`apps/desktop/src/main/voice/README.md`. Connect the renderer controller to that router,
agent start/poll/cancel, current ScreenContext and UI action/transcript sinks. Apply a tool
action only while its identity and screen context remain current.

Use PR paths, symbols and product terms as STT keywords. Biasing improves recognition;
it does not guarantee spelling. Keep that vocabulary specific to the active review.

## Acceptance run

Open the demo PR, hold Space, ask “what is this for?”, release, and hear a response.
Repeat with “show me scenario C”; verify the actual agent tool opens the corresponding
artifact and synchronizes its code evidence. Trigger background work and hear completion.
Interrupt during playback and again while a provider response is pending; neither old audio
nor old effects may return. Navigate away and confirm cleanup. Repeat after microphone
permission denial and a provider failure to check visible error handling.

Capture monotonic timestamps for release/end of speech and first non-silent received PCM.
Record acknowledgement and substantive-answer latency separately, including cold/warm state,
provider/model, network and sample count. Receiver PCM observation excludes speaker hardware
latency and is not an acoustic microphone-to-speaker measurement. Synthetic timings establish
instrumentation only; report live latency only from a configured provider session.

## Release and site

Runtime owns Developer ID signing, notarization, DMG and updates. Required CI secret names
are `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and
`APPLE_TEAM_ID`. Keep them in the GitHub release environment. An ad-hoc signature does not
establish notarized distribution. A missing identity leaves C-1 unresolved and C-7 dormant.

Serve `apps/site/` from the chosen static host after the recorded video, signed release and
public repository are verified. The download target is the repository’s `/releases/latest`.
Follow `recording-plan.md` for E-2; recording completion requires the actual exported demo.
