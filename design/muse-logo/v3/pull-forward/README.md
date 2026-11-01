# Pull forward / final asset kit

**Selected final mark: Pull forward, in Blue / Ice.** One clear surface is held for review or discussion while quieter work remains active behind it. Focus passes to the next item in the same foreground position. The selected geometry, colour and handoff are preserved; previous studies are untouched.

**Final package: `pull-forward-assets.zip`** · [Visual usage guide](preview/brand-overview.png) · [Interactive preview](index.html) · [Actual-size proof](preview/size-proof.png)

This is a **mark-only digital asset kit**. No app name, wordmark, initials or new typography has been added. The concept name “Pull forward” is used in filenames; Focus remains the design theme.

## Start here

| Need | Asset |
| --- | --- |
| Primary editable colour mark on a dark surface | [svg/pull-forward.svg](svg/pull-forward.svg) |
| Colour mark on light | [svg/pull-forward-light.svg](svg/pull-forward-light.svg) |
| Pure white / black / ink | [White](svg/pull-forward-white.svg), [black](svg/pull-forward-black.svg), [ink](svg/pull-forward-ink.svg) |
| Inline CSS-coloured mark | [svg/pull-forward-current-color.svg](svg/pull-forward-current-color.svg) |
| Flat colour | [Dark](svg/pull-forward-flat-dark.svg), [light](svg/pull-forward-flat-light.svg) |
| Transparent PNGs, 64–2048px | [png/transparent/](png/transparent/) |
| Small UI marks, 16–64px, plus @2x | [svg/ui/](svg/ui/), [png/ui/](png/ui/) |
| macOS app icon and editable source sizes | [PullForward.icns](icons/macos/PullForward.icns), [PullForward.iconset](icons/macos/PullForward.iconset/) |
| Windows app icon | [PullForward.ico](icons/windows/PullForward.ico) |
| App-icon PNGs, dark/light, 16–1024px | [icons/png/](icons/png/) |
| Native menu-bar templates | [icons/menubar/](icons/menubar/) |
| Web favicons and touch/web-app images | [web/](web/) |
| Avatars and copy-free share cards | [social/](social/) |
| Focus-handoff motion | [Transparent lossless WebP](motion/pull-forward-handoff-transparent.webp), [GIF on dark](motion/pull-forward-handoff-dark.gif), [MP4](motion/pull-forward-handoff-dark.mp4) |
| Foreground held, background working | [Transparent WebP](motion/pull-forward-working-transparent.webp), [GIF](motion/pull-forward-working-dark.gif), [standalone working SVG](motion/pull-forward-working.svg) |
| Reduced-motion still | [motion/reduced-motion.svg](motion/reduced-motion.svg) |
| Exact keyframes | [motion/keyframes/](motion/keyframes/) |
| Reusable geometry/controller/CSS/types | [motion/](motion/) |
| Design constants | [brand-tokens.json](brand-tokens.json) |

See [ASSETS.md](ASSETS.md) for sizes and purpose. All logo artwork is editable vector geometry; generated bitmap exports are derived from those surfaces. PNG and WebP exports embed an sRGB profile. No raster logo is embedded in an SVG.

## Use the selected identity

- Keep the full SVG viewBox. For brand placements allow outside clear space of at least 1/8 of the canvas; small UI marks retain 2px around their reserved box.
- Use the flat UI/micro assets at 16–32px. The 48/64px UI exports also cover high-density placements. Use the rich material masters for larger marks.
- App-icon PNGs at 48px and below use optically sized flat art, with slightly increased relative weight. Larger app icons retain the exact selected material and geometry.
- Use the light-surface exports on pale backgrounds. Use pure white, black, ink or currentColor when colour depth cannot be reproduced. The solid focus surface and outlined background preserve the hierarchy in one colour.
- The mark expresses focus, not job status. Keep exact state, repository/file identity and source information in adjacent application text.
- The avatar and web/touch images have full-bleed square backings. The macOS/window icon exports use the selected rounded design backing. Share cards contain the mark and open copy space, with no invented app name or tagline.

## Motion API

Include `motion/pull-forward.js`, `motion/controller.js` and `motion/pull-forward.css`, then mount a rich mark above small UI sizes:

```html
<link rel="stylesheet" href="motion/pull-forward.css">
<span id="brand" class="pull-forward"></span>
<script src="motion/pull-forward.js"></script>
<script src="motion/controller.js"></script>
<script>
  const mark = new PullForwardController(document.getElementById('brand'), {
    size: 96,
    theme: 'dark',
    backgroundMotion: true,
    decorative: true
  });
  // Call when the app's accepted review/discussion focus actually changes.
  mark.advance();
  // Later, on unmount:
  mark.destroy();
</script>
```

CommonJS consumers can require the two `.js` modules; matching `.d.ts` files are included. Native ESM/bundler consumers can import `motion/pull-forward.mjs` and `motion/controller.mjs`, with matching `.d.mts` declarations. ESM is generated from the same source and uses its own SVG ID namespace. The controller is dependency-free and contains no work/provider/audio transport. The live preview embeds the universal files, so it opens without a server or network access.

| Method | Behavior |
| --- | --- |
| `advance(): boolean` | Starts one 0.8s handoff. Returns false if one is already active or the controller is destroyed. In reduced/paused mode, changes the fixed focused item immediately. |
| `reset()` | Resets this visual mark to its first illustrative focus position. |
| `pause()` / `resume()` | Freeze/resume asset motion only. |
| `setBackgroundMotion(boolean)` | Toggle subtle background movement while the current focus remains held. |
| `setReducedMotion(boolean)` | Add manual reduction. System preference always wins. |
| `setTheme('dark' \| 'light')` | Use the selected material treatment for that surface. |
| `getState()` | Returns this animation’s local state, not a real work-queue snapshot. |
| `destroy()` | Cancels frames and removes listeners; leaves the last drawing in the host. |

`onStateChange(state)` is optional and fires on meaningful changes, not animation frames. `decorative: false` plus `label` provides a single SVG accessible name. The app owns actual review navigation, job identity, narration and completion. Animation completion does not mean review completion. There is **no automatic focus advance** in the reusable controller.

The working background cycle is 3.2s. The focused item does not move or pulse while held. A handoff separates the departing and arriving surfaces, transfers depth/clarity, and settles into the same foreground position. Only one surface is highlighted at a time, with a briefly quiet midpoint. The media demo holds 2.4s and hands off for 0.8s across three illustrative items, making a 9.6s loop. It is presentation media, not proposed automatic app navigation.

System reduced motion stops controller animation and makes Next immediate. Hidden documents suspend frames. The standalone working SVG uses CSS/SMIL with a visible static fallback for reduced motion; exact stateful handoff belongs to the JS controller. Native SVG animation/browser playback remains unverified here. GIF/WebP/MP4 cannot automatically honor system motion preferences; use them for intentional previews and the controller for interactive app placement.

## Rebuild and actual QA

From this kit folder:

```sh
node source/build.cjs
python3 source/export.py
node source/verify.cjs
python3 source/package.py
```

The full export uses existing Node, PyMuPDF/Pillow, macOS `iconutil` and `ffmpeg`/`ffprobe`. No dependencies were installed. Delivered assets do not need the build tools. Native `.icns` regeneration is a macOS step. The TypeScript declarations were checked with the locally available compiler; no compiler is bundled.

Validation includes exact selected-reference geometry/material rendering, static SVG/PNG dimensions and transparency, ICO decoding and a native iconutil round-trip of all ten ICNS entries, lossless transparent WebP/GIF duration checks, MP4 frame/duration/codec checks with **no audio**, selected-mark controller tests, TypeScript declaration usage and ZIP/hash verification. See [model/controller validation](preview/validation.json), [export validation](preview/export-validation.json) and [archive validation](preview/archive-validation.json). `SHA256SUMS.txt` verifies the payload; `pull-forward-assets.zip.sha256`, provided beside the archive, verifies the complete download.

The non-browser renderer uses exact SVG surfaces with equivalent declared radial-gradient stops and clipping in Pillow because PyMuPDF does not implement the native SVG paint servers. These are shared-geometry renders, not browser screenshots. Brand/size proofs, motion/keyframe samples and decoded media frames were visually inspected. Native browser layout, controls, CSS/SMIL/gradient/clipping playback and OS app integration have not been tested. The browser restriction was respected: no browser surface, server, CLI/CDP or Electron launch.

All repository writes are new under `design/muse-logo/v3/pull-forward/**`. No previous studies, application files, dependency manifests or other repositories were modified. No microphone/provider calls, new image generation, publication, push or merge. The kit is ready for separate app integration.
