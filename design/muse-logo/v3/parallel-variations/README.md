# Parallel / focused variations

Six controlled comparisons of the **user-selected Parallel option**: the approved original and five refinements. The three-surface idea stays the same: a stable foreground with independent background work sharing one orientation. All variants retain the blue palette and light-surface treatment. The geometry labels are not app names.

| No. | Variation | What changes |
| --- | --- | --- |
| 01 | **Original** | Exact selected reference from the reset study. |
| 02 | **Compact** | Rear surface moves 13px closer; middle moves 6px closer. Denser and more unified. |
| 03 | **Open** | Rear moves 15px farther out; middle moves 7px farther out. The individual surfaces are more visible. |
| 04 | **Aligned** | Rear surface extends 14px at its lower edge, creating a shared lower baseline without changing its top angle. |
| 05 | **Rounded** | Softer quadratic corners at the same overall footprint. |
| 06 | **Level** | A shallower viewing angle across all surfaces. |

**Shortlist: Compact for a cohesive app icon; Open for clearer separation of the three surfaces.** Original remains the reference rather than being overwritten.

## See and compare

- **[Six-option comparison PNG](renders/comparison.png)** / [Detailed overview with actual sizes](renders/overview.png)
- **[Interactive original-versus-variation comparison](index.html)** — open manually. Original is fixed on the left; choose a variation on the right. Both simulations use the same clock. At rest shows the static geometry; Pause freezes the current pose.
- [Working comparison GIF](renders/working-comparison.gif) / [Motion time samples](renders/motion-contact-sheet.png) / [Decoded GIF proof](renders/gif-decoded-proof.png)
- [Actual sizes, light and mono](renders/sizes-and-use.png)
- Individual PNGs: [Original](renders/icons/original.png), [Compact](renders/icons/compact.png), [Open](renders/icons/open.png), [Aligned](renders/icons/aligned.png), [Rounded](renders/icons/soft.png), [Level](renders/icons/level.png).
- Editable masters: [Original](assets/original/master.svg), [Compact](assets/compact/master.svg), [Open](assets/open/master.svg), [Aligned](assets/aligned/master.svg), [Rounded](assets/soft/master.svg), [Level](assets/level/master.svg).

`assets/{original,compact,open,aligned,soft,level}/` contains **96 editable SVGs** total: master, dark/light app tiles, two mono treatments, actual 16/20/24/32px status exports on both surfaces, gathered/resting keyframes and fixed working/reduced-motion art. Micro drawings deliberately retain clear flat shapes and gaps rather than the large artwork’s material depth. Keep exact status in adjacent text and reserve the full art box for motion.

## Motion and material

The original geometry, palette, lighting and motion are retained in 01. All loops remain **3.2s** with the same quintic easing and small settling overshoot. The foreground stays fixed. Rear and middle planes gather in sequence, then open and settle. Travel is bounded to suit each layout: Compact moves less; Open moves more. There is actual spatial contraction, with no rotation or opacity-only pulse.

The preview is an immediately visible **silent working simulation**. Reduced motion always follows the system preference; manual reduction provides the same fixed reference poses. Gathered/Resting inspect keyframes. Hidden documents stop scheduling. No speech or product-state integration is proposed.

Palette: navy `#0A101E`, cobalt `#437BFF`, blue `#72BEFF`, pale blue and ice. Each master uses ordinary SVG paths, native editable radial gradients and clipping. This is a direct refinement of the selected [Parallel master](../reset/assets/parallel/master.svg), with **no new image generation or provider calls**. Earlier ideation provenance remains in the [reset study](../reset/README.md).

## Rebuild and actual QA

```sh
node design/muse-logo/v3/parallel-variations/build.cjs
node --check design/muse-logo/v3/parallel-variations/parallel.js
node --check design/muse-logo/v3/parallel-variations/preview.js
node design/muse-logo/v3/parallel-variations/verify.cjs
python3 design/muse-logo/v3/parallel-variations/render.py
```

Existing Node, PyMuPDF and Pillow only; nothing installed. [validation.json](validation.json) records 1,932 bounded poses, reference geometry/motion matching and actual preview script checks using a non-browser attribute/event adapter. [render-validation.json](render-validation.json) records all 96 SVG renders, the 80-frame/3.2s GIF and **zero RGBA pixel difference** for Original’s dark tile, gathered pose and 16px micro mark against the selected source. Comparison, overview, true-size/light/mono sheet, motion sheet and decoded GIF frames were visually inspected.

PyMuPDF does not implement the gradients/clipping used here, so the image pipeline paints the same declared radial-gradient stops with Pillow and clips them with the exact SVG surface masks, preserving transforms and paint order. These are shared-geometry renders, not browser screenshots. Browser layout, native controls, gradient/clipping playback and accessibility remain unverified. GIF playback cannot honor reduced motion; the HTML provides fixed equivalents.

All repository writes are new files under `design/muse-logo/v3/parallel-variations/**`. The approved reference and all earlier studies remain unchanged. No browser surface, server, CLI/CDP, Electron, app, integration, manifest, microphone, publication, push or merge work.
