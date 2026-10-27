# Muse — local PR review

Talk with Muse, connect a real GitHub repository, and review its pull requests in a prepared
reading order. Voice is available without a PR. Text conversation is optional, behind
**Conversation**. The app starts without demo PRs, fixture explanations or scripted answers.

## Run

Use the integrated application from `hack/integration`:

```sh
cd /Users/Werk/Documents/Repositories/MetaHackathon-worktrees/integration
bun run build
bun run --filter @metahackathon/desktop preview
```

On another checkout, install Node 22.12+ and Bun 1.3.9+, then run
`bun install --frozen-lockfile`. Installation rebuilds SQLite for Electron.

## Configure

The development app reads repository-root `.env`. Copy `.env.example` if needed:

```dotenv
MODEL_API_KEY=
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
GITHUB_TOKEN=
```

Configuration shows the active path and whether values are present. **Open configuration**
opens the file in an editor; **Reload** applies changes. Keys are never returned to the renderer.
The file is Git-ignored and app writes use owner-only permissions. Existing saved settings
migrate once into `.env`; explicit file values win and the previous encrypted store is retained.
`META_API_KEY` and `GH_TOKEN` are accepted aliases when their canonical keys are absent.

Speech also needs the local Python environment:

```sh
python3.13 -m venv services/voice/.venv
services/voice/.venv/bin/python -m pip install -r services/voice/requirements.lock
```

That environment is already installed in the integration checkout on this machine.
Voice prepares automatically once Meta, ElevenLabs and a voice ID are configured.
`METAHACKATHON_VOICE_PYTHON` can select an existing Python executable.

## Talk

Wait for **Voice ready**. Hold the microphone button, wait for **Listening**, speak, then
release. **Command–Shift–Space** toggles capture from anywhere in the app, including a text
field. **Stop** or **Escape** interrupts speech and cancels the current turn. Plain Space
continues to type normally in the composer. No review or PR selection is required.

Configuration reports microphone permission from the running app's process. Use **Request
microphone access** if needed. macOS permission can be attributed to the development launcher;
check the app's status before changing unrelated system settings.

## Real GitHub context

Open **Configuration**, then **Connect GitHub**. The app imports your existing `gh` login
into the configured `.env`; if necessary, first run `gh auth login --hostname github.com`.
You can also set `GITHUB_TOKEN` directly. Then connect your repository as described below.
There is no sample PR fallback. Ordinary conversation works without GitHub or a selected PR.

## Prepared reviews

Open **Repository** and choose a local GitHub clone, or enter `owner/repository`. Muse fetches
open PRs and prepares a reading order, explanations and suggested comments in the background.
Preparation is inferred from the PR description and available patches; it is not execution
proof or a claim about the author's intent. Partial source coverage is labeled.

Select a ready PR and say **“Walk me through this review”**, **“Next file”**, **“Show me
`path/to/file`”**, **“Pause the review”**, or **“Resume”**. Muse opens the pinned source before
narrating. Changes, Before and After views use the PR's actual base/head commits. When those
commits exist in the selected local clone, reads use Git objects without changing your branch,
index or working files. Missing local commits use GitHub's pinned content API.

The repository connection, prepared plans and visited-file progress live in SQLite in the app's
user-data directory. A 60-second refresh runs while the app is open; changed PR revisions invalidate
old plans. **Refresh** checks now, and failed preparation can be explicitly retried. No fixture
fallback is used. Suggested comments remain unposted; the current review flow does not submit them.
The storage interface is separated from orchestration for a later Supabase adapter. Team accounts,
GitHub App/webhook ingestion and preparation while the desktop is closed are future work.

## Browser beside the review

Use **Local preview** to open a local website that you already have running. Enter its full
`http://localhost:port` or `http://127.0.0.1:port` address. The right pane is an actual persistent
native browser, with normal page interaction, back/forward/reload and desktop/phone viewports.
Drag the divider or use its arrow keys to resize the split. Voice controls stay available;
**Conversation** reveals text input and replies only when needed.

The pane labels this as a local preview: it does not start a development server or prove which
PR revision is running. Current guided-review tools operate source navigation; automatic
agent operation of this manually opened page remains separate integration work.

## Distribution configuration

A packaged app uses `~/Library/Application Support/MetaHackathon/.env`. A user-provided `.env`
placed alongside the `.app`, or provided in its resources before packaging, seeds that file on
first startup. Existing installed configuration is preserved. `METAHACKATHON_ENV_FILE` can
explicitly select a different local file. No real credentials are committed to this repository.
Developer ID signing, notarization and signed updates remain separate release checks.

## Validation

```sh
bun run type-check
bun run lint
bun run test:contracts
bun run test:integration
bun run test:prepared-reviews
bun run test:local-browser
bun test apps/desktop/src/shared apps/desktop/src/main apps/desktop/src/renderer
services/voice/.venv/bin/python -m unittest discover -s services/voice/tests
```

The native V1 check uses an isolated `.env` and user-data directory, an actual built Electron
renderer/IPC bridge, and a simulated model. It verifies empty startup, conversation without a
PR, follow-up history, cancellation and cleanup. It does not record a microphone or use saved
credentials. Its report is `apps/desktop/out/v1-smoke-report.json`.

The prepared-review native check creates a temporary Git repository with dirty work preserved,
uses controlled GitHub/model responses, and checks source, action acknowledgements and SQLite
persistence through the real Electron UI/IPC. The local-browser check serves an owned loopback
website and exercises native browser navigation and lifecycle. Neither records a microphone.

Legacy scenario modules and fixtures remain available for tests and later work,
but are excluded from the current renderer startup graph. The earlier browser-demo acceptance
report in `docs/integration/acceptance.md` is historical, not the current product flow.
Ownership and shared interface rules are recorded in [AGENTS.md](AGENTS.md) and Linear MET-8.
See [V1 acceptance](docs/integration/v1-acceptance.md) for the verified live voice round trip,
real GitHub connection, test results and current screenshot.
