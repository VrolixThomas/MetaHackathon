# Shared focus / a concept-led refinement

**Proposed vision: one conversation keeps your whole work moving.** The product keeps context across real sources and independent background work while conversation remains available. This direction expresses those relationships, rather than treating the mark as an ornamental circle. The basis is the actual [repository README](../../../../README.md): foreground conversation, provider context, independent coding jobs, decisions and attention updates.

| Part | Meaning | Behavior |
| --- | --- | --- |
| Small blue lights and intake paths | Separate work, incoming information and questions. | They arrive at different times along their own curved paths and enter the context body. |
| Organic blue body | Context held together across those threads. | It gathers toward the current focus, then opens again. |
| Steady ice-blue junction | Your current conversation, intent or decision: where held context becomes a useful next step. | It is integrated into the field’s opening and remains fixed in position, size and color. |

The three small lights are a visual shorthand, not a literal number of providers or workers. The white junction is part of the identity, not a pasted status badge. The direction label is not a proposed app name. There are no initials or wordmark.

This differs from your SuperiorSwarm example: its central white point is the master agent, with other agents around it. Here, the foreground point of attention sits at the opening of a shared context, and incoming threads join that context. The silhouette, relationships and choreography are different. The blue palette and organic circular character from your preferred elements are retained.

- **[See the icon](renders/icon-preview.png)** / **[Concept and meaning board](renders/overview.png)**
- [Working GIF](renders/working.gif) / [Interactive HTML](index.html), open manually
- [Editable SVG master](assets/master.svg) / [dark tile](assets/app-icon-dark.svg) / [light tile](assets/app-icon-light.svg)
- [Actual sizes / mono](renders/sizes-and-use.png) / [motion samples](renders/motion-contact-sheet.png) / [decoded GIF proof](renders/gif-decoded-proof.png)

## Motion and use

The 3.2s working cycle gives the meaning a visible behavior. Sources start gathering at 0.04 / 0.16 / 0.28s along independent quadratic paths. Their radii shrink to 76%. The context follows with a 140ms delay, gathers to 87% scale **toward the fixed junction** and changes thickness slightly. Surface light follows at 200ms. The signals become absorbed into the body rather than remaining decoration. Release opens the field again, with a small 2% overshoot of the contraction distance and an exact loop seam. No orbiting or rotation.

The junction is always (165,92), radii (10.5,9.5). Listening/speaking can modulate context breadth using a clearly simulated envelope, with 65ms attack / 220ms release. This is a design metaphor, not a runtime diagram or real activity monitor. No state resolver or integration is proposed.

System reduced motion wins over controls. Reduction and Pause use fixed semantic poses; hidden documents suspend frames. Labels carry exact state. At **16 / 20 / 24 / 32px**, the dedicated micro art retains context and junction while omitting remote signals, fine paths and glow. Keep adjacent status text. The palette remains navy, cobalt, clear blue, pale blue and ice. One-color/light versions have transparent negative space. Reserve the full canvas for motion and at least one quarter of the mark width as external clear space.

The package contains **20 editable SVGs**: master, two app tiles, two mono treatments, eight status exports, open/gathered keyframes and five reduced-motion states. Earlier studies remain untouched. App tiles are design backings, not production icon bundles.

## Rebuild and actual QA

```sh
node design/muse-logo/v3/shared-focus/build.cjs
node --check design/muse-logo/v3/shared-focus/focus.js
node --check design/muse-logo/v3/shared-focus/preview.js
node design/muse-logo/v3/shared-focus/verify.cjs
python3 design/muse-logo/v3/shared-focus/render.py
```

Existing Node, PyMuPDF and Pillow only; installs nothing. The shared-pose geometry and actual preview source are checked without a browser. All 20 masters are rendered; the GIF has 80 frames / 3.2s. Icon, concept board, motion contact sheet, decoded GIF frames and true-size/light/mono sheet are visually inspected. See [validation.json](validation.json) and [render-validation.json](render-validation.json).

PyMuPDF ignores native SVG clipping, so the image pipeline applies an equivalent compound-shape mask to the separately rasterized vector light layers with Pillow. Foreground junction and background intake layers retain their intended paint order. Masters/HTML use standard editable SVG clipping. Browser layout, actual interaction/playback, native clipping and accessibility remain unverified. The GIF cannot honor OS reduced motion; HTML provides fixed equivalents.

All work is new under `design/muse-logo/v3/shared-focus/**`. No browser, server, CLI/CDP, Electron, provider, mic, product or manifest work. No publication, push or merge.
