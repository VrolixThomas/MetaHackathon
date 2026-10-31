# Parallel / bolder forms and colour

The user requested more substantial differences after the close refinements. This study keeps the **three work surfaces** from the selected Parallel idea and changes their composition, orientation and volume. Six palettes are independent of structure, giving **36 form/colour combinations**.

| No. | Form | Default palette | Structural change |
| --- | --- | --- | --- |
| 01 | **Parallel** | Blue | The selected original, kept as a reference. |
| 02 | **Fan** | Lagoon | Broad planes fan around a common footing. |
| 03 | **Crossing** | Violet | Independent planes cross through a shared working region. |
| 04 | **Horizon** | Ember | Wide horizontal surfaces create a new rhythm. |
| 05 | **Prism** | Pearl | Three faces assemble into one sculptural volume. |
| 06 | **Terrace** | Citrine | Offset surfaces make a stepped spatial stack. |

**Shortlist:** Fan/Lagoon retains the clearest family relationship while changing the silhouette; Prism/Pearl is the most sculptural and restrained; Horizon/Ember is a strong graphic departure. All labels are study names, not proposed app names. Every form is constructed from three independent flat surfaces.

## See and mix

- **[Bolder form/colour comparison](renders/comparison.png)** / [Detailed overview](renders/overview.png)
- **[Palette-only study](renders/palette-study.png)** — the original Parallel geometry in all six palettes, isolating colour from form.
- **[Interactive form + palette chooser](index.html)** — open manually. Choose structure and colour independently. Original/Blue stays on the left. Preset cards apply both; palette buttons retain the chosen structure.
- [Working comparison GIF](renders/working-comparison.gif) / [Motion samples](renders/motion-contact-sheet.png) / [Decoded GIF proof](renders/gif-decoded-proof.png)
- [Actual 16/20/24/32px, mono and light](renders/sizes-and-use.png)
- Individual PNGs: [Parallel](renders/icons/original.png), [Fan](renders/icons/fan.png), [Crossing](renders/icons/crossing.png), [Horizon](renders/icons/horizon.png), [Prism](renders/icons/prism.png), [Terrace](renders/icons/terrace.png).

## Editable sources

Default masters: [Parallel/Blue](assets/original/master.svg), [Fan/Lagoon](assets/fan/master.svg), [Crossing/Violet](assets/crossing/master.svg), [Horizon/Ember](assets/horizon/master.svg), [Prism/Pearl](assets/prism/master.svg), [Terrace/Citrine](assets/terrace/master.svg).

For each form, `master.svg` is its default palette. The other five are `master-<palette>.svg`, using `blue`, `lagoon`, `violet`, `ember`, `pearl` or `citrine`. This supplies all **36 editable masters**, without embedding any raster art. Each default combination also has dark/light tiles, mono, 16/20/24/32px micro art on both surfaces, resting/gathered keyframes and a fixed working/reduced-motion pose: **126 SVGs total**.

Palette definitions in `planes.js` include cool blue, teal/mint Lagoon, lavender/pink Violet, copper/coral Ember, neutral silver Pearl and olive/citrus Citrine. Light-surface artwork uses deeper body tones. Small icons use three flat tone levels with a larger relative silhouette and no material effects; exact status remains adjacent text. Material depth is reserved for larger artwork. App tiles are design backings, not production bundles.

## Motion and scope

The common 3.2s cycle retains a stable primary plane while the other two gather, open and settle. Each structural arrangement has a choreography suited to its composition: the fan draws toward its footing, the crossing planes draw inward, Horizon closes vertically, Prism’s side faces draw toward its top, and Terrace draws toward its foreground. There is actual spatial movement and small contraction, with no animated rotation or opacity-only pulse. The original reference retains its previous motion.

Both comparison views use one clock. Working is an immediately visible **silent design simulation**; At rest shows static geometry. Pause freezes the current pose. System reduced motion always wins; manual reduction gives the same fixed pose. Hidden documents suspend frames. No microphone, audio, API, live provider or product-state binding.

This is direct vector construction using the existing selected geometry and light-rendering approach. There was **no new image generation**. All earlier studies and the approved original are preserved.

## Rebuild and actual QA

```sh
node design/muse-logo/v3/parallel-explorations/build.cjs
node --check design/muse-logo/v3/parallel-explorations/planes.js
node --check design/muse-logo/v3/parallel-explorations/preview.js
node design/muse-logo/v3/parallel-explorations/verify.cjs
python3 design/muse-logo/v3/parallel-explorations/render.py
```

Existing Node, PyMuPDF and Pillow only; nothing installed. [validation.json](validation.json) records 1,932 bounded poses, independent geometry/colour tests across all 36 combinations, fixed primary planes, real contraction, loop seam and actual preview script checks using a non-browser attribute/event adapter. [render-validation.json](render-validation.json) records all 126 SVG renders, an 80-frame/3.2s GIF and zero RGBA pixel difference for the Original/Blue dark app icon against the selected source. Form comparison, palette study, overview, actual-size/light/mono sheet, motion sheet and decoded GIF frames were visually inspected.

PyMuPDF does not implement the native gradient/clipping paint used here. The image pipeline uses the exact SVG surfaces as masks, paints the same declared radial-gradient stops with Pillow, and preserves transformations and layer order. These are shared-geometry renders, not browser screenshots. Browser layout, native controls, gradients/clipping playback and accessibility remain unverified. The GIF has a limited palette and does not honor OS reduced motion; HTML provides fixed equivalents.

All repository writes are new files under `design/muse-logo/v3/parallel-explorations/**`. No browser surface, server, CLI/CDP, Electron, app, integration, manifest, microphone, publication, push or merge work.
