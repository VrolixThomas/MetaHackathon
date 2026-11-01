# MuseFocus identity

The final **Pull forward / Blue–Ice** artwork is copied unchanged from the selected
asset kit on `design/muse-logo-motion`, commit `38d7c1d`:
`design/muse-logo/v3/pull-forward/`. Earlier studies are not app assets.

| Asset | Actual use |
| --- | --- |
| `icon.icns` | Multi-resolution macOS application / Finder / packaged Dock icon |
| `icon.ico` | Windows application icon, nine embedded sizes from 16–256px |
| `icon.png` | 1024px window/Linux icon and development macOS Dock art |
| `../../src/renderer/brand/assets/` | Six optically sized SVGs: 16/20/24/32/48/64px |

`electron-builder.yml` points each platform at its native asset. The PNG is also
copied to `Resources/branding/icon.png` for the packaged window. Development loads
the same PNG from this source directory; packaged macOS keeps the native ICNS Dock
icon. These paths add no external fetch or runtime dependency.

Use `BrandMark` beside an existing accessible name, or `BrandLockup` when the
MuseFocus name should appear. Micro art stays crisp and static in the navigation,
conversation and settings. Do not replace it with an initial, provider icon or a
rejected study. The app currently has a dark interface, so these are dark-surface
assets; do not recolor them with CSS filters.

The product name is in `src/shared/brand.ts`, shared by renderer, foreground
assistant identity and native presentation. Bundle ID remains
`app.musefocus.desktop`. Existing storage/encryption identity, user data,
credentials, provider names (Muse Code/Muse Image), workspace package namespaces,
OAuth callback URLs and environment keys retain their established identifiers.

## Verification

Based on fetched `origin/main` at `4a5599b`. All nine image/vector files match the
final kit byte-for-byte. Native ICNS/ICO/PNG decode successfully; SVGs parse. The
production renderer emits a relative favicon URL and bundles its UI art for local
file loading.

Type checking, production build, targeted Biome checks, 87 controlled UI/agent/data
identity tests and 14 packaging policy tests pass. These do not establish native
visual acceptance or signed distribution. No Electron launch, live microphone or
provider call, browser preview, package signing, publication, push or merge was performed.

Release assembly still follows `../../packaging/README.md`. Before shipping, the
integration checkout must inspect the installed Finder/Dock/window and native
About/menu branding in the signed package on its target OS. Existing native smoke
checks are not claimed as run by this change.
