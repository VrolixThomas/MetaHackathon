# MuseFocus website

Next.js App Router, React, TypeScript, Tailwind and Motion, using the accepted
Pull forward identity and the SuperiorSwarm visual direction.

## Run

From the repository root:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run website:dev
```

Open http://localhost:3000. Production: `bun run website:build`, then
`bun run website:start`. Set `WEBSITE_SITE_URL` to the chosen HTTPS origin before
an eventual deployment. No publication is performed by these source changes.

## Real desktop captures

The walkthrough and feature visuals use original native-window screenshots from
the populated MuseFocus desktop at demo-story commit `901629a`. See
[`public/captures/README.md`](public/captures/README.md) for scene mapping and
observed setup limitations. No screenshot content was recreated or retouched.
The gallery preserves keyboard navigation, full-size image links and the animated
Pull forward logo. Pause and reduced-motion preferences remain supported.

The website explicitly identifies the prepared demo data. Capture selection does
not send messages, approve a PR, operate an account or start a microphone.
The former synthetic UI components were removed. Files in `preview/` are historical
Pillow layout proofs, not current website screenshots; the old proof generator
was retired. Original logo studies and the static prototype remain archived.

## Stack and validation

Core versions match the inspected SuperiorSwarm workspace: Next 15.5.14,
React 19.2.4, Tailwind/PostCSS 4.2.2, Motion 12.38.0, Geist 1.7.0 and
TypeScript 5.9.3. Fonts and integration marks are bundled locally, with their
license/provenance alongside the files. No analytics or signup backend is added.

```sh
bun run --filter @metahackathon/website lint
bun run --filter @metahackathon/website test
bun run --filter @metahackathon/website type-check
bun run website:build
```

Capture coverage, scene cycling and draft/proposal descriptions are checked.
The actual desktop screens were visually inspected during capture. Next's
production build validates the site; browser layout review remains separate.
