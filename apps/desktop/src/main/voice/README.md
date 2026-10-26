# Voice main integration

MET-28–33 voice transport modules consume shared turn identities. Root integration owns
registration, lifecycle and credential wiring; UI owns visible controls and the global Space handler.

```ts
import { VoiceSidecar, VoiceService, createVoiceRouter } from './voice';
const sidecar = new VoiceSidecar({
  command: packagedVoiceExecutable, // trusted absolute path, never renderer input
  // Development: command is venv Python; args are ['.../services/voice/sidecar.py'].
  getCredentials: async () => ({
    meta: await runtimeCredentials.get('meta'),
    elevenlabs: await runtimeCredentials.get('elevenlabs'),
    voiceId: configuredElevenLabsVoiceId,
  }),
});
const voice = new VoiceService(sidecar);
// Root router: voice: createVoiceRouter(voice)
// Shutdown: await voice.dispose() before disposing credential/runtime services.
```

The packaged executable is planned at `process.resourcesPath/voice/metahackathon-voice`
with its `_internal` directory beside it. Runtime owns copying/signing this tree. Voice does
not activate the Node-only fallback because absence of signing credentials does not establish
Python packaging failure.

The router exports `offer`, `release`, `speak`, `cancel` mutations and `poll` query. All
inputs/outputs use `protocol.ts` schemas. `cancel` accepts **only** `TurnIdentity`; agent
cancellation additionally needs requestId/reason via shared `CancelTurnInput`. Renderer must
call both on interruption. An aborted IPC request does not cancel server work.

`VoiceService` remembers the highest generation per session, including cancellation before
offer. It rejects late offers/results/events. The sidecar must independently tombstone cancelled
generations because an aborted HTTP request may already have created a peer. Identical pending
offers deduplicate; changed SDP in the same generation is rejected. There is a lifetime cap of
128 sessions; stable controller session IDs avoid unbounded tombstone growth.

`VoiceSidecar` starts lazily, binds requests to the child's advertised loopback port, supplies a
random bearer and provider keys only in the child's environment, bounds startup/request time
and response size, ignores raw provider stderr, and terminates the child at shutdown. It does
not restart after crashes or a failed setup lookup: construct a new service after settings change.
This keeps existing generation tombstones from silently resetting underneath live controllers.

Required setup: Meta Model API key with Muse Voice Transcribe and Muse Spark access,
ElevenLabs API key with TTS permission, and an accessible ElevenLabs voice ID. No configured
key or live entitlement has been verified in this lane. Errors enumerate missing configuration,
never credential values. No provider credentials or private loopback bearer reach the renderer.

## Verification

`bun test apps/desktop/src/main/voice` checks cancellation before/during offer, late transcripts,
identity/sequence rejection, deduplication, stale cancellation, lifecycle shutdown, real subprocess
loopback authentication, bounded startup and sanitized HTTP errors. These checks use mock
providers; they do not establish provider access or microphone-to-speaker latency.
