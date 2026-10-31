# macOS packaging and release evidence

The normal `electron-builder.yml` requires Developer ID signing and notarization.
Only root/integration runs native build, freeze, package and launch commands.
Bounded workers run `node --test apps/desktop/packaging/*.test.cjs`: those checks
use inert native headers and synthetic ASAR/update files, and prove policy only.

The main app and helpers receive JIT and audio-input entitlements from
`resources/entitlements.mac.plist`. The microphone description explains Start/End
hands-free use. Actual microphone permission and voice require separate integrated
checks inside the installed app's responsible process.

## Production payload

Production copies the complete existing PyInstaller onedir output from
`services/voice/dist/metahackathon-voice` to `Contents/Resources/voice`, preserving
the `_internal` layout. Main already launches `Resources/voice/metahackathon-voice`.
There is no bundled demo repository or runtime dependency on a user Python install.
Freeze on the target Apple Silicon Mac using the existing locked pipeline:

```sh
python3.13 -m venv services/voice/.venv
services/voice/.venv/bin/python -m pip install -r services/voice/requirements.lock
services/voice/.venv/bin/python services/voice/scripts/freeze.py
```

The freezer imports native code and exercises controlled local transport. Root
alone runs it; it makes no live speech-provider request. CI uses Python 3.13.3 and
refuses a runner whose actual architecture is not arm64. The bundle must correspond
to the release source; retain its freezer reports with that build.

Pre-pack checks reject missing/non-native executables, missing internal libraries,
architecture mismatches and escaping/broken symlinks. Post-pack checks inspect the
ASAR and external payload: pinned production Muse SDK and its relative JS imports,
coding worker, unpacked native SQLite addon, SQL migrations and frozen voice layout.
The SDK stays inside ASAR; the vendor CLI is user-installed and is never bundled
or automatically installed. Configuration and credentials are not bundled.

The installed electron-builder/osx-sign walker signs native extraResources.
`after-sign.cjs` independently verifies every Mach-O, including `.node`, `.so`,
`.dylib` and sidecar executables. Missing, foreign-team or ad-hoc signatures fail.
The freezer's inventory describes its pre-sign input bytes. Signing changes them;
`signing-evidence.json` records final signature verification and does not claim
that the freezer inventory hashes describe the signed payload.

## Root-only package acceptance

After normal `bun install --frozen-lockfile` (including native rebuild) and the
sidecar freeze, run from `apps/desktop`:

```sh
# Content/mechanics only: no Developer ID or notarization claim.
MUSE_ROOT_RELEASE_ACCEPTANCE=1 node packaging/accept-macos.cjs unsigned
# Requires the five inputs below and contacts Apple notarization.
MUSE_ROOT_RELEASE_ACCEPTANCE=1 node packaging/accept-macos.cjs signed
```

Both build/package the real app into a new ignored output directory with
`--publish never`, verify production contents, and write `packaging-acceptance.json`
only after success. Neither launches the app. Signed mode also runs finalization:
Developer ID/hardened signatures from the expected team, microphone entitlement
and current Info.plist metadata, app staple/Gatekeeper acceptance, final DMG
notarization/stapling, regenerated DMG blockmaps and verified update hashes.

Root must separately launch the installed package with a user-provided `.env`,
verify Start/End and actual microphone/voice, and exercise an update between two
published signed versions. Package/hash checks alone do not establish those gates.
Unset `ELECTRON_RUN_AS_NODE` when launching Electron as an app. Use isolated user
data and clean up only the process and temporary files owned by that check.

## Signing inputs and release candidate

The supported credential set is explicit; no credentials are configured by this
scaffold. Configure these only in GitHub's `release` environment:

| CI secret | Process environment | Required input |
| --- | --- | --- |
| `MAC_CSC_LINK` | `CSC_LINK` | Base64 Developer ID Application `.p12` with private key |
| `MAC_CSC_KEY_PASSWORD` | `CSC_KEY_PASSWORD` | `.p12` password |
| `APPLE_ID` | `APPLE_ID` | Apple Developer account email |
| `APPLE_APP_SPECIFIC_PASSWORD` | `APPLE_APP_SPECIFIC_PASSWORD` | App-specific notarization password |
| `APPLE_TEAM_ID` | `APPLE_TEAM_ID` | Matching Developer team ID |

An active Apple Developer membership and Developer ID Application certificate are
prerequisites. Do not paste credentials into source, issues, renderer storage or
command output. API-key/keychain-profile variants require an agreed pipeline
change. The local presence-only check on 2026-11-01 found zero valid code-signing
identities, so no local Developer ID signing/notarization success is claimed.

The `Signed macOS release candidate` workflow runs manually or on `v*` tags. It
installs locked dependencies, checks types/offline packaging policy, freezes the
sidecar, builds, signs and notarizes the app and final DMG. It uploads reviewable
artifacts and never publishes. Keep DMG, ZIP, blockmaps and `latest-mac.yml`
together with unchanged filenames on the matching release in
`VrolixThomas/MetaHackathon`. ZIP and manifest are required for macOS updates.
Main already initializes `electron-updater` only in packaged builds. Actual update
installation remains unverified until two signed versions have been published.

## Isolated hello-world mechanics probe

Root may run `node apps/desktop/packaging/hello-probe.cjs` or add `--adhoc`.
Those generated apps use separate ignored output and explicit UNSIGNED-LOCAL or
ADHOC-LOCAL labels. Their config omits product payload checks. Neither establishes
production app behavior, Developer ID, notarization or distribution readiness.
Do not upload these probes to the release feed. Historical probe results in
`LOCAL-RESULTS.md` remain historical, not evidence for today's integrated package.
