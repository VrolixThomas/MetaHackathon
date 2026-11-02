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

Run `bun test apps/website/src/lib/releases.test.tsx` from the repository root
to check release selection, architecture choices and unavailable-download states.

Capture coverage, scene cycling and draft/proposal descriptions are checked.
The actual desktop screens were visually inspected during capture. Next's
production build validates the site; browser layout review remains separate.

## Website deployment and downloads

Vercel project `musefocus` deploys `apps/website` from `main` to
https://musefocus.app. Set `WEBSITE_SITE_URL=https://musefocus.app` in production.
Install with `bun install --frozen-lockfile --ignore-scripts` and build with
`bun run build` from this app directory; shared workspace files must be included.

The homepage checks the public `VrolixThomas/MetaHackathon` latest-release API
on the server. The page and lookup revalidate on requests after five minutes,
so publishing a release does not require a website commit or redeployment.
No GitHub token is needed or exposed. Drafts and prereleases are not selected.

Download buttons use uploaded, non-empty `MuseFocus-<version>-arm64.dmg`,
`-x64.dmg`, or `-universal.dmg` assets from that exact repository and release.
Architecture choices reflect the published assets; local unsigned artifacts are
excluded. The site does not assert signing or notarization from a filename.
Until an installer is published, the download section explains its availability
and links to GitHub releases. API failures retain a working releases-page link.

The current macOS workflow preserves verified candidates as Actions artifacts;
it does not publish GitHub Releases automatically. Runtime's reviewed release
publication remains separate from the website. A public repository or successful
website deployment alone does not create an app download.
