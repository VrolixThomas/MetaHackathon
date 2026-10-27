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
// After settings are ready, warm the executable before offering capture:
await sidecar.prepare(); // Starts only local server; no provider request.
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

## Exact local setup and readiness

Root owns the setup router and service lifecycle. The published shared
`VoiceSetupStatusSchema` has `phase: unconfigured | stopped | preparing | ready | error`,
`voiceId: string | null`, `missing: (meta | elevenlabs | voiceId | executable)[]`, and
optional sanitized `error`. UI uses `voice.status`, `voice.configure({voiceId})` and
`voice.prepare`, plus the existing credential set/status routes. There is no credential getter
in the renderer. The voice ID is public configuration (trimmed, 1–200 characters).

| Main input | Required value / mapping |
| --- | --- |
| `command` | Absolute path to the local Python 3.13 venv executable, or the rebuilt frozen executable |
| `args` for source | `[absolutePathToServicesVoiceSidecarPy]`; supervisor appends `--port 0` |
| `getCredentials().meta` | Runtime encrypted credential `meta`; becomes child `MODEL_API_KEY` |
| `getCredentials().elevenlabs` | Runtime encrypted credential `elevenlabs`; becomes child `ELEVENLABS_API_KEY` |
| `getCredentials().voiceId` | Configured, account-accessible ElevenLabs voice ID; becomes child `ELEVENLABS_VOICE_ID` |
| `VOICE_AUTH_TOKEN` | Generated privately by `VoiceSidecar`; never a user setup field |
| `startupTimeoutMs` | Default `180_000`; permit the measured cold native import before enabling capture |
| `requestTimeoutMs` | Default `15_000` per private HTTP request |

`prepare()` resolves after the local loopback server prints validated readiness. It does not
open the microphone or call either provider. `offer` negotiates a fresh WebRTC peer and opens
Meta STT; `speak` sends ElevenLabs TTS. The Meta key needs Muse Voice Transcribe access (the
agent separately needs Muse Spark); the ElevenLabs key needs TTS access to the configured voice.
An apparently configured key is not proof of entitlement, and local `ready` is not a live speech
test. Provider URLs and model IDs are fixed in the sidecar; no URL override is exposed to UI.

Keep capture disabled until setup is `ready`; after capture begins, show `connecting` until the
controller reaches `listening`. Stop voice and agent before changing configuration. Dispose
the old `VoiceService`/`VoiceSidecar` pair, construct a fresh pair, and prepare it with the new
settings: failed prepare promises and process credentials are deliberately not reset in place.
Preserve UI's shared session/generation allocator across controller replacement.

The local Python suite needs no credentials and uses mocked providers. Root can create its
source environment with Python 3.13 and `services/voice/requirements.lock`. The frozen bundle
recorded in the earlier handoff predates redirect fix `2948077`; rebuild it before packaging.
Runtime still owns signing/notarization and must recompute the inventory after signing.

## Verification

`bun test apps/desktop/src/main/voice` checks cancellation before/during offer, late transcripts,
identity/sequence rejection, deduplication, stale cancellation, lifecycle shutdown, real subprocess
loopback authentication, bounded startup and sanitized HTTP errors. These checks use mock
providers; they do not establish provider access or microphone-to-speaker latency.

Cold capture must wait for media readiness. There is no preroll buffer for speech spoken before
ICE/DTLS and provider setup complete. UI should expose the controller connecting state and
only cue speaking once listening. Warm the executable after credential setup to keep binary
loading out of the first push-to-talk request. This is separate from end-of-speech latency.

The packaging spike measured one cold native import at 109.272 seconds and warm HTTP boots
around 1.2–1.5 seconds. The default executable startup deadline is therefore 180 seconds;
individual HTTP operations remain bounded at 15 seconds. Composition must await prepare()
and keep capture unavailable while warming. Cold start remains a release usability risk and
requires clean-machine signed-app measurement; warm results are not a cold-start guarantee.
