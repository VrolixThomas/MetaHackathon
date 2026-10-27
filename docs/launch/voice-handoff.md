# Voice and launch implementation handoff

Branch `hack/voice` implements the owned voice stack and prepares launch materials.
Python remains selected: local Pipecat/WebRTC and frozen executable mechanics work.
C-1 requires a Python.framework signature repair and signed-app acceptance in runtime/D-5. C-7 remains Backlog; no Node fallback was built.
No live-provider, signed release, published landing page or completed demo recording is claimed.

## Resumed integration handoff — 2026-10-27

The clean lane resumed at `83e9163` as its sole writer. Previous reviewed commits, evidence and
packaging limitations below are preserved. No older worker/session was resumed or duplicated.

| Ticket | New source commit | Files / behavior |
| --- | --- | --- |
| MET-29 | `294807761d5600a46fc6f841dd4d63a1a2cbbec2` | `services/voice/voice_sidecar/providers.py`, `tests/test_providers.py`: reject ElevenLabs redirects before API key or speech can be forwarded |
| MET-30 / MET-33 | `c401fcbf6642bf9d2e7bd2419756fec333e62511` | Five `renderer/voice/` files: shared UI session/generation allocation, external start/end sink hooks, same browser context and cancellation regressions |

The redirect regression uses two local HTTP origins and all 301/302/303/307/308 statuses;
the destination receives zero requests. Removing the protection in memory reproduces failures.
All **13 Python tests**, **43 TypeScript voice tests** (32 renderer + 11 main), and **31 contract/
router tests** passed. Full type check, root lint, build and diff checks passed after consuming
integration's shared test-import fix `152910f`. Integration checkpoint `80d0a32` supplied the
browser contracts and `70f3fa5` supplied the setup schema. Integration owns all combined app
launch/acceptance; none was run in this resumed lane. No live provider credentials were needed.

UI peer `0Deggd-1yhpEcPc6csOuv` agreed to provide `reviewSessionId`, `allocateReviewTurn()` and
`externalVoiceTurn`. Pass these to `sessionId`, `allocateIdentity`, `onTurnStart`, `onTranscript`,
`onAnswer`, `onAction` and `onTurnEnd` as documented in the renderer README. Transcript delivery
never starts another agent turn. UI's allocator is shared with typed questions and survives
controller recreation; voice rejects reused/foreign identities. A final transcript passes the
current browser observation to that same agent identity. Interruption closes audio synchronously,
aborts local work and sends both explicit cancellation RPCs; late allocations still receive a
compensating cancel. Completion reaches the UI sink only after speech drains.

Root supplies main lifecycle, credentials and `voice.status/configure/prepare`; UI supplies setup
controls. No duplicate setup store/router was added. The exact executable, ready/start, credential,
voice ID and timeout mapping is in `apps/desktop/src/main/voice/README.md`. Source mode uses
Python 3.13 plus the pinned lock. The old frozen artifact predates the redirect fix and must be
rebuilt. Live microphone/provider speech and response latency remain unmeasured; Apple framework
signing/notarization remains a separate runtime release dependency. No acceptance ticket is marked
Done by this resumed handoff.

## Commits and ownership

Base: published integration `b7712cc`. Parent commits: `041732d` protocol, `197384a` main
bridge/router, `67d6d81` cancellation cleanup, `8ace9cc` warmup, `eb65322` cold-start deadline.
Launch-only: `8eb3b7f` site/script/recording plan, `859bccf` provider references.

Both initial SuperiorSwarm workers used separate worktrees and non-overlapping scopes:

| Worker | Reviewed source | Commit in hack/voice | Scope |
| --- | --- | --- | --- |
| hack/voice-python | 5723223 | 95af65a | services/voice |
| hack/voice-renderer | 7b30602 | 1d6cabd | apps/desktop/src/renderer/voice |

No shared contracts, Bun manifests, root app wiring, UI controls, agent intelligence or runtime
signing files were edited by voice. Integration approved the voice-local pinned Python lock on
MET-8. Final worker evidence `11a4850` is integrated as `660e762`; the final delivery commit also includes this report and validation observations.

## APIs for integration

`main/voice/index.ts` exports `VoiceSidecar`, `VoiceService`, `createVoiceRouter`.
Register `voice.offer/release/speak/cancel/poll`. `VoiceSidecar.prepare()` warms the private
loopback child; await it before enabling capture. Main supplies keys from the runtime secure
store and a configured ElevenLabs voice ID. Dispose voice before runtime shutdown.
See `apps/desktop/src/main/voice/README.md` for the factory example and resource layout.

`renderer/voice/index.ts` exports `createVoiceController`, `createBrowserMediaFactory` and
ports. The controller supplies `beginCapture/endCapture/interrupt/getPhase/subscribe`, a typed
VoiceState snapshot and transcript, `connecting`, `getIdentity`, and latency/action callbacks.
Its `beginCapture` is synchronous so early key release can cancel pending microphone permission.
UI owns global Space, microphone controls and readiness/transcript display. During setup,
`connecting` is true and phase is idle; wait for listening before speaking. No preroll exists.

A final transcript starts exactly one agent turn with the current screen. The acknowledgement
and agent work start independently. Text deltas stream through a serial sentence queue;
completion can speak while background work finishes. Tool selection stays in agent intelligence.
Cancellation synchronously disconnects audio and stops capture, invalidates the generation,
then explicitly cancels both sidecar and agent. Late offers/starts trigger compensating cancel;
late transcript/action/audio events cannot resume the retired turn.

## Validation and latency

Parent verification: 38 TypeScript voice tests; 12 Python tests; 29 shared/router tests;
full type check, root lint, production build and diff checks passed. Existing native Electron
IPC smoke passed actual seeded repository/source/scenario C/phone+desktop preview/shutdown
checks. It does not exercise voice because root registration remains integration-owned.

Python tests use real local aiortc/Pipecat DTLS/SRTP and mock provider HTTP/WebSockets.
They validate actual wire payloads, PCM ingress pacing, release/endStream/final transcript,
serial speech and output fences, cancellation before/during allocation and provider work,
stale generation replacement, auth/schema/body limits and cleanup/resource caps.

The real Electron Chromium smoke uses a fake microphone and local oscillator. It verifies
non-silent received PCM, decoder activation, separate acknowledgement/answer samples,
serial speech, fresh peers, immediate interruption and late-permission cleanup. Parent’s
single run measured **118.8 ms acknowledgement** and **876.9 ms answer** from PTT release
to observed Web Audio PCM. These are synthetic instrumentation observations, not live-provider
benchmarks, acoustic end-of-speech or physical-speaker latency. Raw samples and scope are in
`voice-validation.json`. Live latency remains unmeasured without configured providers.

The parent main-to-frozen-binary bridge also passed: warm prepare 772 ms, authenticated
cancel-before-offer and shutdown 191 ms, with zero provider requests. Final bundle inventory:
314,304,181 logical bytes, 521 files, 274 Mach-O files, 120 symlinks. The stable local artifact
is in the voice-python worktree under `services/voice/dist/metahackathon-voice`; copy its
whole directory, not just the executable. Recorded hashes and build evidence are committed
under `services/voice/evidence/`.

Parent strict signature audit: **273 of 274 Mach-O files pass**. The nested
`_internal/Python.framework/Versions/3.13/Python` and framework root fail with
“code has no resources but signature indicates they must be present.” The collected framework
lacks `_CodeSignature/CodeResources`. Runtime must seal/sign the enclosing framework and verify
the complete app; the audit changed no artifact bytes. This bundle is not distributable as-is.
The exact failure and runtime handoff are on MET-28/MET-40.

Review fixes included paced STT ingress, bounded independent teardown, strict voice cancellation
payloads, listening only after connection, PR keyword snapshots, muted Chromium decoder activation,
and preserving decimal numbers split across token chunks.

## Remaining integration and acceptance

1. Register main voice lifecycle/router and packaged executable path. Warm before capture,
   expose preparing/errors and await shutdown. Final frozen inventory belongs in runtime’s
   recursive signing pipeline; rehash after signing. The final first server boot took **127.376 seconds**, followed by **0.493 seconds** warm. The preparation deadline is 180 seconds;
   clean-machine signed startup remains a release risk, separate from response latency.
2. Supply Meta/ElevenLabs credentials and accessible voice ID. Confirm model/voice entitlement,
   then measure cold/warm live turns. Use OS microphone permission in the integrated app.
3. Bind UI transcript/answer/action sinks to the **same voice identity**. Existing private UI
   `conversation.applyAction` needs a UI-owned external-turn adapter. Do not call
   `runAgentQuestion` from onTranscript: that would create a second turn. Publish
   `screen.update` for the voice session and interrupt on navigation.
4. Agent `show_scenario/show_preview` currently resolve existing artifacts. For the spoken
   scenario C demo, populate the catalog with actual runtime execution first, or add an
   agent-owned execution tool. Voice must not turn phrases into fabricated tool outcomes.
5. Runtime completes Developer ID signing/notarization/DMG/update verification. CI secrets:
   MAC_CSC_LINK, MAC_CSC_KEY_PASSWORD, APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID.
   Missing credentials leave C-1 unresolved; they do not activate C-7.
6. Rehearse the 275-word/180-second E-1 script, record a real quiet-room demo with visible
   transcript, and review the exported file. Fill `recording-plan.md` evidence and attach the
   actual video to MET-44. Then set the verified video/release/public-repository metadata in
   `apps/site/launch.json` and publish the static site. E-2 is not complete without a recording.

All contract/composition requests and progress are recorded on MET-8 and the owned Linear
issues. Acceptance tickets remain open for integrated/live/signed checks; C-7 stays Backlog.
