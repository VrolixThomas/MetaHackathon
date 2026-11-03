# Live demo rehearsal

This explicit test launcher uses the default built Electron renderer, preload, IPC,
ConversationService, actual Meta model calls, real app-owned coding workers/Git/checks,
and the production Python/Pipecat/WebRTC/ElevenLabs speech-output pipeline.
Only ASR is replaced with scripted final text. A synthetic local microphone stream
triggers the real hands-free controller. Speakers are muted by default; this does
not verify physical microphone/speaker acoustics or live ASR latency.

GitHub, Linear and Slack use controlled source transports with public demo repository
commits. Provider write receipts are simulated and recorded separately. Nothing is
sent to real GitHub/Linear/Slack. Normal application startup never imports this setup.
Each run creates its own marked temporary profile, repository and configuration;
the existing user profile and demo jobs remain untouched.

## Run

Install repository dependencies with `bun install --frozen-lockfile`. Set up the
Python 3.13 voice environment using `services/voice/README.md` first.
Supply a private development `.env` containing `MODEL_API_KEY`,
`ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID`. Calls consume actual provider usage.

```sh
node scripts/demo-rehearsal/run.cjs --live --suite=all --exit --env-file=/absolute/path/to/.env
```

The launcher builds the desktop and prints the owned report path. `--no-build`
reuses an already built desktop; use it only when production source is unchanged.
`--audible` enables physical output. There is a 25-minute run deadline and a
120-call foreground/preparation budget; each coding child has its own bound.

Available suites:

- Default `common`: planning, choice, consequence/rationale/failure questions,
  barge-in, quiet Stop and Continue. Discussion must admit zero jobs.
- `--suite=all`: common plus actual coding admission, PR review, pinned source flow,
  real companion browser/phone, suggested fix, notify-only and conditional approval,
  Slack clarification, and actual ready-job/candidate review/checks.
- `--suite=actions`: the latter action scenes alone.
- `--suite=review`: PR explanation, pinned flow and persistent browser/phone.
- `--suite=variants`: a second ticket, different planning phrases and a source question.
- `--suite=planning`: the initial planning/choice/followup questions without voice control cases.
- `--suite=collaboration`: suggested fix, approval and Slack scenes alone.
- `--suite=delegation`: approval and Slack scenes alone.
- `--suite=slack`: Slack clarification alone.

While speech quota is unavailable, `--text-diagnostics` uses the real typed renderer form, models, tools and native receipts for named subsets. It does not synthesize or simulate voice. Reports explicitly set voice/ASR flags to false; these runs cannot pass spoken acceptance. A displayed proposal dialog is closed through its real Close button before a typed followup, preserving its actual presentation receipt.

Subset completion is not full-demo acceptance. Required scenes fail on missing
actual state, source, display or check evidence; model claims alone never pass.

`--reuse-reviews=/absolute/path/to/musefocus-rehearsal-XXXXXX` reuses only the three
validated immutable review plans from an earlier owned actual-model run, with exact
PR base/head matches. Jobs, progress, dialogue and decisions are never copied.
The default always prepares reviews through the actual model.

For manual scripted turns:

```sh
node scripts/demo-rehearsal/run.cjs --live --interactive --env-file=/absolute/path/to/.env
node scripts/demo-rehearsal/control.cjs status
node scripts/demo-rehearsal/control.cjs say Open MET-77 and explain the product tradeoff.
node scripts/demo-rehearsal/control.cjs inspect
node scripts/demo-rehearsal/control.cjs stop
```

The control endpoint is loopback-only, requires a per-run private token, and rejects
browser-origin requests. The CLI reads that token without printing it.

## Evidence and acceptance

`report.json` contains actual model answers, fixed model/tool metadata, registered
argument property/type/enum diagnostics, real first-PCM timings, UI/state assertions,
and separately labeled controlled provider writes. Raw model inputs, reasoning,
credentials and raw tool arguments are excluded. Audio segments are actual provider
PCM, with WAV copies for completed segments. The owned directory also contains
private development configuration; share selected reports/audio, not the whole run.

```sh
node scripts/demo-rehearsal/assess.cjs /absolute/path/to/report.json
```

Numeric targets: common transcript-to-PCM median <=3s and p90 <=5s; straightforward
navigation/planning <=5s. ASR and the synthetic VAD trigger are reported separately.
A failure is printed with a nonzero exit. Qualitative review must additionally establish
useful consequences, reasoned recommendations, no repeated screen/checklist reading,
settled-choice continuity, accurate effect ownership and no invented guarantees.
The numeric assessor deliberately leaves that judgment pending.

`probe.ts` is a separate actual-model prompt comparison, not native or spoken
acceptance. Build it with Bun into ignored `apps/desktop/out/demo-rehearsal/` and
run with Node, optionally passing the private env file as its first argument.
It logs only synthetic questions/answers and numeric model timings.
