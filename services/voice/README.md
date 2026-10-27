# Voice sidecar — MET-28 / MET-29

This Python sidecar carries microphone PCM to Meta STT and spoken sentences from
ElevenLabs to a local WebRTC peer. Each generation owns a new Pipecat 1.14.0
`PipelineWorker`, `SmallWebRTCConnection`, input gate and output transport. There
is no LLM, tool execution, agent request, GitHub write or Node fallback here.

The renderer owns the agent turn and audible latency measurement. Main owns
process supervision and the bearer token. Runtime owns Electron packaging,
Developer ID signing, notarization and DMG acceptance. The authoritative transport
contract is `apps/desktop/src/main/voice/protocol.ts`; the Python boundary models
mirror it in `voice_sidecar/protocol.py`.

V1 general conversation may omit a PR entirely; this sidecar still handles only audio and never
creates a screen or an agent turn. Provider failures now carry the bounded shared diagnostic
`{stage,code,httpStatus?,closeCode?}` through HTTP `detail` or a poll error's `diagnostic` field.
Exception text, response bodies and WebSocket close reasons are discarded. Main validates the
metadata and generates user-facing messages locally. The first provider failure survives peer
teardown; explicit cancellation retains its existing semantics.

## Run and build

Use Python 3.13 on the target platform and architecture. The checked-in lock is
the complete 70-package environment resolved on macOS arm64 / Python 3.13.3;
`requirements.in` records the requested top-level pins. It is an exact-version
freeze, not a cross-platform or wheel-hash lock.

```sh
python3.13 -m venv services/voice/.venv
services/voice/.venv/bin/python -m pip install -r services/voice/requirements.lock
services/voice/.venv/bin/python services/voice/sidecar.py --self-test
services/voice/.venv/bin/python -m unittest discover -s services/voice/tests -v
services/voice/.venv/bin/python services/voice/scripts/freeze.py
```

The build uses PyInstaller **onedir** and emits:

```text
services/voice/dist/metahackathon-voice/metahackathon-voice
services/voice/dist/metahackathon-voice/_internal/
services/voice/dist/bundle-inventory.json
services/voice/dist/self-test.json
services/voice/dist/cold-launch-smoke.json
services/voice/dist/launch-smoke.json
```

Copy the entire onedir directory, preserving symlinks. The inventory recursively
records each regular file's SHA-256 and size, all Mach-O paths/architectures, and
symlink targets without double-counting their contents. Recompute it **after**
runtime signs or otherwise changes binaries. Build artifacts and logs are ignored;
the small evidence snapshot under `evidence/` documents this worker's validation.

`--self-test` requires no credentials and creates no provider connections. It
imports Pipecat/aiortc/AV/ElevenLabs, executes a real Pipecat pipeline, creates and
closes a peer, checks 48 kHz stereo → 24 kHz mono signed-16 PCM conversion, and
checks the system-trust TLS context. The build also runs this frozen probe and a
frozen launch/authentication/cancellation/shutdown smoke test with dummy keys.

The first local ad-hoc frozen probe exceeded 60 seconds during native library
loading (sampled in macOS `dyld` / `fcntl`); retry passed. The build probe allows
180 seconds to diagnose cold loads. A subsequent rebuilt bundle's cold import
probe passed in 109.272 seconds, followed by a 1.238-second warm HTTP launch.
The final build measures server boot before self-test, then a second warm boot;
see `evidence/validation.json` for both. A 30-second supervisor startup deadline
can reject cold boots on this machine: call main's `prepare()` on app/settings
ready with a startup override of at least 180 seconds for this spike. This is a
measured local limitation, not a clean-machine or signed-release launch guarantee.

## Configuration and control protocol

Required environment variables:

| Variable | Purpose |
| --- | --- |
| `VOICE_AUTH_TOKEN` | Main-generated secret for every HTTP request |
| `MODEL_API_KEY` | Meta Model API account with Muse Voice Transcribe access |
| `ELEVENLABS_API_KEY` | ElevenLabs account with TTS access |
| `ELEVENLABS_VOICE_ID` | Voice the ElevenLabs account can synthesize |

Start the executable with `--port 0`. It binds **127.0.0.1 only**, prints one
`{"port":12345}` JSON line only after Uvicorn is listening, and logs to stderr.
Missing configuration exits 2 without readiness. No credentials enter replies
or renderer state. TLS verification uses the operating system trust store,
including in the frozen build. Production provider URLs are fixed in code.

Every HTTP path, including missing paths, requires `Authorization: Bearer TOKEN`.
The service has no unauthenticated docs or health endpoint, CORS policy or WebSocket
control route. WebRTC uses host ICE candidates and no STUN/TURN servers.

| POST path | JSON input | Result |
| --- | --- | --- |
| `/offer` | identity, `sdp`, `type:"offer"`, optional `keywords` | `{sdp,type:"answer"}` |
| `/release` | identity | `{}`; schedule bounded drain and finish STT |
| `/speak` | identity, `speechId`, `text` | `{}`; enqueue sentence |
| `/cancel` | identity | `{}`; invalidate then tear down |
| `/poll` | identity, `afterSequence` | `{events:[...]}`; at most 100 |

Identity is `{sessionId,turnId,generation}`. Integer fields reject booleans,
fractions and unsafe JS integers. All output events carry the exact identity and
a positive generation-local sequence. Cursor through the **last returned event**.
An expired retained cursor returns 409; cancel that generation instead of silently
skipping events. Cumulative partial transcripts replace earlier hypotheses, and
only the first valid final transcript is emitted.

An offer must advance the session's generation. Duplicates and stale offers return
409. Cancellation records a tombstone even before an offer arrives or while its
provider handshake is pending. Late output is gated off synchronously; old cancels
cannot affect the current generation. Same-generation turn mismatches return 409.
Repeated same-identity cancellation is safe. A new generation closes the previous
peer before starting another pipeline. Closed generations reject release/speak;
poll can still retrieve a failure event. Explicit cancellation clears old events.

`/release` keeps accepting RTP for at most 200 ms, then closes the input gate.
Accepted PCM drains in FIFO order before Meta receives `endStream`. Buffered PCM
is paced at realtime using monotonic deadlines; a stalled sender never gains
catch-up credit to burst queued audio. The receiver
continues until the final transcript and normal close 1000; early close, missing
final, provider failure or finalization timeout produces a sanitized error and
closes the generation. `/cancel` instead aborts both providers and the peer.

Speech IDs deduplicate exact retries; reusing an ID with different text returns
409. Sentences synthesize serially. Output fences limit queued PCM to roughly
40 ms and make `speech-started` precede PCM and `speech-ended` follow the output
transport's consumption of the last PCM. These are **transport events**, not
measurements of audible playback. The renderer must drain/observe its own audio.

## Provider protocols

Meta uses `wss://api.meta.ai/v1/asr/realtime?sessionId=...`. The first JSON frame
contains `authorization.accessToken:"Bearer KEY"`, `audioEncoding:"PCM_24KHZ"`,
`model:"muse-voice-transcribe-1.0"`, `mode:"PUSH_TO_TALK"`,
`partialMode:"CUMULATIVE"`, and the offered keywords. A `{sessionId}` acknowledgement
precedes binary mono signed-16 little-endian PCM at 24 kHz. Release sends
`{"type":"endStream"}`; it does not close the socket. HTTP Authorization is not
used for this API. Verified against Meta's official
[STT guide](https://dev.meta.ai/docs/speech-to-text),
[realtime endpoint](https://dev.meta.ai/docs/api-reference/voice/realtime), and
[schemas](https://dev.meta.ai/docs/api-reference/voice/schemas) on 2026-10-26.

ElevenLabs uses the documented
[`POST /v1/text-to-speech/{voice}/stream`](https://elevenlabs.io/docs/api-reference/text-to-speech/stream)
with `xi-api-key`, `output_format=pcm_24000`, and
`{text,model_id:"eleven_flash_v2_5"}`. The installed Pipecat 1.14.0 ElevenLabs
source was checked (its HTTP service uses the related `/stream/with-timestamps`
endpoint). This adapter deliberately streams raw PCM through Pipecat and uses
transport fences; it does not infer word timing or audible completion from provider
timestamps. Odd network chunk boundaries are reassembled, and only the final PCM
chunk is silence-padded to the transport frame size.

## Resource limits and validation scope

| Resource | Bound |
| --- | --- |
| HTTP body / concurrent requests | 128 KiB / 64; body receive timeout 5 s |
| Simultaneous sessions | 4, including sessions still tearing down |
| Session identities | 256 per process, no tombstone eviction; restart at cap |
| Capture | 60 s wall clock and PCM-byte equivalent |
| Generation lifetime | 300 s |
| STT pending PCM | 100 chunks, each at most 40 ms; overload fails closed |
| STT connect / finalization | 5 s handshake steps / 15 s after drain |
| Entire offer setup | 12 s, within the parent's 15 s request deadline |
| Retained events | 512 and 256 KiB per generation |
| Speech | 32 waiting sentences, 256 distinct IDs per generation |
| Sentence | 4000 characters, 120 s PCM/provider response, 125 s overall |
| Output fence / teardown | 5 s / 6 s |

Tests use real local HTTP/WebSocket servers and real aiortc DTLS/SRTP with a
generated tone, including non-silent returned audio. Providers are mocked. They
cover provider wire formats, release/finalization, serial speech IDs, stale peer
replacement, cancellation before/during offer and during STT/TTS, invalid provider
handshakes, missing final transcripts, timeouts, authentication and resource limits.

No live Meta/ElevenLabs request, microphone/browser acceptance, signed application,
DMG or clean-machine launch has been claimed. Those integrated checks remain with
the parent and runtime. No ticket is marked Done by this handoff.
