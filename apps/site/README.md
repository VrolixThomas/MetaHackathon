# MuseFocus landing site

The actual homepage adopts the final static design in
[`design/muse-logo/v3/musefocus-site/dist`](../../design/muse-logo/v3/musefocus-site/dist).
Its stylesheet is copied unchanged as `focus.css`; `site.js` uses repository formatting
and equivalent loops. All files in `assets/` are byte-exact copies of the final design,
including the frozen Pull forward identity and locally bundled Geist fonts. The font
license is in `assets/FONT-LICENSE.txt`. Do not format or regenerate frozen assets.

Serve this directory with any static host. Local preview, when authorized:
`python3 -m http.server 4175 --bind 127.0.0.1 --directory apps/site`.
No build, dependency, account, microphone or provider endpoint is needed for this page.
The interactive workspace and discussions are explicitly illustrative local examples.

The existing `setup.html`, its `styles.css`, and `launch.json` are preserved unchanged.
Setup remains linked from the homepage navigation and footer. The preserved setup guide
is legacy documentation; consult the repository README for current app and voice behavior.
The homepage shows signed download pending and offers no public download or account signup.
`launch.json` still records no video, no released app and no public repository; this page
never promotes those flags automatically. Publication, DNS, signed/notarized distribution
and real release destinations remain integration-owned pending work.

The macOS resource `../desktop/resources/branding/icon.icns` is an exact copy of the selected
`design/muse-logo/v3/pull-forward/icons/macos/PullForward.icns`, referenced by `mac.icon`
in the desktop builder configuration. Packaging acceptance remains separate.

Static validation, from the repository root:

```sh
node --check apps/site/site.js
node --check apps/site/assets/controller.js
node --check apps/site/assets/pull-forward.js
node --check apps/site/verify.cjs
node apps/site/verify.cjs
bunx --no-install biome check apps/site/site.js apps/site/verify.cjs
git diff --check
```

`verify.cjs` adapts the final design's source-controlled DOM probe to the adopted homepage:
actual mount/events, item selection and loop, discussion, keyboard tabs, revision reset,
announcements and motion controls. It also checks every frozen asset, CSS/font references,
IDs and targets, image alternatives, setup links, pending metadata and icon wiring.
These controlled/static checks do not establish browser layout, accessibility-tree behavior,
native app behavior, live voice, provider access, packaging or deployment. Root runs combined
native acceptance and packaging after integration. The frozen design archive is not rebuilt.
