# Organic blue / fluid field

**Recommend 01 / Fluid field.** The user liked the blue palette, rejected the hand-like reading and asked for a more circular, organic mark. This revision is one continuous, softly uneven circular body with an off-center opening. Light moves through the surface. Direction labels are not proposed app names.

- **[See the icon](renders/icon-preview.png)** / [Overview](renders/overview.png)
- [Working comparison GIF](renders/working-comparison.gif) / [Interactive HTML](index.html), open manually
- [Editable master](assets/bloom/master.svg) / [dark tile](assets/bloom/app-icon-dark.svg) / [light tile](assets/bloom/app-icon-light.svg)
- [Actual sizes and mono](renders/sizes-and-use.png) / [motion samples](renders/motion-contact-sheet.png) / [decoded GIF proof](renders/gif-decoded-proof.png)

The two close variations change only the opening: **02 / Open field** is lighter and more spacious; **03 / Full field** is denser. All share the same outer silhouette, color pattern and motion. The full set has 60 editable SVGs under `assets/`: transparent masters, light/dark app tiles, one-color treatments, 16/20/24/32px status marks, compact/expanded keyframes and five reduced-motion states.

The palette is retained: navy `#0A101E`, cobalt `#437BFF`, clear blue `#72BEFF`, pale blue `#A7DFFF`, ice `#E5F5FF`. The silhouette is newly authored from two smooth irregular contours. It has no separate central white core, orbital particles, stacked bands, finger-like tips, initials or wordmark. The main tradeoff is that tiny sizes read as a soft ring; the uneven outline and opening carry its identity.

## Motion notes

Working gathers over a **3.2s** cycle. The outer contour begins at 0.08s, reaches 83% radius at 1.20s and begins opening at 1.50s. The opening follows 180ms later and reaches 70% radius; surface light follows 90ms later and reaches 87% scale. Different rates change the actual contour and body thickness. Release overshoots the contraction distance by 1.8%, then settles exactly to rest. No rotation. The body anchor is fixed at (128,128); the opening’s fixed anchor is (131,126).

The preview starts with a labelled, silent working simulation. Listening/speaking can modulate breadth with a clearly simulated envelope and 65ms attack / 220ms release. System reduced motion always wins. Manual reduction and Pause use fixed poses; hidden documents stop scheduling. Compact/Open inspect fixed geometry. State labels are exact adjacent text; no app integration or real-state claim is made.

At 16/20/24/32px, use the larger-relative-area, single-color compound contour without glow or tiny movement. Mono has genuine transparent negative space. Keep at least one quarter of the mark width of external clear space. App tiles are design backings, not production icon packages.

## Rebuild and actual QA

```sh
node design/muse-logo/v3/blue-organic/build.cjs
node --check design/muse-logo/v3/blue-organic/field.js
node --check design/muse-logo/v3/blue-organic/preview.js
node design/muse-logo/v3/blue-organic/verify.cjs
python3 design/muse-logo/v3/blue-organic/render.py
```

Uses existing Node, PyMuPDF and Pillow; installs nothing. [validation.json](validation.json) records 4,830 deterministic poses and non-browser preview attribute/event checks, including simultaneous updates of the body and lighting clip. [render-validation.json](render-validation.json) records all 60 SVG renders, the 80-frame/3.2s GIF and image-level contraction checks. Icon, overview, actual sizes/mono, motion sheet and decoded GIF frames were visually inspected.

**Rendering scope:** PyMuPDF ignores SVG `clip-path`. The image pipeline therefore renders the exact body, vector light layers and compound-contour mask separately and uses equivalent Pillow alpha clipping/composition. The source masters and HTML use standard editable SVG clip paths. PNG/GIF geometry is shared with the interactive model; these are not browser screenshots. Browser layout, native clipPath playback, controls and accessibility remain unverified.

The browser restriction remains respected: no browser surface, server, CLI/CDP or Electron. No microphone, provider, product, manifest, publication, push or merge work. All writes are new files under `design/muse-logo/v3/blue-organic/`; previous studies are preserved. GIF playback cannot honor OS reduced motion; the HTML provides fixed equivalents.
