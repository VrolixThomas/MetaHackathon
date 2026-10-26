# macOS packaging and release evidence

The normal `electron-builder.yml` requires Developer ID signing and notarization.
It uses the v26 schema installed in the lockfile. A successful packaging command
alone does not establish distribution readiness.

`resources/entitlements.mac.plist` enables modern Electron's V8 JIT and hardened
runtime audio input. The main app and helper processes receive those entitlements;
`NSMicrophoneUsageDescription` explains microphone use. OS permission and actual
capture still require an integrated voice smoke test.

## Local mechanics probes

Run the isolated hello-world probe from the repository root:

```sh
bun install --frozen-lockfile
node apps/desktop/packaging/hello-probe.cjs
hdiutil verify apps/desktop/dist/hello-probe/*-UNSIGNED-LOCAL.dmg
```

The generated app says **UNSIGNED-LOCAL PROBE** and uses separate ignored output.
To test launch mechanics with a local ad-hoc signature, run:

```sh
node apps/desktop/packaging/hello-probe.cjs --adhoc
```

This writes separate `hello-probe-adhoc` output with **ADHOC-LOCAL** filenames.
An ad-hoc signature has no Developer ID/team identity and is not a notarized release.
When launching Electron directly from an agent shell, unset `ELECTRON_RUN_AS_NODE`;
that inherited flag runs the binary as Node and rejects browser flags. Verify app
launches using a fresh user-data directory and clean up only the spawned process.
For the actual desktop build, use:

```sh
bun run --cwd apps/desktop build
cd apps/desktop
METAHACKATHON_UNSIGNED_LOCAL=1 bun x --no-install electron-builder --config electron-builder.unsigned.yml --mac dmg zip --arm64 --publish never
```

Unsigned output is never acceptable as D-5 signing/notarization evidence. Do not
upload it to the release feed. The unsigned configuration disables Hardened Runtime
because an unsigned hardened app may fail to launch.

## CI credentials and release candidate

Configure these secrets only in GitHub's `release` environment:

| Secret | Purpose |
| --- | --- |
| `MAC_CSC_LINK` | Base64 Developer ID Application `.p12` certificate |
| `MAC_CSC_KEY_PASSWORD` | Certificate password |
| `APPLE_ID` | Apple Developer account email |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific notarization password |
| `APPLE_TEAM_ID` | Developer team ID |

An active Apple Developer membership and Developer ID Application certificate are
prerequisites. Do not paste credentials in source, issue comments, or renderer
storage. This pipeline deliberately supports the Apple ID credential set shown
above; API-key/keychain-profile variants require an agreed pipeline change.

The `Signed macOS release candidate` workflow runs manually or on `v*` tags. It
checks credentials, builds an Apple Silicon app, signs every discovered Mach-O,
notarizes/staples the app, and submits/staples the final signed DMG. Verification
requires Developer ID signatures from the expected team, hardened executable
runtime, microphone entitlement, Gatekeeper acceptance and valid staple tickets.
`signing-evidence.json` records verification time, binary inventory and accepted
DMG submission IDs. The workflow uploads a reviewable artifact and does not publish.

After review, publish the verified DMG, ZIP, blockmaps and `latest-mac.yml` together
on the matching GitHub Release in `VrolixThomas/MetaHackathon`. Preserve filenames.
The ZIP and update manifest are necessary for macOS automatic updates. The
packaging config points to that public feed. Integration must add `electron-updater`
and initialize it from the packaged main process; a published signed release and
an older installed version are required to verify an actual update.

## Python sidecar boundary (C-1)

Voice supplies the frozen bundle and full executable/native-library inventory.
Bundle it outside ASAR under `Contents/Resources/voice`, with no runtime dependency
on a user Python install. Agree that copy/signing hook through MET-8 before adding
the bundle to this config. `after-sign.cjs` checks every Mach-O in the resulting
app, including `.node`, `.dylib`, and sidecar binaries, so a missing/foreign/ad-hoc
signature fails the release. No Python bundle is included merely by this scaffold.

## Primary references

- [electron-builder v26 signing and entitlements](https://www.electron.build/v26/docs/mac/)
- [electron-builder v26 notarization](https://www.electron.build/v26/docs/notarization/)
- [Electron notarization prerequisites](https://github.com/electron/notarize/blob/main/README.md)
- [Apple audio input entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.audio-input)
