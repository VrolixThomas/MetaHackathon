# macOS packaging and release evidence

The new release identity is **MuseFocus**, bundle ID `app.musefocus.desktop`,
installed as `MuseFocus.app`. Release archives are
`MuseFocus-<version>-<arch>.dmg` and `MuseFocus-<version>-<arch>.zip`.
Finalization verifies the bundle path, Info.plist name/identifier/executable and
signed identifier, and rejects old product names and local-probe archives.
The internal `@metahackathon` namespace and frozen voice executable keep their
existing names. Root coordinates package `productName`, main/window branding and
preservation of existing user data before integrated acceptance.

The finalized Pull forward / Blue–Ice icon is configured for macOS ICNS,
Windows ICO and Linux PNG. The window PNG is also copied to
`Resources/branding/icon.png`; development uses the same art for the macOS Dock.
See [`resources/branding/README.md`](../resources/branding/README.md) for identity
sources and renderer usage. Native icon appearance still needs installed-package
acceptance; policy and build checks do not establish that.

`musefocus.app` is planned and not owned. It is not an authentication callback,
update feed or download host. Release/update hosting remains the GitHub repository
`VrolixThomas/MetaHackathon` below; domain purchase/configuration is separate work.

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
MuseFocus bundle identity, Developer ID/hardened signatures from the expected team,
microphone entitlement and current Info.plist metadata, app staple/Gatekeeper
acceptance, final DMG notarization/stapling, regenerated DMG blockmaps and verified
update hashes.

Root must separately launch the installed package with a user-provided `.env`,
verify Start/End and actual microphone/voice, and exercise an update between two
published signed versions. Package/hash checks alone do not establish those gates.
Unset `ELECTRON_RUN_AS_NODE` when launching Electron as an app. Use isolated user
data and clean up only the process and temporary files owned by that check.

## Signing inputs and release candidate

The supported credential set is explicit. Integration created this repository's
[`release` environment](https://github.com/VrolixThomas/MetaHackathon/settings/environments)
on 2026-11-01; its environment-secret list was empty. No credential values were copied.
Configure these only in that environment:

| Preferred CI secret | SuperiorSwarm alias if preferred is absent | Process environment | Required input |
| --- | --- | --- | --- |
| `MAC_CSC_LINK` | `MAC_CERTIFICATE` | `CSC_LINK` | Base64 Developer ID Application `.p12` with private key |
| `MAC_CSC_KEY_PASSWORD` | `MAC_CERTIFICATE_PASSWORD` | `CSC_KEY_PASSWORD` | `.p12` export password |
| `APPLE_ID` | Same name | `APPLE_ID` | Apple Developer account email |
| `APPLE_APP_SPECIFIC_PASSWORD` | `APPLE_ID_PASSWORD` | `APPLE_APP_SPECIFIC_PASSWORD` | App-specific notarization password |
| `APPLE_TEAM_ID` | Same name | `APPLE_TEAM_ID` | Matching Developer team ID |

The original five names remain supported and take precedence. The optional aliases
feed the same five required process inputs; they do not select another auth flow
or read credentials from SuperiorSwarm. The Apple account alone is insufficient:
signing also needs the valid certificate **with its private key** and export password.

### Operator checklist

1. Reuse the existing paid Apple Developer account/team and valid certificate
   `Developer ID Application: <legal name> (<TEAM_ID>)` with its private key.
   It can sign both SuperiorSwarm and MuseFocus; no extra account or per-app
   certificate is needed. Only if missing, the Account Holder creates Developer ID
   **Application** in Certificates, Identifiers & Profiles using a CSR, downloads
   and installs it on the Mac that created the key. Developer ID Installer is for
   `.pkg`, whereas this workflow produces DMG/ZIP.
   [Apple certificate instructions](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/).
2. On that Mac, the operator selects the Developer ID Application identity **and
   private key** in Keychain Access, then File → Export Items → `.p12`, and chooses
   an export password. Store the base64 `.p12` in `MAC_CSC_LINK` and that export
   password in `MAC_CSC_KEY_PASSWORD`. A downloaded `.cer` alone is insufficient.
   [Apple export instructions](https://support.apple.com/guide/keychain-access/import-and-export-keychain-items-kyca35961/mac).
3. At Apple Account → Sign-In and Security, enable two-factor authentication if
   needed, then App-Specific Passwords → Generate an app-specific password; label
   it `musefocus-release`. Store it in `APPLE_APP_SPECIFIC_PASSWORD`, and put the
   same account's email in `APPLE_ID`. Use the generated password, not the normal
   Apple Account password. Resetting the normal password revokes these passwords.
   [Apple Account instructions](https://support.apple.com/en-us/102654).
4. In the developer account's Membership details, copy the **10-character Team ID**
   into `APPLE_TEAM_ID`; it must match the certificate's team. Accept outstanding
   Developer Program agreements if Apple requests them.
   [Apple Team ID instructions](https://developer.apple.com/help/glossary/team-id/).
5. Set all five secrets in **this repository's `release` environment**. Root runs
   the signed candidate, reviews signing/voice evidence and completes installed-app,
   voice and update acceptance before publishing the exact verified files.

Read-only reference on 2026-11-01: SuperiorSwarm's tracked
`apps/desktop/electron-builder.yml` and `.github/workflows/release-desktop.yml`
use the same Developer ID + Apple Account/password/team flow. Its secret names
`MAC_CERTIFICATE`, `MAC_CERTIFICATE_PASSWORD`, `APPLE_ID_PASSWORD` correspond to
this repository's `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`,
`APPLE_APP_SPECIFIC_PASSWORD`. Integration requested these optional CI aliases
after confirming that exact pattern; no rename or authentication change is required.
No credential values were inspected or transferred.

Do not paste credentials into source, issues, renderer storage or command output.
API-key/keychain-profile variants require an agreed pipeline change. The earlier
presence-only check on 2026-11-01 reported zero valid local code-signing identities;
it was not repeated for this identity increment. No local Developer ID signing or
notarization success is claimed.

The `MuseFocus signed macOS release candidate` workflow runs manually or on `v*`
tags. It installs locked dependencies, checks types/offline packaging policy, freezes the
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
Their separate bundle ID is `app.musefocus.desktop.packaging-probe`.
Do not upload these probes to the release feed. Historical probe results in
`LOCAL-RESULTS.md` remain historical, not evidence for today's integrated package.
