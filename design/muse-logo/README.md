# Muse · identity in motion

**Recommend 01 / Openfold.** Two broad, soft folds surround a diagonal pocket of air. It contracts and unfolds without losing its identity. It suggests receptive attention and independent parts working together, and is the strongest of these directions at tiny sizes.

Open [index.html](index.html) directly in a browser. It is self-contained, works offline and makes no network requests. All state, placement and amplitude examples are labeled **design simulations**. Nothing connects to the product, providers, audio devices or microphone.

## Three original directions

| Direction | Character / rationale | Tradeoff |
| --- | --- | --- |
| **01 Openfold** | Two sculpted folds, diagonal negative space, compact near-round silhouette. Organic and attentive; holds together in one ink. | The name is carried by the wordmark; the symbol is intentionally abstract. |
| **02 Cadence** | An original broad lowercase **m** with two shoulders that separate for activity. Most directly tied to the name. | Less natural aperture motion; letterform is less distinctive among M-based brands. |
| **03 Lumen** | Two offset crescents surround a lens. Calm perception and a wider voice gesture. | The thin overall silhouette feels smaller at 16px and needs more horizontal room when open. |

All geometry is original editable Bézier paths. The shared lowercase wordmark is path-drawn, with no font dependency. No image generation or borrowed logo geometry was used. Trademark clearance is outside this study.

## Deliverables

- `assets/{openfold,cadence,lumen}/`: eight SVGs each — currentColor master, fixed ink/chalk, light/dark wordmark lockups, light/dark app tiles, standalone path-drawn wordmark.
- `assets/openfold/static/`: all eight status poses in light/dark ink. Badge backplates match the named background; use the live component’s `--surface` for other surfaces.
- `assets/paths.json`: original two-part path data for all directions.
- `muse-mark.js`: small dependency-free controller, embedded in the offline preview.
- `screenshots/`: overview, speaking simulation, sizes/treatments, static states, responsive mobile page.
- `validation.json`: actual standalone Chromium check results and limits.

The tab/favicon is a **static brand mark**; its title conveys state. In-app samples cover a sidebar identity slot and compact voice/status row only. They do not assert actual product activity.

## Motion specification

Use the familiar compact silhouette as home. On entry to listening, working or speaking, the two folds tuck inward for **90ms** toward **86%** scale, then unfold. The badge and text update immediately. The whole mark never spins. Idle has no animation.

| State | Pose and behavior | Static / reduced motion |
| --- | --- | --- |
| Idle | Compact paired shape; no badge or loop. Does not indicate active microphone capture. | Same resting mark. |
| Listening | Slightly open, each fold at 95% scale. Input amplitude increases separation and counter-tilt. Silence holds a recognizable open pose. | Fixed listening pose + three short level strokes. |
| Thinking / working | Contracted base (91%); a **3.6s** cosine fold cycle adds at most 5 viewBox units of separation and 5° of counter-tilt. | Fixed contracted pose + two horizontal work strokes. |
| Speaking | Wider opening; output amplitude increases separation. Represents observed playback, not queued speech or generated text. | Fixed wide pose + three taller level strokes. |
| Needs input | Held open pose, 94% scale, question badge. No repeated pulse. | Same open question pose. |
| Success | One 520ms settling expansion, at most 4.5%, then resting geometry with check badge. | Immediate compact check pose. |
| Error | Contracted 94% pose and exclamation badge. No shake, flash or loop. | Same held exclamation pose. |
| Offline | Contracted 90% pose, cross badge and 56% emphasis. | Same held cross pose; text must say Offline. |

Geometry uses a `0 0 100 100` viewBox. Spread is applied oppositely to the two folds (`x = ±0.7 × spread`, `y = ±spread`); each rotates only around its own shared center in the opposite direction. Maximum voice modulation adds 4 spread units for listening or 5 for speaking and 4° counter-tilt. No global rotation, blur, flashing or color dependency. Terminal badges preserve the identity.

**Transitions:** frame-rate-independent exponential approach, 82ms time constant (about 250ms to 95% settle); interrupted changes start from the current rendered pose. Amplitude is normalized to `[0,1]`, clamped, and smoothed with **65ms attack / 220ms release**. Later integration supplies an actual envelope; audio/capture/playback stay outside this component. Silence never generates fake amplitude. Badges ease over 140ms; labels update on semantic changes only.

**Precedence, within one scope:** Error → Offline → Speaking → Working → Needs input → Success → Listening → Idle. Try combined signals in the preview’s `resolveMuseState()` controls. Error/offline apply to this session or worker, never unrelated providers. Background jobs keep separate marks. Active foreground work/playback defers needs-input/success. Product code bounds success display (suggested 1.2s), then resolves current truth; the controller never clears product events. “Complete” does not mean reviewed, accepted, published or delivered. Barge-in clears actual playback before resolving listening. Existing controllers retain cancellation/generation ownership.

**Reduced motion:** OS `prefers-reduced-motion: reduce` always wins. The manual Reduce motion control also selects fixed poses. Both suppress tucking, loops, amplitude movement, settling and badge fades; the preview disables automatic amplitude variation. Shape badges and adjacent labels preserve state. The component stops scheduled frames when settled or hidden, and the preview stops its tour when hidden. No automatic tour starts on load.

## Size, contrast and accessibility

The preview shows each original at **16, 20, 24 and 32 CSS pixels at 1×**. Openfold’s broad fills and diagonal opening remain visible without color. Use the static brand asset for 16px tabs and favicons. At 20–24px, keep motion amplitude modest and always show adjacent status text; tiny status badges are supplementary and cannot carry a diagnosis alone. At 32px and above the badges are clearer. Reserve the full 100-unit square plus normal layout spacing; never let status motion resize the row. Use at least half a mark width of clear space around standalone identity lockups.

Ink `#242523` and chalk `#F4F3EC` are the primary monochrome pair. Pale sage, lilac and clay in the preview only distinguish concept boards. They do not encode state. The motion stage includes manual light/dark controls; all directions include both SVG treatments. App tiles are editable 100-unit vector compositions with a 74% mark and provisional rounded backing; production macOS masking, `.icns`, platform exports and platform pixel-grid tuning remain later integration work.

Keep an adjacent state label and one accessible name, e.g. “Muse: listening.” Hide decorative duplicates (`decorative: true`). Announce semantic changes politely, never amplitude. Preview controls use native keyboard-accessible elements.

## Reuse and rebuild

`MuseMark.markup(twoPathStrings)` returns an SVG. The strings are in `assets/paths.json`; they can also be taken from an inlined master SVG. Give the SVG an explicit size, `color`, and `--surface` matching its backdrop. Then:

```js
const controller = new MuseMark(svg, { state: 'idle' });
controller.setState('listening', 'Muse: listening');
controller.setAmplitude(0.42); // normalized envelope, never raw audio
controller.setReducedMotion(true); // optional extra reduction; OS still wins
controller.destroy(); // on unmount
```

The controller is a portable design reference, not a registered product component. `setState` accepts `idle`, `listening`, `thinking`, `speaking`, `needs-input`, `success`, `error`, `offline`. Set `direction: 'lumen'` for that direction’s vertical-only spread. No application state, dependencies or manifests were changed.

From this checkout:

```sh
python3 design/muse-logo/build.py
node --check design/muse-logo/muse-mark.js
node design/muse-logo/verify.mjs
```

`build.py` regenerates the SVGs and self-contained HTML from the readable template/controller. `verify.mjs` uses existing local Playwright/Chromium only. On other machines set `MUSE_PLAYWRIGHT_PATH` and `MUSE_CHROMIUM_PATH`; it installs nothing. It checks all states/directions, amplitude response, still idle, manual/OS reduced motion, precedence and mobile overflow, and saves screenshots. No repository build or combined native tests are relevant to these isolated design files.

## Read-only motion reference and limits

Inspected the actual **SuperiorSwarm** checkout at `/Users/Werk/Documents/Repositories/SuperiorSwarm`, HEAD `17a316bf`, with these reference files clean at inspection:

- `apps/website/src/components/animated-logo.tsx`: eased 3.2s contraction/expansion, stronger outer-group contraction than inner-group contraction, stable core, reduced-motion static branch.
- `apps/desktop/src/renderer/components/WorkspaceItem.tsx`, `SwarmIndicator`: the same hierarchy simplified for a 22px working/waiting/completed indicator.

Borrowed only the interaction principle of a stable identity gathering inward then opening, with differential movement. Muse uses two original solid folds, its own negative space, no particle geometry, and no OpenAI knot or brand geometry. No SuperiorSwarm source/assets were copied or modified. The user’s ChatGPT voice-bubble reference informed amplitude-reactive function only.

Validation establishes browser rendering and simulated motion controls, not real microphone responsiveness, provider latency, actual worker states or product accessibility acceptance. No Electron launch, provider call, publication, push, merge, trademark clearance or integration change was made. Scope is exclusively new `design/muse-logo/**` files.
