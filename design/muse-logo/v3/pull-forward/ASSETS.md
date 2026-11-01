# Asset inventory

Primary palette is Blue / Ice. `dark` and `light` describe the intended host surface, not application state. All dimensions below are actual pixels; `@2x` files use twice the named logical size.

| Folder / file | Formats and sizes | Use |
| --- | --- | --- |
| `svg/pull-forward.svg` | Editable transparent colour SVG, 256 viewBox | Primary material mark on dark surfaces |
| `svg/pull-forward-light.svg` | Editable transparent colour SVG | Adapted for light surfaces |
| `svg/pull-forward-{white,black,ink,current-color}.svg` | One-colour SVG | Print-like single-colour, CSS tint and monochrome placement |
| `svg/pull-forward-flat-{dark,light}.svg` | Flat SVG | Material-free colour use |
| `svg/ui/` | SVG, 16/20/24/32/48/64, dark/light; black template SVG | Small interface/status placement |
| `png/transparent/` | RGBA PNG, 64/128/256/512/1024/2048; seven colour/flat/mono treatments | Documents, raster UI and image editors |
| `png/ui/` | RGBA PNG, 16/20/24/32/48/64, dark/light, each @1x and @2x | Actual logical UI sizes and high density |
| `icons/svg/` | Rounded dark/light icon masters; full-bleed square dark/light masters | Platform source artwork |
| `icons/png/` | RGBA PNG, dark/light, 16/20/24/32/40/48/64/128/256/512/1024 | Desktop app/window/Linux icon sources |
| `icons/macos/PullForward.iconset/` | Ten standard PNG entries, 16–1024px | Editable macOS icon source set |
| `icons/macos/PullForward.icns` | Native ICNS | macOS app-icon handoff |
| `icons/windows/PullForward.ico` | Native ICO with 16/20/24/32/40/48/64/128/256 images | Windows app/window-icon handoff |
| `icons/menubar/` | Pure-black-alpha template PNGs, 16/18/20/22 logical px, @1x/@2x | Native template tinting, no baked backing |
| `web/favicon.svg` | Flat, optically sized icon SVG | Vector browser favicon |
| `web/favicon.ico` | ICO with 16/32/48 images | Browser fallback |
| `web/favicon-{16,32,48}.png` | PNG | Explicit raster favicons |
| `web/apple-touch-icon.png` | Opaque square PNG, 180 | Touch/bookmark artwork |
| `web/web-app-{192,512}.png` | Opaque square PNG | Web-app icon artwork; no app manifest was created |
| `web/pinned-tab.svg` | Black SVG with transparent negative space | Single-colour pinned/tinted use |
| `social/avatar-{dark,light}-1024.png` | Square opaque PNG | Avatar/profile source |
| `social/share-card-{dark,light}-1200x630.png` | RGB PNG | Mark at left with open copy space; no wordmark/tagline |
| `motion/pull-forward-working.svg` | Standalone sampled CSS/SMIL SVG, 3.2s | Held focus with background activity; static visible reduction fallback |
| `motion/pull-forward-working-transparent.webp` | Lossless RGBA animated WebP, 512, 3.2s | Clean transparent working loop |
| `motion/pull-forward-working-dark.gif` | Indexed GIF on dark, 512, 3.2s | Working-loop compatibility preview |
| `motion/pull-forward-handoff-transparent.webp` | Lossless RGBA animated WebP, 512, 9.6s | Clean transparent handoff demonstration |
| `motion/pull-forward-handoff-dark.gif` | Indexed GIF on dark, 512, 9.6s | Handoff compatibility preview |
| `motion/pull-forward-handoff-dark.mp4` | H.264, 512, 20fps, 9.6s, no audio | Presentation/sharing video |
| `motion/pull-forward-poster.png` | RGB PNG, 512 | Motion poster/fallback |
| `motion/keyframes/` | Five poses, each transparent/on-dark SVG and 512px PNG | Hold, outgoing, midpoint, incoming, next hold |
| `motion/reduced-motion.svg` | Fixed selected SVG | Static preference fallback |
| `motion/pull-forward.js`, `motion/pull-forward.mjs` | Universal browser/CommonJS and native ESM geometry modules | Exact selected pose/SVG model |
| `motion/controller.js`, `motion/controller.mjs` | Universal browser/CommonJS and native ESM controller | Explicit focus advance, quiet working, pause, reduction, cleanup |
| `motion/*.d.ts`, `motion/*.d.mts` | TypeScript declarations | Model/controller API typing in both formats |
| `motion/pull-forward.css` | Reserved-square CSS | Prevent layout movement |
| `brand-tokens.json` | Colour, spacing, sizing and motion data | Design handoff constants; not a dependency/app manifest |
| `index.html` | Fully self-contained live asset demo | Manual offline opening |
| `preview/` | Usage guide, actual-size proof, decoded movie frame, QA JSON | Review and verification |
| `source/` | Rebuild/export/verification/package scripts and frozen selected reference | Reproducibility, no application integration |
| `SHA256SUMS.txt` | Relative paths and SHA-256 values | Verify delivered files |
| `pull-forward-assets.zip` | Portable bundle rooted at `pull-forward/` | Complete handoff |
| `pull-forward-assets.zip.sha256` | SHA-256 sidecar outside the archive | Complete-download integrity |

The core mark, palette and handoff are final for this selection. The rounded desktop tile and opaque web backing are separate presentations of the same mark. Use the provided micro art for small placement; use the large masters for rich rendering.
