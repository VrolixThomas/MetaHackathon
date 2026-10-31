# Muse — voice command center

Talk with Muse about your requested reviews, feedback on your own PRs, and assigned Linear tickets.
The Home brief and left sidebar show your real work. Muse can run independent coding jobs while
you review, ask about product decisions, and bring completed work back for review. Voice is available
everywhere; text is optional. Startup contains no sample repositories, tickets or scripted answers.

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

Development worktrees reuse `.env` in the main repository checkout when that file exists.
On this machine that is `/Users/Werk/Documents/Repositories/MetaHackathon/.env`.
Otherwise the app uses its checkout-root `.env`; copy `.env.example` if needed.
`METAHACKATHON_ENV_FILE` explicitly selects another file. Git never transfers local credentials.

```dotenv
MODEL_API_KEY=
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
GITHUB_TOKEN=
LINEAR_API_KEY=
GITHUB_OAUTH_CLIENT_ID=
GITHUB_OAUTH_CLIENT_SECRET=
LINEAR_OAUTH_CLIENT_ID=
LINEAR_OAUTH_CLIENT_SECRET=
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

Wait for **Voice ready**, then click **Start conversation** once. Speak normally; a short pause
ends your utterance, Muse replies, and the microphone stays ready for your next question. Speaking
over a reply interrupts it. **Stop response** stops the current answer while keeping listening on.
**End conversation** or **Command–Shift–Space** turns the microphone off; the shortcut also starts
it when off. **Escape** dismisses an open workspace dialog first, otherwise ends the conversation.
No PR selection or button-holding is required.

The session uses one microphone stream. Speech detection and a bounded pre-roll buffer run locally;
utterances are sent through the existing speech/model providers. Source navigation can interrupt a
reply without ending the microphone session. Stop, error and app shutdown release capture.
While listening, Muse prepares one bounded speech connection before the next utterance. It expires
after 20 seconds and falls back to the ordinary connection path. To disable this optimization for a
diagnostic build, set `VITE_MUSE_VOICE_PRECONNECT=0` when building.

Configuration reports microphone permission from the running app's process. Use **Request
microphone access** if needed. macOS permission can be attributed to the development launcher;
check the app's status before changing unrelated system settings.

## Real GitHub context

Open **More → Settings** or **Manage connections**, then **Sign in with GitHub** to authorize
in your system browser. Register the app once using the [OAuth setup guide](docs/integration/oauth-setup.md).
The app saves the resulting account tokens encrypted in its private user-data directory.
For development, `GITHUB_TOKEN` and **Other connection methods → Import GitHub CLI sign-in**
remain available. Use the sidebar **+** or **Home → Manage connections**
to add `owner/repository` or choose a local clone. Multiple repositories stay connected together.
Incoming requested reviews and your own PR feedback appear separately.
The icon rail selects a sidebar list. Browsing another list leaves your open review, browser or
document in place; selecting a specific item opens it. Recent canvases are available from Home.
There is no sample PR fallback. Ordinary conversation works without GitHub or a selected PR.
Cached ready reviews still require GitHub access to verify their current revisions before opening.
If GitHub is unconfigured, the workspace offers **Connect GitHub** directly.

## Tickets and background work

Choose **Sign in with Linear** in Settings or Manage connections, authorize your workspace in the
browser, then select teams or projects. A personal `LINEAR_API_KEY` in `.env` is also supported.
Muse fetches tickets assigned to your Linear user; selected team and
project scopes form a union. With no selected scopes, all of your assigned active tickets are shown.

Say **“What needs my attention?”**, **“Start work on MET-123 in owner/repo”**, or open a ticket and
start work. Muse uses the Meta model configured by `MODEL_API_KEY`; it does not require SuperiorSwarm,
Claude, or Codex to be installed. Each job has a separate app-owned Git copy/worktree and child process.
The original clone's branch, index and dirty files stay intact. Product questions and departures from
repository conventions become saved decisions; answer by voice or in the job view. Ordinary changes
and actual check results come back for review.

Closing the app pauses active processes and saves checkpoints. Reopening resumes work interrupted
by shutdown; explicitly paused jobs stay paused. Foreground speech interruption never cancels a
background job. **Activity queue** holds decisions, completed outcomes and failures. Muse can initiate a short spoken update while hands-free listening is on and the app is focused.
It defers during speech, replies, dialogs and recent interaction, preserves the current review/panes,
and keeps listening when you interrupt an update. The queue remains available manually.

Completed work includes its actual diff, source, commit and command logs. Ask for a revision to keep
working in the same job. **Accept reviewed work** binds acceptance to the inspected head and completes
the linked Linear ticket. **Publish draft PR** pushes the app-owned branch and creates or updates a
real draft; this does not accept or merge it. Supported direct feedback suggestions may be applied
to your own PR branch after actual successful checks and a separate inferred assessment. Product
ambiguity asks for a decision. Disable automatic suggestions in **Manage connections** if desired.

Workers run with your OS permissions, not inside a security sandbox. Declared JavaScript package
checks and standard package managers are supported. Detected custom commit hooks stop the commit;
the repository convention must be resolved rather than silently bypassed. No checks are invented for repositories
without configured validation commands.

## My day and Slack

**My day** holds personal follow-ups, accepted requests, missing-context questions and reviewable
outcomes. You can add a real item yourself without connecting a provider. Incoming Slack requests
remain pending until accepted; a source-bound explicit promise from your own account can count as
acceptance. Muse can prepare isolated work while acceptance is pending, but execution waits for it.
Questions are covered with you when you open the item. Source-backed work closes only after a
confirmed answer in the original thread; personal items use an explicit **I have answered this**.

In **Settings → Slack**, choose **Sign in with Slack** and approve in your browser. The one-time app
registration uses [this manifest](docs/integration/slack-app-manifest.json), enables PKCE, and registers
`http://localhost:43187/oauth/slack/callback`. Configure `SLACK_OAUTH_CLIENT_ID` in the active `.env`.
See the [login setup guide](docs/integration/oauth-setup.md). Muse saves and refreshes the user grant
in its OS-encrypted account store; no client secret or hosted callback is required.

The optional **Developer connection methods** disclosure can instead import a manual user token:

```dotenv
SLACK_USER_TOKEN=
SLACK_APP_ID=
# Optional Socket Mode token for events; it does not grant user access.
SLACK_APP_TOKEN=
```

After connecting, Muse automatically follows all active channels and DMs you belong to, discovers
new memberships, and stops following conversations you leave. Settings → Conversations and exclusions
lets you mute individual conversations. Polling is bounded; edits/deletions can have gaps. DM/private-channel knowledge stays private;
company knowledge uses public channels, with fresh source access checked before retrieval. This
increment runs locally while the Mac is awake and checkpoints through sleep/offline. A shared hosted
company brain and cross-employee transport are not yet available. Slack login preserves existing
GitHub/Linear accounts. Replacing a Slack account clears its foreground context and private queue.

Open **Slack** in the left sidebar to browse channels and DMs. Select a conversation to read its
actual messages, load older pages, refresh, or open a thread. The reader is read-only; confirmed
replies remain in the work-item flow. Ask Muse to show a Slack conversation or explain a thread;
it reads the same provider data and waits for the requested canvas to display before narrating it.
No background history polling runs from the reader itself.

For a verified internal customer-built registration only, `SLACK_INTERNAL_APP=1` selects conservative
Tier 3 pacing. Leave it unset for commercial distribution; server Retry-After always wins.

## Review comments and suggested fixes

With a prepared PR open, use **j / k** to move through its reading order. Typing, dialogs and menus
keep their own keys. **Add PR comment** opens a draft: review its exact wording and optional head-side
line, then explicitly confirm posting. Editing the body or changing the source invalidates consent.

Under **Own PR feedback**, choose **Prepare suggested fix**, or ask Muse to prepare the inspected
feedback. Muse works in a separate app-owned checkout. Open **Suggested fixes** to inspect the original
comment, explanation, changed files, syntax-highlighted diff, **Before**, **Proposed after**, and actual
check results. Previous/Next file uses the same acknowledged navigation as Muse. Source line controls
open the exact candidate revision.

**Mark fix reviewed** records the local candidate revision you inspected. This workflow leaves the
candidate local; publication and merging are separate operations. Failed checks, missing checks,
clarification requests and interrupted work remain visible. Uncertain interrupted executions are
retained rather than silently rerun. No product sample PRs or fix results are loaded at startup.

See [PR work acceptance](docs/integration/pr-work-acceptance.md) for controlled-native test scope.

## Prepared reviews

Add repositories through the sidebar and choose a PR from **Incoming reviews** or **Own PR feedback**. The top-left selector remains available for direct local review access. Muse fetches
open PRs and prepares a reading order, explanations and suggested comments in the background.
Preparation is inferred from the PR description and available patches; it is not execution
proof or a claim about the author's intent. Partial source coverage is labeled.

Select a ready PR and say **“Walk me through this review”**. Muse takes the initiative through
a logical section of consecutive files in the prepared reading order, then pauses for a question or **“Continue”**.
Each file stays on screen until its spoken explanation finishes. Speaking interrupts the walkthrough
while keeping the microphone available. You can also say **“Next file”**, **“Show me
`path/to/file`”**, **“Pause the review”**, or **“Resume”**. Muse opens the pinned source before
narrating. Changes, Before and After views use the PR's actual base/head commits. When those
commits exist in the selected local clone, reads use Git objects without changing your branch,
index or working files. Missing local commits use GitHub's pinned content API.
Changes, Before and After include locally bundled syntax highlighting for common languages;
unknown file types remain exact plain text. Highlighting preserves source line identity.

The repository connection, prepared plans and visited-file progress live in SQLite in the app's
user-data directory. A 60-second refresh runs while the app is open; changed PR revisions invalidate
old plans. **Refresh** checks now, and failed preparation can be explicitly retried. No fixture
fallback is used. Suggested comments remain unposted; the current review flow does not submit them.
The storage interface is separated from orchestration for a later Supabase adapter. Team accounts,
GitHub App/webhook ingestion and preparation while the desktop is closed are future work.

If preparation is still running, its status is shown before opening. Failed preparation has an
explicit retry action. A ready review in any watched repository can be opened by Muse.

## Canvases and browser

Ask Muse to **“Create an explanation document”**, **“Make a checkout mockup beside it”**,
**“Show me the code”**, or **“Open https://example.com”**. It manages code, document, visual and
browser canvases in the same conversation, chooses the primary/secondary panes, and waits for
each change to display before describing it. Tabs and **Split panes** remain available manually.
Documents, visual drafts and source flows are saved privately in app storage; **Recent** reopens closed artifacts.
Ask **“Show the whole payment flow”** to create one continuous source artifact from exact pinned
excerpts, including unchanged files. Source text and locations remain exact; ordering and explanations
are labeled inference. Local repository search is available when the pinned commit exists locally.

The browser is an actual persistent native page. Give an explicit HTTPS address or a running
local HTTP URL. Muse observes the page you see and can click, type, scroll, navigate, and change
desktop/phone viewport. Desktop follows the available pane size; Phone keeps a centered fixed
viewport. Tabs use actual page titles, with navigation/address/viewport in one compact row.
Optional conversation opens on the left of the canvases. You can interact normally too. Drag the divider or use its arrow keys
to resize a split. **More → Open website** opens an address manually. Voice stays available;
**More → Conversation and typing** reveals text only when needed.

Generated documents and SVG mockups are labeled drafts. Visual generation currently uses typed
rectangle/text/line scenes; a raster image generation provider is not connected. Browser pages
carry unverified revision provenance. Opening a URL does not start a development server or prove
which PR revision is running. GitHub comments still require explicit confirmation before posting;
the prepared-review suggested comments remain unposted.

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
bun run test:hands-free
bun run test:prepared-reviews
bun run test:local-browser
bun run test:workspace
bun run test:executive
bun run test:attention
bun run test:oauth
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

Implementation sequence: [product plan](docs/integration/product-plan.md).
Agent control and observation: [navigation investigation](docs/integration/agent-navigation-plan.md).

Latest validation and screenshots: [review workspace acceptance](docs/integration/review-workspace-acceptance.md).

Current hands-free behavior and validation: [conversation polish acceptance](docs/integration/conversation-polish-acceptance.md).

Current canvas and proactive review validation: [multi-canvas acceptance](docs/integration/multi-canvas-acceptance.md).

Browser layout and sizing follow-up: [browser pane acceptance](docs/integration/browser-pane-acceptance.md).

Executive center acceptance and live GitHub screenshots: [executive center acceptance](docs/integration/executive-center-acceptance.md).

Proactive supervision and voice latency evidence: [attention acceptance](docs/integration/attention-acceptance.md).

Sidebar stability and GitHub/Linear login: [sidebar and OAuth acceptance](docs/integration/sidebar-oauth-acceptance.md).

Current latency diagnosis and measured provider stages: [voice latency deep dive](docs/integration/voice-latency-deep-dive.md).
