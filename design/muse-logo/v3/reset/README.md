# Reset / blue light identities

Three new foundations after the ring-and-node direction was rejected. Only the blue/light preference carries forward. The final marks use solid directional fragments or separate flat light surfaces, with open space and clear component relationships. Direction names are labels for the study, not app names.

**Relay is the strongest small-icon starting point. Synthesis makes the coordination idea most explicit.** These are fresh options for judging the silhouette and product idea, rather than more variations of the earlier symbol.

| Direction | Vision expressed through the geometry | Tradeoff |
| --- | --- | --- |
| **01 / Relay** | Intent becomes momentum. A stable intent fragment and a smaller execution fragment share a heading and draw into alignment. | Clearest compact silhouette. Has a forward/play association. |
| **02 / Synthesis** | Separate efforts create one coherent result. Two independent flat surfaces share a brighter common region. | Most explicit shared-work metaphor. Has a layers association. |
| **03 / Parallel** | Independent work continues alongside the foreground conversation. Separate surfaces retain their identity and share an orientation. | Quietest architectural option. Has a signal/cards association. |

These ideas are based on the actual product’s foreground conversation and independent background work in the [repository README](../../../../README.md). Meaning comes from alignment, overlap and orientation, rather than assigning roles to a central dot and surrounding nodes. The drawings are name-independent, with no character, face, wordmark or letter construction. The flat surfaces do not fold or form a ribbon/knot.

## See the work

- **[Three-direction overview](renders/overview.png)** / [Relay close-up](renders/relay-preview.png)
- [Working comparison GIF](renders/working-comparison.gif) / [Self-contained interactive HTML](index.html), open manually
- [Actual sizes / mono / light](renders/sizes-and-use.png) / [motion samples](renders/motion-contact-sheet.png) / [decoded GIF proof](renders/gif-decoded-proof.png)
- Editable masters: [Relay](assets/relay/master.svg), [Synthesis](assets/synthesis/master.svg), [Parallel](assets/parallel/master.svg).
- `assets/{relay,synthesis,parallel}/`: **48 editable SVGs** total. Each has a transparent master, light/dark tiles, two one-color versions, actual 16/20/24/32px status exports on both surfaces, compact/open keyframes and a fixed working/reduced-motion pose.

Large art uses native editable SVG paths, clip paths and radial-gradient light. The approved palette remains navy/cobalt/blue/ice. At 16–32px, dedicated simplified micro art keeps the component spacing and omits the material. Full mono naturally loses some layering; the micro Synthesis drawing restores a clear gap. Keep exact status in adjacent text and allow at least one quarter of a mark width of external clear space. App tiles are design backings, not production bundles.

## Motion

The default preview has an immediately visible labelled **working simulation**, with direction selection, At rest / Working, Pause, Replay, Together/Open and reduced-motion controls. No microphone, audio, API or live state. Full speculative product-state bindings are deliberately outside this reset.

All loops last **3.2s** with quintic easing and small settling overshoot. Relay holds the larger fragment steady while the execution fragment moves 6px left / 10px up across the cycle and shrinks to 97%, narrowing the gap. Synthesis moves the two contributions 9px each toward their stable shared region. Parallel keeps the foreground steady while background surfaces draw 15px / 7px closer. Each opens again; there is no spin or opacity-only pulse. System reduced motion always wins. Manual reduction and Pause select a fixed pose; hidden documents suspend frames.

## Ideation provenance

I applied the [imagegen skill](/Users/Werk/.codex/skills/.system/imagegen/SKILL.md) for **one fresh visual ideation contact sheet**, using the built-in `image_gen.imagegen` tool, with no input images. It is saved as [blue-light-exploration.png](ideation/blue-light-exploration.png). The exact final prompt and tool mode are recorded in [ideation/PROMPT.md](ideation/PROMPT.md).

The final three marks are newly authored vector interpretations of that exploration. The generated raster is not embedded in a master or used as a final app asset. The original generated image is preserved unchanged. No CLI/API-key fallback, product model provider or voice provider was used.

## Rebuild and actual QA

```sh
node design/muse-logo/v3/reset/build.cjs
node --check design/muse-logo/v3/reset/marks.js
node --check design/muse-logo/v3/reset/preview.js
node design/muse-logo/v3/reset/verify.cjs
python3 design/muse-logo/v3/reset/render.py
```

Uses existing Node, PyMuPDF and Pillow; installs nothing. [validation.json](validation.json) records 966 bounded poses, actual alignment with a stable identity part, exact loop seam, static reduction, separate static/dynamic SVG namespaces and offline packaging checks. [render-validation.json](render-validation.json) records all 48 SVG renders and the 80-frame/3.2s GIF. Overview, actual-size/light/mono sheet, motion contact sheet and decoded GIF frames were visually inspected.

PyMuPDF does not implement the SVG paint servers/clipping used here. The image pipeline therefore uses the exact SVG surface paths as masks, paints the same declared radial-gradient stops with Pillow, and preserves layer transforms and paint order. SVG masters and HTML use standard native gradients and clipping. The non-browser images are equivalent shared-geometry renders, not screenshots. Browser layout, actual controls, native gradient/clipping playback and accessibility remain unverified. The GIF cannot honor OS reduced motion; HTML has fixed equivalents.

The blocked browser path remains respected: no browser surface, server, CLI/CDP or Electron. No app, integration, manifest, microphone, publication, push or merge work. All repository writes are new files under `design/muse-logo/v3/reset/**`; every earlier study is preserved.
