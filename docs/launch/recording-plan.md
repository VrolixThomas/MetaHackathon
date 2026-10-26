# Demo recording coordination

MET-44 / E-2 is not complete. No recorded demo exists in this handoff. A script, rehearsal,
screenshot, synthetic clip or test report does not satisfy recording acceptance.

## Owners and readiness

| Owner lane | Deliverable before the take |
| --- | --- |
| Voice | Integrated microphone, visible live transcript via UI, audible acknowledgement/answer, interruption, measured latency; E-1 timed script; quiet room and audio levels |
| UI | Sidebar, Why lens with provenance, synchronized scenario highlights, phone preview, sign-off and explicit draft confirmation |
| Agent | Live Muse Spark answers and spoken tool dispatch with current screen context; scenario C request reaches runtime |
| Runtime | Seeded demo PR/revisions, real scenario evidence and phone preview; signed release status and exact download URL |
| Integration | Compose the approved lane commits; verify credentials without exposing values; confirm allowed demo repository and final public links |

## Run of show

1. Use a quiet room, headphones to prevent feedback, and a stable microphone. Record a
   ten-second voice/system-audio sample and play it back before the full take.
2. Start a clean app session with the transcript visible. Open only the shop-web demo PR;
   disable notification previews. Preserve the actual base/head revisions in the evidence log.
3. Rehearse `demo-script.md` once with a stopwatch. Leave response and execution audio intact.
4. Record at 1920×1080 or higher with legible code and transcript. Capture microphone and
   application audio. Target 180 seconds or less after honest, disclosed cuts.
5. Play the exported video from beginning to end. Check narration intelligibility, agent audio,
   subtitle timing, no secrets, correct code highlights, scenario result and phone preview.
6. Upload the actual exported video to the agreed destination. Test the link without the
   owner’s session. Update `apps/site/launch.json` only with that verified HTTPS URL.
7. Attach/link the recording and evidence to MET-44. Mark Done only after the actual recording
   meets the acceptance criteria. Then finish the C-8 landing-site publication handoff.

## Evidence to fill after recording

- Recording file path and SHA-256:
- Export duration and dimensions:
- Integrated application commit and provider/model versions:
- Demo repository, PR and base/head SHAs:
- Scenario execution run IDs:
- Voice latency samples/report:
- Reviewer of full exported take:
- Public video URL and anonymous-view check:
- Any disclosed cuts or omitted posting action:

## Current prerequisites

Local environment variables `MODEL_API_KEY`, `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID`
were unset when checked on 2026-10-26. Keys may instead be configured in runtime’s secure
store; that path and account entitlement need integrated verification. Do not paste secrets
into Linear or this file. Repository visibility was private and no GitHub releases were listed.
The signed release also needs runtime’s Apple CI credentials. These are concrete remaining
integration/launch requirements, not proof that the Python packaging approach failed.
