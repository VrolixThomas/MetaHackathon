# MetaHackathon — V1

Talk or type with an agent. A pull request is optional. The startup screen is an empty real
conversation; it has no demo PRs, fixture explanations or scripted answers.

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

Open **GitHub**, then **Connect GitHub**. The app imports your existing `gh` login into the
configured `.env`; if necessary, first run `gh auth login --hostname github.com`.
It lists your open authored PRs and review requests. Selecting one adds bounded real description
and patch context to the conversation. You can remove that context and keep talking.
There is no sample PR fallback. V1 conversation has no GitHub posting tool.

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
bun test apps/desktop/src/shared apps/desktop/src/main apps/desktop/src/renderer
services/voice/.venv/bin/python -m unittest discover -s services/voice/tests
```

The native V1 check uses an isolated `.env` and user-data directory, an actual built Electron
renderer/IPC bridge, and a simulated model. It verifies empty startup, conversation without a
PR, follow-up history, cancellation and cleanup. It does not record a microphone or use saved
credentials. Its report is `apps/desktop/out/v1-smoke-report.json`.

Legacy review/browser/scenario modules and fixtures remain available for tests and later work,
but are excluded from the V1 renderer startup graph. The earlier browser-demo acceptance
report in `docs/integration/acceptance.md` is historical, not the current product flow.
Ownership and shared interface rules are recorded in [AGENTS.md](AGENTS.md) and Linear MET-8.
See [V1 acceptance](docs/integration/v1-acceptance.md) for the verified live voice round trip,
real GitHub connection, test results and current screenshot.
