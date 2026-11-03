# MET-8 standing clarification native acceptance

Root runs this against the **built integrated default app** containing a33b651 (or
its successor). The author has not launched Electron. This is a CJS entry point,
not a new app build, package script, controller unit test or installed-profile test.
No dependency installation is needed. Only these new test/helper files are owned.

From the integration checkout, after root's normal build:

```sh
cd apps/desktop
env -u ELECTRON_RUN_AS_NODE -u ELECTRON_RENDERER_URL ../../node_modules/.bin/electron src/main/standing-clarification-smoke.cjs out/main/index.js
```

The single structured report is
`apps/desktop/out/standing-clarification-smoke-report.json` (overwritten each run).
Expect roughly six minutes: production rules have a five-minute minimum lifetime.
The gate uses real elapsed time, with an 8.5-minute deadline and nine-minute hard
exit. Keep the Mac awake. `status: passed` means the typed controlled gate passed;
it does **not** mean the separately reported `voice.status: not-run` passed.
Failures exit nonzero and retain assertions/partial evidence in the same report.
The report includes built-main/renderer hashes, actual ingress/checkpoint/receipt
identities, controlled HTTP observations, each assertion group, and SQLite bytes
reopened read-only after actual app shutdown. It does not prove process restart.

## What executes

- Actual App, renderer typing form, preload, tRPC, foreground tools and main
  `narrateProposal`. The IPC observer forwards the original renderer receipt
  unchanged. It observes two actual visible frames of the exact canonical text
  before forwarding the displayed acknowledgement. No test calls to
  `conversation.narrationApplied`, standing controllers, `day.operate` or capture
  injection create authority. Only observed checkpoints/receipts count.
- Actual Settings manual-token import against controlled Slack `auth.test`, scope
  and membership responses. A real sidebar selection must become an acknowledged
  visible Slack canvas. Startup has no repository, PR, jobs or demo content.
- Canonical policy includes channel, scope, every bound, exclusions and final
  activation question. SQLite remains proposed until a later actual typed `yes`.
  Confirmation must use distinct request/turn identities after publication, and
  the persisted exact policy digest/actor/channel and five-minute lifetime match.
- An incoming literal mention by another controlled author is classified through
  the actual model HTTP transport and SlackWorkspace path. A prior captured
  message remains pending and gets no standing admission. Fresh post-confirmation
  intake receives a durable parent-bound child with `confirmedAt: null`.
- The first child reaches the real original-thread sender. Controlled
  `chat.postMessage` checks a pre-existing uncertain outbox reservation, live
  parent bounds, exact question and original thread. Its controlled provider
  message ID must match the actual persisted delivery receipt and body digest.
  No ownership, coding job, final-answer receipt or work completion is granted.
- A second child has its model HTTP response held while an actual typed revoke
  lists and revokes the exact rule through foreground tools. The released result
  cannot send. A new mention after revoke gets no admission.
- A second confirmed rule uses the real clock. Shortly before expiry a new child
  reaches held model analysis; after expiry the response is released and cannot
  send. Child expiry equals parent expiry. A subsequent mention gets no admission.
  A late admission or slow intake fails the timing assertion rather than moving
  the clock or silently claiming expiry coverage.
- App shutdown closes SQLite; the test reopens the owned database read-only and
  verifies two rules, three retained admissions and exactly one delivered outbox.

The policy is three threads, one question each, three total. This gate checks the
actual persisted bounds and parent revoke/expiry enforcement, not an additional
budget-exhaustion matrix. Existing controller/unit regressions cover that matrix.

## Isolation and provenance

`provider.cjs` supplies controlled HTTP responses only, reusing the SSE protocol
helper from `comment-conversation-smoke/model.cjs`. Isolation and verified-owned
cleanup follow `slack-clarification-smoke.cjs`. No Git fixture is needed.
Inherited provider credentials are scrubbed, a mode-0600 temporary `.env` holds
obvious fake values, and a new temporary user-data/SQLite profile is selected
before importing built main. The installed profile and repository `.env` are not
used. Chromium remote requests, external browser launches, WebSockets, permissions
and application child-process entry points are blocked. The only successful send
is an in-process controlled HTTP response; there are no real Slack messages or
live provider calls. Normal cleanup removes only the inode/owner-verified temporary
root; a hard timeout reports its retained location.

The report explicitly sets `controlledHTTP: true`, `liveSlack: false`,
`liveModel: false`, `liveSpeech: false`, and `syntheticAudio: false`. No audio is
produced by this typed gate. Controlled model output is inferred analysis, not
execution proof of report preparation.

## Separate voice acceptance still required

`attention-smoke.cjs` and exported `installControlledMedia` /
`measureControlledPcm` in `hands-free-smoke.cjs` are the existing real WebRTC/PCM
simulation foundation. Attention uses assistant-only ingress and cannot establish
an actual user voice confirmation. This test deliberately does not turn a typed
turn into voice with an RPC argument or manufacture a spoken publication receipt.
A separate root-owned foreground voice harness must do all of the following:

1. Build with `VITE_MUSE_VOICE_PRECONNECT=0`, as existing controlled cold-media
   gates require, and select the same controlled Slack channel through the App.
   Start actual hands-free UI with synthetic microphone audio. Supply the standing
   request as the controlled ASR transport's recognized utterance; observe actual
   `conversation.start` with `inputMode: voice` and distinct app-generated identity.
2. Deliver canonical proposal TTS through the actual controlled media bridge.
   Hold terminal speech-ended/media drain after observed non-silent PCM. Assert
   there is no accepted `spoken` checkpoint and SQLite is still proposed.
3. Release matching speech-ended and let PCM/media drain. Observe the renderer's
   own `conversation.narrationApplied` for that exact checkpoint. Only then feed
   a **new** synthetic microphone utterance with controlled ASR `yes`. Require a
   distinct actual voice ingress and durable activation of that exact policy.
4. Repeat with a new proposal and interrupt before drain (Stop speech or actual
   barge-in). Feed a new actual voice `yes`. Require no activation, no accepted
   spoken checkpoint for the interrupted proposal, and retained listening for
   barge-in. Also test a typed/displayed proposal followed by voice `yes`: display
   alone must not activate a voice confirmation.
5. Label the resulting evidence `controlled providers`, `synthetic audio`, actual
   WebRTC/PCM drain, and no physical microphone/speaker or live provider proof.
   Do not reuse attention's pre-seeded ledger as standing consent or call main
   publication/controller methods directly.

There is no claim or executable command for an implemented standing voice gate in
this handoff. Existing hands-free/attention pass results alone do not close it.

## Author validation (no native launch)

```sh
node --check apps/desktop/src/main/standing-clarification-smoke.cjs
node --check apps/desktop/src/main/standing-clarification-smoke/provider.cjs
node --check apps/desktop/src/main/standing-clarification-smoke/scenario.cjs
node --check apps/desktop/src/main/standing-clarification-smoke/self-check.cjs
node apps/desktop/src/main/standing-clarification-smoke/self-check.cjs
./node_modules/.bin/biome check apps/desktop/src/main/standing-clarification-smoke.cjs apps/desktop/src/main/standing-clarification-smoke/*.cjs
```

The self-check only validates controlled transport ordering/filtering/SSE and
unexpected-origin rejection. It imports no application services, launches no
processes, opens no network/database/audio, and is not native acceptance evidence.
