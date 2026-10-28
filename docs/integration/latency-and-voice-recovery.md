# Slow replies and stopped voice: investigation and fix

Date: 2026-10-28. Application checkpoint: `b647976`.

## Findings from the user's last experiment

The last persisted model usage record in the normal app profile was `incomplete` with
4,410 input tokens and exactly 512 output tokens on `muse-spark-1.3`. The guided-review request
was configured with a 512-token output budget. That matches a reproducible output-limit failure.
The old voice controller treated an agent/model failure as fatal to the entire hands-free
microphone session, so an unsuccessful reply could look like voice had crashed.

No new Electron/macOS crash report was found for that experiment. The previous usage format
had no per-request timestamp or latency trace. A whole-window/process crash is therefore not
confirmed by this investigation; the persisted incomplete model result and fatal session path
are confirmed evidence, not a claim about an unobserved OS exit.

PR review also buffered the entire model response before publishing any text, including the
answer after navigation had already been acknowledged. That postponed speech unnecessarily.
Other existing waits remain: approximately 700 ms silence detection, per-utterance RTC/Meta
setup and buffered input drain, transcript finalization, model requests, and sentence synthesis.
The old first-audio metric started after release and did not include all of those waits.

## Changes

- Guided requests start with 2,048 output tokens. One retry at 4,096 is allowed only for a
  confirmed output-limit condition before any answer text has been published. Incomplete
  tools are never executed, and already spoken text is never replayed automatically.
- The 1,600-character style limit no longer makes a valid expanded answer fail. Brevity remains
  in the instructions, with a separate 32,000-character memory bound.
- Tool-capable rounds retain their completion/receipt checks. After an acknowledged navigation,
  the answer phase has no available tools and streams text while generation continues, with
  cancellation and current-screen checks on each emitted delta.
- Agent/model/action failures close their failed turn and output, report the error, and leave a
  healthy hands-free input session listening for the next distinct user utterance. They do not
  automatically retry that failed utterance. Device, audio, voice-provider and unknown failures
  retain fatal cleanup and explicit restart behavior.
- Local diagnostics now record timing stages, hashed turn identity and canonical failure/exit
  categories. Model usage rows include UTC timestamps. No transcripts, answers, source, URLs,
  SDP, keys or raw provider bodies enter the diagnostic log.
- A live compatibility check caught Meta rejecting `tool_choice: "none"` with HTTP 400.
  The client retains Meta's supported `auto` value with an empty available-tools list in answer
  phases. Unsolicited function calls are still rejected; no additional action authority is granted.

## Verification

571 TypeScript tests, type-check, lint and build pass. Added behavior checks cover the actual
512-token incomplete accounting, safe bounded recovery, discarded partial tools, no replay,
streaming before terminal completion, stale screen/cancellation fences, healthy-mic recovery,
subsequent user speech, fatal audio cleanup and diagnostic content/permission/rotation boundaries.

The native Electron prepared-review check deliberately returns an incomplete partial function
call on its first guided request. It recovers from 2,048 to 4,096 once, applies six actual UI/source
steps, and proves all six acknowledged answers are visible before a deliberately delayed terminal
event. Exact pinned source, SQLite progress and unchanged dirty files still pass.

The native hands-free check deliberately fails the first model response. The microphone stays
live, the failed output is closed, and a distinct second utterance completes using the same input
stream. End, late-offer suppression and sidecar shutdown pass. The normal spoken-interruption
case also passes. These use real Chromium audio/RTC and controlled providers with synthetic input;
no ambient microphone is recorded.

A separate live Meta check with controlled two-file source completed navigation plus the
streamed answer using the actual client. In that run, the simulated UI receipt occurred at
1,884 ms, the answer callback at 3,523 ms, and provider completion at 3,625 ms. This verifies
compatibility and early delivery on that input; it is not a benchmark of the user's original PR
or physical speech latency.

## Run and diagnose

```sh
cd /Users/Werk/Documents/Repositories/MetaHackathon-worktrees/integration
bun run build
bun run --filter @metahackathon/desktop preview
```

Restart the older window to load the new main process. The normal macOS diagnostic file is:

```text
~/Library/Application Support/MetaHackathon/diagnostics/conversation.jsonl
```

It retains at most a 256 KB current log and one previous log, with owner-only file permissions.
Stages include speech start/end, final transcript, agent start, first answer/audio, turn outcome,
renderer errors and application shutdown/renderer exit. Logging failures do not interrupt voice.

Controlled regression commands after building:

```sh
PREPARED_REVIEW_FORCE_LIMIT=1 PREPARED_REVIEW_STREAM_HOLD=1 bun run test:prepared-reviews
HANDS_FREE_AGENT_FAILURE=1 bun run test:hands-free
```

Remaining uncertainty is the exact duration breakdown of the past experiment and whether a
separate whole-window failure occurred. The new local trace supplies that evidence on subsequent
use. Physical room acoustics were not recorded or reverified in this pass. All newly dispatched
fix workers used Codex after correcting the service's inherited provider default.
