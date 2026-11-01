# Focus / one item at a time

The user’s clarified vision: AI output arrives faster than human attention can absorb it. The app continues handling work in the background, then brings it into focus **one by one for review or discussion**.

**Recommended direction: 01 / Focus plane.** One broad, clear surface occupies a stable foreground position. Two quieter surfaces remain active behind it. The focused item holds still while you review; attention passes to the next item only when you move on. Focus is a transferable foreground role rather than the permanent identity of one component.

| Direction | How it expresses Focus |
| --- | --- |
| **01 / Focus plane** | Closest to the selected Parallel family. A larger, more front-facing review surface dominates; background work stays present but quieter. |
| 02 / Pull forward | An item separates from a working fan and comes forward into clear attention. |
| 03 / Focus stage | A clear, wide surface sits above a quieter stack of ongoing work. |

The three layouts use the same Blue / Ice palette in the main comparison so the focus hierarchy is easy to judge. Lagoon and Pearl remain available. These are direction labels; Focus is the design theme, not a new wordmark or initial-based geometry.

## See and experience it

- **[Focus plane close-up](renders/focus-preview.png)** / [Three-layout comparison](renders/comparison.png) / [Concept overview](renders/overview.png)
- **[Focus handoff GIF](renders/focus-handoff.gif)** — illustrative 9.6s loop: hold, recede, bring the next item forward, hold again.
- **[Interactive focus demo](index.html)** — manually open. By default it **holds the current item until Next**, with subtle background motion continuing. The optional illustrative handoff loop is a design demo, not proposed automatic review navigation.
- [Handoff contact sheet](renders/handoff-contact-sheet.png) / [Decoded GIF proof](renders/gif-decoded-proof.png) / [Actual sizes, mono and light](renders/sizes-and-use.png) / [Three calm palettes](renders/palette-study.png)
- Editable masters: [Focus plane](assets/plane/master.svg), [Pull forward](assets/pull/master.svg), [Focus stage](assets/stage/master.svg).

The package has **57 editable SVGs**: three layouts in three palettes, default dark/light app tiles, two one-color treatments per layout, actual 16/20/24/32px status marks on both surfaces and four handoff keyframes per layout. `held.svg` is also the reduced-motion equivalent. Small and mono art preserve the hierarchy using a solid focused surface with quieter or outlined background surfaces. Light-surface versions use deeper body tones for contrast. Reserve the full viewBox during motion; exact status remains adjacent text. App tiles are design backings, not production bundles.

## Motion expresses the promise

- **Hold:** the focused surface is completely still, including its geometry, colour, illumination and edge. Background work has bounded, low-amplitude independent motion. It remains present and active.
- **Handoff:** the old focus recedes before the next becomes clear. A short curved lateral separation reveals which item leaves and which arrives. Perspective, size, depth and material transfer between positions over 0.8s. There is never more than one highlighted surface; the midpoint is briefly quiet.
- **Next hold:** the next work item occupies the **same foreground position**, avoiding attention jumping around the screen. Other work continues behind it. No all-item pulse or global spin.

The illustrative loop has three 3.2s sections: 2.4s held, 0.8s handoff. It cycles three abstract items over 9.6s. The manual preview holds as long as you want; Next does not represent job acceptance/completion. Background-motion and pause controls only affect this design simulation, never actual workers.

System reduced motion always wins. Next switches to a fixed focused item immediately in reduced mode. The optional tour is disabled when reduction becomes active, retaining the nearest focused item. Hidden documents suspend scheduling. The three surfaces are a visual shorthand, not a literal provider/worker/job count. No real source records or product state are connected.

## Rebuild and actual QA

```sh
node design/muse-logo/v3/focus-theme/build.cjs
node --check design/muse-logo/v3/focus-theme/focus.js
node --check design/muse-logo/v3/focus-theme/preview.js
node design/muse-logo/v3/focus-theme/verify.cjs
python3 design/muse-logo/v3/focus-theme/render.py
```

Existing Node, PyMuPDF and Pillow only; nothing installed. [validation.json](validation.json) records held-focus stability, continuing background motion, one-highlight maximum, convex handoffs, continuity, tour sequence, reduced motion and actual preview script checks using a non-browser attribute/event adapter. [render-validation.json](render-validation.json) records all 57 SVG renders, the 192-frame/9.6s GIF and an image-level check that the foreground interior remains unchanged while background pixels change. Close-up, comparison, overview, palettes, small-size/light/mono sheet, handoff contact sheet and decoded GIF frames were visually inspected.

PyMuPDF does not implement the native SVG gradients/clipping used here. The image pipeline applies the same declared radial-gradient stops to the exact SVG surface masks with Pillow, preserving geometry and paint order. These are shared-geometry renders, not browser screenshots. Browser layout, native controls, gradients/clipping playback and accessibility remain unverified. GIF playback cannot honor OS reduced motion; use the HTML’s fixed equivalents.

All repository writes are new files under `design/muse-logo/v3/focus-theme/**`; all previous studies are preserved. No browser surface, local server, CLI/CDP, Electron, new image generation, provider/microphone calls, app/integration/manifest edits, publication, push or merge.
