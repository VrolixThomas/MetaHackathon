# Identity study v2

**Recommend 01 / Pocket creature.** It reads as a little creature immediately; the uneven ears, bean body and two feet hold a clear small silhouette, while gaze and a squish–peek–pop gesture add personality. This is a new character study prompted by the feedback that v1 was too abstract. V1 is preserved. There are no initials, monograms, final app names or wordmarks in v2.

Open [index.html](index.html) manually in a browser. It is fully self-contained, with no server, fonts, dependencies or network requests. The three heroes immediately perform distinct **working motion simulations**, unless the OS requests reduced motion. Each sits beside a static identity drawing. All controls and placements are design simulations; nothing observes actual work, speech or a microphone.

| Direction | What it is and why it fits | Personality / tradeoff |
| --- | --- | --- |
| 01 / Pocket creature | A curious pocket creature that leans in to hear you and springs into action, making a voice engineering assistant feel approachable. | Curious, springy, slightly mischievous. Strongest tiny identity; its relation to engineering comes from attentive behavior rather than a literal tool. |
| 02 / Firefly | A friendly firefly that opens its wings around a steady light, showing focused engineering work without losing its calm center. | Patient and precise. Best stable-core motion; antennae and legs simplify strongly at 16px. |
| 03 / Octopus helper | A soft eight-armed helper that gathers loose threads and opens them toward you, making parallel engineering work feel coordinated. | Generous and capable. Most direct parallel-work metaphor; needs the most detail reduction at small sizes. |

All paths were authored from scratch for this study. No prior folds, letter geometry, reference mascot artwork or generated raster artwork is used.

## Review artifacts

- [Overview PNG](renders/overview.png): three directions, working keyframes, true-size samples, mono treatments, app tiles and recommendation.
- [Working comparison GIF](renders/working-comparison.gif): three animated characters side by side, sampled from the shared JS pose model. It is an illustrative loop and does not respond to reduced-motion settings; use the HTML for accessible motion controls.
- [Static state sheet](renders/static-states.png): all eight fixed states in color/light and mono/dark.
- [Sizes and use PNG](renders/sizes-and-use.png): actual 16/20/24/32/64px samples, status rows and light/dark placement.
- [Motion contact sheet](renders/motion-contact-sheet.png): six time samples of each distinct working cycle.
- `assets/{pocket,firefly,octopus}/`: **69 editable SVGs** total. Each direction has a color master, a purpose-drawn 16px micro master, two mono treatments, two app tiles, 16 state exports and a standalone animated working SVG.

The animated SVGs contain native paths and embedded CSS with a reduced-motion fallback. They are lightweight illustrative loops; the JS controller is the authoritative stateful design reference. The CSS-only loops approximate its choreography. The animated GIF is rendered from its exact pose model, without a browser or CSS engine.

## Motion and static-state specification

All art lives in a reserved `120 × 120` viewBox. Motion changes internal geometry, never the surrounding layout. Distinct silhouettes remain visible through all poses. No status badges, detached sparkles, global spins, flashing or color-only messages.

| State | Pocket creature | Firefly | Octopus helper |
| --- | --- | --- | --- |
| Idle | Gaze drifts gently; rare blink; one ear settles. | Blink and gaze; core and wings stay still. | Blink and gaze; arms rest. |
| Listening | Leans 9° toward the voice; raised ear responds to input envelope. | Holds open wings; envelope increases their opening; core stays fixed. | Leans 6°; upper arms lift in attention with envelope. |
| Thinking / working | 2.4s **gather → squish → peek/pop → foot gesture**. Squish reaches 114% width / 83% height; pop lifts up to 9 units. Gaze and lean alternate over 4.8s. | 1.6s **close → open → settle**. Wings turn around separate hinges, ranging −15° to +39°; abdomen light varies gently from 74–100%. Body position, scale and rotation never move. | 2.4s **gather → sort → offer**. Eight arms move with different leverage; primary rotation ranges −28° to +36°, with a delayed upper-arm gesture and small 4° lean. |
| Speaking | Mouth follows output envelope; ears and feet accompany a slight stretch. | Wing opening follows output envelope; antennae gesture; core stays fixed. | Mouth follows output envelope; arms extend as if explaining. |
| Needs input | Looks up toward you, lifts an ear and makes one small foot invitation. | Looks toward you, holds wings open and gives one antenna invitation. | Looks toward you and raises one arm once. |
| Success | One 720ms hop; happy eyes; settles. | One wing lift; happy eyes; steady core. | One 720ms lift and open-arm celebration; settles. |
| Error | Concerned brows and frown; ears lower; held pose. | Concerned brows; wings fold; held pose. | Concerned brows and frown; arms flatten; held pose. |
| Offline | Eyes close to slits; ears and body settle; held pose. | Wings close; eyes narrow; abdomen light dims; held pose. | Eyes narrow; arms lower; held pose. |

**Amplitude:** `setAmplitude()` accepts a normalized `[0,1]` envelope. Values clamp; non-finite values resolve to silence. Smoothing uses a 65ms attack / 220ms release. Only listening and speaking react to amplitude. Silence does not generate fake speech. The opt-in **Synthetic envelope** control is clearly simulated; working has its own choreography.

**State changes:** labels change immediately. State entry starts that state’s gesture; the per-frame pose follows its target with a 45ms time constant. Needs-input gestures finish within 650ms, success within 720ms; both stop frame scheduling after 1.3s. Error and offline do not loop. Success means the current operation finished; it does not establish accepted review, publication or source delivery. This component never decides state precedence or cancels product work.

**Reduced motion / pause:** OS `prefers-reduced-motion: reduce` always wins over the study controls. It disables blink, gaze drift, squish, hop, wing/arm animation and envelope movement, selecting distinct fixed semantic poses. **Static poses** adds the same reduction manually. Pause also presents the fixed pose. Synthetic animation and the optional state tour stop in these modes. Hidden documents cancel frames and tours; controller `destroy()` releases listeners and scheduled work. Labels update on state changes, never on amplitude frames.

## Size, color and placement

- **16/20px:** use `micro-16.svg` at either size. These are purpose-drawn static silhouettes: larger eye gaps, fewer limbs/lines and no highlights or mouth. Preserve adjacent status text. Do not animate tiny facial details or rely on a tiny icon to diagnose an error.
- **24–64px:** use the expressive master and bounded internal motion. The preview shows actual CSS-pixel samples and a larger hero.
- **Mono:** ink `#25332F` on `#FFFDF7`, chalk `#F9F6ED` on `#202A29`. Eye/mouth negative space is painted in the named substrate color; these are not alpha-cutout exports. Regenerate the surface color for another background.
- **Color:** pocket `#E87759`, wings `#D6DF77`, octopus `#8D9DE3`. The firefly’s dark-theme core adapts to sage `#9AAD96` so its body and antennae remain visible. Color does not encode status.
- App tiles have provisional rounded backings and generous padding, with light and dark exports. No platform icon bundle or production mask is claimed. Tiny status rows use a still micro mark plus exact text. Keep at least ¼ of a mark width of external clear space; reserve the full art box during motion.

## Reuse

`companion.js` exports `Companion` in a browser (or CommonJS in Node). `companion.css` reserves space. Insert a color SVG from the API or an editable master, then mount the controller:

```js
host.innerHTML = Companion.svg('pocket', { size: 32, decorative: true });
const controller = new Companion.Controller(host.querySelector('svg'), {
  kind: 'pocket', state: 'idle', decorative: true,
  theme: 'light', mono: false
});
controller.setState('listening');
controller.setAmplitude(0.42); // observed normalized envelope supplied later
controller.setReducedMotion(true); // optional; OS preference still wins
controller.setPaused(false);
controller.destroy(); // unmount
```

Supported kinds: `pocket`, `firefly`, `octopus`. Supported states: `idle`, `listening`, `thinking`, `speaking`, `needs-input`, `success`, `error`, `offline`. Set `decorative: false` for a single accessible SVG name; keep decorative duplicate samples hidden. Product code should announce exact semantic status in adjacent text. The study’s heroes are decorative, with one shared polite live status region.

`Companion.pose()`, `attributes()`, `scene()` and `svg()` expose the same editable geometry for deterministic static frames. This is a portable design reference with no product bindings, state resolver, capture, audio or provider transport.

## Rebuild and actual validation

From the checkout root:

```sh
node design/muse-logo/v2/build.cjs
node --check design/muse-logo/v2/companion.js
node --check design/muse-logo/v2/preview.js
node design/muse-logo/v2/verify.cjs
python3 design/muse-logo/v2/render.py
```

The renderer uses locally available **PyMuPDF + Pillow**, installs nothing, and writes only within this directory. `build.cjs` embeds the controller, CSS, drawings and data-URI app tiles into one offline HTML file. `render-samples.json` is generated input for the boards/GIF.

**Performed:** JS syntax checks; 5,832 finite motion-pose samples across all directions/states/amplitude extremes; stateful controller checks using a non-browser attribute/event adapter (amplitude smoothing, manual/OS reduction, hidden-document suspension, one-shot/held states and cleanup); HTML source checks for all controls and absence of external code/network/media APIs; XML parse and rasterization of all 69 SVGs; 336 sampled rich-pose bounds checks; 60-frame GIF render. Overview, full static-state sheet, size/usage sheet and motion contact sheet were visually inspected using image tooling.

**Limits:** The parent browser tool blocked local-file navigation. That restriction was respected: no browser navigation, alternate browser surface, CLI browser, CDP, local server or Electron launch was used. The PNGs/GIF come from non-browser SVG rendering, not browser screenshots. Browser layout, actual interactions, CSS-only SVG playback, native accessibility and manual HTML playback remain unverified. No microphone, provider, product, manifest, integration, publication, merge or push work was performed. See [validation.json](validation.json) and [render-validation.json](render-validation.json) for the recorded check scopes.
