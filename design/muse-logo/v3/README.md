# Abstract energy / identity study v3

**Recommend 01 / Gather.** One stable pale core coordinates an uneven field of warm particles. The arrangement has layered radii, different weights and deliberate empty space. It reads as abstract attention at rest; gathering and opening give it living energy. It is independent of the eventual app name.

| Direction | Composition | Assessment |
| --- | --- | --- |
| **01 / Gather** | Coherent particle cluster, with a northeast / southwest bias and quieter distant particles. | Closest to the supplied reference’s luminous depth. The calmest app icon and clearest tiny reduction. |
| 02 / Broken orbit | Tangent fragments in an interrupted, slightly elliptical field. | A close, more ordered alternative. Fragment orientation stays fixed while radii contract; nothing revolves. |
| 03 / Signal field | Short radial forms with uneven length, reach and spacing. | A close, more assertive alternative. Its signal / sunburst association is more generic than Gather. |

All three are original compositions in the same particle / light / core family. No face, mascot, monogram, initials, wordmark, folded emblem or status badge. V1 and v2 are preserved.

## Review files

- [Overview](renders/overview.png): dark presentation, clearly labelled user reference and all three proposals side by side, compact / expanded frames and actual status sizes.
- [Working comparison GIF](renders/working-comparison.gif): 3.2s loop, 80 frames at 25fps. Silent simulation from the same pose model as the HTML.
- [Interactive HTML](index.html): self-contained, manually open in a browser. All three **labelled working simulations start immediately**, except under system reduced motion. Includes eight states, simulated speech envelope, pause, reduction, compact / expanded controls and a cycle scrubber. No server, network, mic, audio or API.
- [Motion contact sheet](renders/motion-contact-sheet.png), [decoded GIF proof](renders/gif-decoded-proof.png), [sizes and use](renders/sizes-and-use.png), [reduced states](renders/reduced-states.png).
- `assets/{gather,orbit,signal}/`: **69 editable SVGs**. Per direction: rich transparent master; dark and light app icons; two one-color masters; four actual status sizes on each surface; compact / expanded poses; eight reduced-motion equivalents. These are design masters, not platform icon packages.

## Motion notes

Core position and radius are always **128,128 / r13.5** in a reserved 256px square. Only the surrounding field moves. Working uses a 3.2s cycle and cubic-bezier **(.4,0,.6,1)** easing, with staggered depth layers:

| Layer | Gather begins | Fully gathered | Release begins | Open | Minimum radius |
| --- | --- | --- | --- | --- | --- |
| Outer | 0.12s | 1.24s | 1.52s | 2.91s | 38% |
| Mid | 0.28s | 1.39s | 1.64s | 3.02s | 54% |
| Inner | 0.44s | 1.50s | 1.78s | 3.10s | 74% |

Particle radii also shrink to 70% / 84% / 93%. Remote opacity falls more than near opacity; it supports actual movement. Release overshoots the field by at most 2.5% of the contraction distance and gently settles to the exact resting arrangement at 3.2s. No spin, core scaling or layout movement.

Listening and speaking modulate field breadth from a **simulated** normalized envelope. Preview smoothing is 65ms attack / 220ms release; the core stays fixed. Envelope simulation is opt-in and affects no other state. Needs input holds a slightly wider field; Complete opens once over 0.8s; Error holds a compact field; Offline holds a dimmer compact field. Exact state belongs to adjacent text, not color or tiny visual differences.

System `prefers-reduced-motion` always wins. Manual reduction and Pause select fixed semantic poses; envelope movement and recurring frames stop. Compact / Expanded are fixed inspections. The cycle slider shows a still sampled working pose; Replay returns to the loop. Hidden documents suspend scheduling. No product state precedence or integration controller is proposed.

## Size and light

Large art combines charcoal `#0F1219`, a pale core `#FFFBF1`, warm amber `#F8BD79`, orange `#F19A50` and deeper copper. Light is editable concentric alpha geometry rather than a bitmap or filter, so the same vector halos survive browser-independent rendering.

**16 / 20 / 24 / 32px use the purpose-drawn status variant:** one core and four asymmetric satellites, no distant particles or glow. Use it still, beside explicit status text. The light-surface variant darkens amber to `#A85218`; one-color art uses ink `#292A2D` or ivory `#FFF3DF`. One-color masters have transparent gaps. Keep at least one quarter of the mark’s width as external clear space and reserve the whole box during motion.

## Reference and critical review

The supplied [SuperiorSwarm image](reference/superiorswarm-user-reference.png) was visually inspected **before any repository work** and appears explicitly labelled in the overview. Its actual source was read-only inspected in `/Users/Werk/Documents/Repositories/SuperiorSwarm`, HEAD `17a316bf`; both files were clean:

- `apps/website/src/components/animated-logo.tsx`: stable core; outer / mid / inner scales 0.28 / 0.46 / 0.62; opacity falloff; 3.2s easing; static reduced-motion branch.
- `apps/desktop/src/renderer/components/WorkspaceItem.tsx`, `SwarmIndicator`: the same differential contraction simplified at 22px.

This study explicitly takes that **interaction hierarchy** as its reference, adding new compositions, staggered depth timing and independent particle shrinkage. It does not reproduce the source coordinates or copy components.

**Visual assessment against the reference:** Gather retains the dark space, luminous stable center and asymmetric warm depth. It is calmer and more dispersed than the source. The broken orbit can suggest an atom / orbital instrument; the signal field can suggest a sunburst. Neither is as distinctive as Gather. None reads as a character or folded emblem. Open / gathered frames visibly change occupied area, while the white center stays recognizable. At actual 16px the simplified cluster is readable; full remote detail would disappear and is deliberately omitted.

## Rebuild and actual QA

From the repository root:

```sh
node design/muse-logo/v3/build.cjs
node --check design/muse-logo/v3/energy.js
node --check design/muse-logo/v3/preview.js
node design/muse-logo/v3/verify.cjs
python3 design/muse-logo/v3/render.py
```

Uses local Node, PyMuPDF and Pillow; installs nothing. All writes stay in v3. [validation.json](validation.json) records 7,728 finite poses, fixed-core identity, real contraction / particle shrink, stagger, loop seam, breadth modulation, sampled bounds (at least 12.77px crisp-shape padding) and a non-browser attribute/event adapter exercising the actual preview script. [render-validation.json](render-validation.json) records all 69 SVG rasterizations and the 80-frame GIF. The overview, motion sheet, actual-size sheet, reduced states and decoded GIF proof were visually inspected with image tools.

**QA limits:** Respecting the blocked `file://` navigation, no browser surface, alternate browser, CLI/CDP, local server or Electron was used. PNGs/GIF are shared-pose vector raster renders, not screenshots. Browser layout, actual controls/playback and native accessibility remain unverified; open the HTML manually. The GIF itself cannot honor OS reduced motion. No provider, microphone, product, integration, manifest, publication, push or merge work occurred. Scope is only new `design/muse-logo/v3/**` files.
