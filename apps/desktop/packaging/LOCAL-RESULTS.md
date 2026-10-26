# D-5 local packaging results — 2026-10-26

**D-5 is blocked, not Done.** No Developer ID signing or Apple notarization success
has been established. These are hello-world packaging probes, not the integrated app.

The local Mac reports **0 valid code-signing identities**. All checked CSC and Apple
credential environment variables are missing. The GitHub repository Actions secrets
API returned `total_count: 0`; listing the `release` environment's secrets returned
HTTP 404 (environment absent or inaccessible with the current credentials).

| Actual check | Unsigned probe | Ad-hoc probe |
| --- | --- | --- |
| Electron-builder DMG + ZIP | Passed | Passed |
| `hdiutil verify` | Passed | Passed |
| `codesign --verify --deep --strict` | Failed (1) | Passed |
| Developer ID/team identity | Absent | Absent; `Signature=adhoc` |
| `spctl --assess --type execute` | Rejected (1) | Rejected (3) |
| App and DMG `stapler validate` | No tickets (65) | No tickets (65) |
| Launch from read-only mounted DMG | Alive after 5 seconds | Alive after 5 seconds |
| Owned process and mount cleanup | Exit 0; detached | Exit 0; detached |

The initial launch checks exited 9 because this agent shell had
`ELECTRON_RUN_AS_NODE=1`. Logs showed `bad option: --user-data-dir`. Repeating with
that flag removed passed the five-second process smoke check for both probes.
This is not visual UI, microphone capture, Gatekeeper distribution, or updater validation.
The ad-hoc app's actual entitlements include `allow-jit` and `device.audio-input`.
The generated Info.plist contains the microphone usage description.

The normal release config was exercised separately and correctly failed before
packaging with the missing CI secret names. Frozen dependency install/native SQLite
rebuild, targeted Biome checks, plist validation and diff checks passed. No dependency
manifest or lockfile changed.

Artifacts remain in the isolated `runtime-signing` checkout under
`apps/desktop/dist/hello-probe/` and `apps/desktop/dist/hello-probe-adhoc/`.
Both directories contain `local-probe-evidence.json` with full commands, exit codes,
diagnostics and launch cleanup details.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `hello-probe/MetaHackathon-HelloWorld-0.1.0-arm64-UNSIGNED-LOCAL.dmg` | 123681680 | `575039f4d885af996b5016e9b12df92890ce23f5f5ca1ad95d2380cff53ae7d9` |
| `hello-probe/MetaHackathon-HelloWorld-0.1.0-arm64-UNSIGNED-LOCAL.zip` | 119539204 | `f8b1395d297066095232973cbc4d9b84daac4e966ed3f4597b1cf1ed82786c72` |
| `hello-probe-adhoc/MetaHackathon-HelloWorld-0.1.0-arm64-ADHOC-LOCAL.dmg` | 122599447 | `063bbedc13eff655383a8609d8e86988c07a39efae668eb010dee794483a1515` |
| `hello-probe-adhoc/MetaHackathon-HelloWorld-0.1.0-arm64-ADHOC-LOCAL.zip` | 118451926 | `771d7951276c57f65af9a227059c54188ba84cc59a6af9d146e4999b1d614ce4` |

Remaining integration gates: configure release environment secrets, run the signed
workflow, supply/verify the C-1 sidecar bundle, include the seeded demo resources,
initialize `electron-updater@6.8.11` in main, and verify updates between published
signed versions. No release was published and no remote workflow was triggered here.
