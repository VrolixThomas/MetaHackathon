# Blue revision / Confluence

**Recommend 01 / Confluence.** The previous study followed the SuperiorSwarm composition too closely. This revision starts with a new directional silhouette: three unequal curved light currents approach an offset, elongated ice-blue seam. The seam stays still; the currents gather and open. Cobalt, clear blue and ice give the mark a cool luminous character.

This subfolder preserves all earlier studies and stays within the authorized `design/muse-logo/v3/**` scope. “Confluence” is a direction label, not a proposed app name. The art contains no letters or name-dependent geometry.

- [Overview PNG](renders/overview.png): one prominent recommendation, two close variations, the blue palette, motion keyframes and actual status sizes. The original ideation reference appears as a small, clearly labelled source.
- [Working comparison GIF](renders/working-comparison.gif): three close versions, 75 frames / 3.0s / 25fps, sampled from the exact shared pose model.
- [Interactive HTML](index.html): manually open this standalone file. The working simulation starts immediately unless system reduced motion is enabled. Includes composition selection, five simulated states, pause, open/gathered poses, manual reduction and an opt-in simulated envelope. No network, mic, audio, API or product state.
- [Motion samples](renders/motion-contact-sheet.png), [decoded GIF proof](renders/gif-decoded-proof.png), [actual sizes / light / mono](renders/sizes-and-use.png).
- [Recommended SVG master](assets/confluence/master.svg), [dark app icon](assets/confluence/app-icon-dark.svg), [light app icon](assets/confluence/app-icon-light.svg). `assets/{confluence,interval,wake}/` contains **60 editable SVGs** total: master, two app tiles, two one-color versions, four status sizes on two surfaces, open/gathered poses and five reduced-motion states per version.

## Structure and rationale

The earlier reference supplied atmosphere: a dark surface, luminous depth and coordinated movement. This mark’s geometry is newly authored. Its signature is a **one-sided curved wake and an offset diagonal light seam**. Three different cubic paths vary in length, curvature, weight and endpoint. Small traces extend the wake; the shape is organized by direction and continuity.

Confluence uses two separated portions of each current. **02 / Open intervals** adds another break; it is more particulate and slightly less coherent at rest. **03 / Long wake** lengthens the tail portions; it feels more fluid. They share the same primary identity and the same simplified tiny mark.

Visual review: the blue wake and elongated focus are clearly separate from the source’s round center and surrounding dot field. Confluence retains the strongest silhouette. The curves do carry a signal/wave association, especially at tiny sizes; this is the main tradeoff. No mascot, face, folded ribbon, monogram or status badge is present.

## Motion

The focal seam is always the line **(147,112) → (165,91), width 12** in a 256px square. No rotation or focus scaling. Working uses a **3.0s** cycle with a quintic ease (zero velocity and acceleration at the ends).

| Current | Begin gather | Gathered | Begin release | Open | Minimum distance to focus |
| --- | --- | --- | --- | --- | --- |
| Outer / lower | 0.04s | 1.04s | 1.35s | 2.69s | 66% |
| Middle | 0.18s | 1.18s | 1.48s | 2.80s | 74% |
| Upper | 0.32s | 1.32s | 1.61s | 2.90s | 82% |

Each current’s cubic control points move toward the stable focus and its stroke width shrinks to 86%. The small traces move and shrink too. Release overshoots by 2.5% of the contraction distance, then settles to the exact resting pose at 3.0s. In Long wake, the fixed extra tail extension slightly changes the outermost distance ratio (67.7%). This is visible geometric gathering, with no spin or opacity-only loop.

Listening/speaking can modulate breadth from a simulated `[0,1]` envelope with 65ms attack / 220ms release. Silence is explicit input; the preview’s optional synthetic envelope is labelled. System reduced motion always wins. Reduction and Pause use fixed poses, ignoring envelope/time. Hidden documents suspend frames. Offline is a held dimmer, more compact pose. Exact status is adjacent text; there are no integration bindings.

## Size and color

- Large: navy `#0A101E`, cobalt `#437BFF`, blue `#72BEFF`, pale blue `#A7DFFF`, ice `#E5F5FF`. Editable layered stroke halos supply the glow; there are no embedded bitmaps or filter dependencies.
- **16 / 20 / 24 / 32px:** use the purpose-drawn status master, with three continuous curves, larger relative weights and clear open gaps. It fills more of the tiny art box and omits glow, fragments and remote traces. Keep it still and retain adjacent exact status text.
- Light surfaces use darker blue curves and an ink focus. One-color masters are transparent ink or ice. App tiles are provisional design backings, not production icon bundles. Reserve the whole art box during motion and at least one quarter of a mark width of external clear space.

## Rebuild and actual checks

```sh
node design/muse-logo/v3/blue/build.cjs
node --check design/muse-logo/v3/blue/current.js
node --check design/muse-logo/v3/blue/preview.js
node design/muse-logo/v3/blue/verify.cjs
python3 design/muse-logo/v3/blue/render.py
```

Uses existing Node, PyMuPDF and Pillow; installs nothing. Writes only inside this blue subfolder. [validation.json](validation.json) records **4,530** deterministic poses, fixed seam, real contraction/stroke shrink, stagger, settling, exact loop seam, envelope breadth, reduced motion, and the actual preview source exercised with a non-browser attribute/event adapter. [render-validation.json](render-validation.json) records all **60** SVG rasterizations and the **75-frame** GIF. Overview, motion sheet, decoded GIF frames and actual-size/light/mono sheet were visually inspected with image tools.

The blocked browser navigation remains respected. No browser surface, local server, CLI/CDP, Electron, microphone or provider was used. These images are vector raster renders, not browser screenshots. Browser layout, native interactions/accessibility and actual HTML playback remain unverified; open the HTML manually. The GIF cannot honor OS reduced motion. Existing v1/v2/v3 files, product code and manifests were untouched. No publication, push or merge.
