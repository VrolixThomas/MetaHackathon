# MuseFocus website

First complete local website using the settled **MuseFocus** name and frozen
**Pull forward / Blue–Ice** identity. No application or shared files changed.

Open **MuseFocus.html** manually for a self-contained version, including fonts,
images, motion and interaction. Alternatively open `dist/index.html` with its
adjacent files. The ZIP contains the static, dependency-free website; extract it
and open `index.html`. No installation, server, account or microphone is needed.

## Design

The central style reference is the user's SuperiorSwarm website, inspected
read-only at commit `17a316bf`:

- `apps/website/src/app/globals.css`: near-black base, restrained surfaces,
  subtle borders, secondary gray text and a quiet accent glow.
- `components/nav.tsx`, `hero.tsx`, `section.tsx`: minimal fixed navigation,
  centered mark and headline, pill actions, generous alternating sections.
- `components/mockup/mockup-shell.tsx`, `feature-sections.tsx`: a native-feeling
  interactive workspace and small, specific product illustrations.

MuseFocus has its own copy, composition, blue-and-ice atmosphere and attention
story. Existing Pull forward assets are copied byte-for-byte from `../pull-forward`.
The brand geometry is unchanged. Geist Sans and Geist Mono are bundled locally;
the SIL Open Font License is in `dist/assets/FONT-LICENSE.txt`.

The page moves from promise → interactive focus workspace → the attention
problem → background work → review and conversation → existing sources → FAQ
and a closing invitation. The primary CTA opens the working illustration.

## What works

- Choose among three different work examples; the title, context, code, discussion
  and revision example change together. “Next into focus” loops through the items.
- Switch between the change and its scripted discussion. Tabs support arrow keys,
  Home and End, selection metadata and visible keyboard focus.
- Explore a revision, then advance to clear it. No real decision or job is created.
- Pull forward keeps its foreground stable, with restrained background motion.
  Intentional item changes trigger the existing mark's handoff and a brief settle.
- Pause ambient motion. OS reduced motion also stops ambient animation and uses
  immediate logo handoffs; no autoplay audio or automatic item advancement.
- Real local favicons, touch icon, social image, bundled fonts, native FAQ
  disclosures, anchor navigation and a static first scene when JavaScript is off.

All workspace data and conversations are explicitly illustrative. Product copy
is grounded in this repository's README and current direction. The page claims
neither a public release nor hosted always-on execution. No download, waitlist,
analytics, account integration or provider endpoint has been invented.

## Validation and limits

Run from this directory:

```sh
node --check dist/site.js
node source/verify.cjs
python3 source/render_preview.py
python3 source/build.py
```

The interaction probe runs the **actual mount/event code** against a controlled
DOM adapter: selection, item loop, changed content, discussion, keyboard tabs,
revision reset, live announcements, pause/resume and exact brand-asset copies.
It is not a browser or accessibility-tree test. Static validation checks IDs,
all anchor/control targets, linked files, fonts, image alternatives and absence
of remote dependencies/media calls. See `preview/validation.json`.

`preview/*-layout.png` and `*-first-look.png` are **Pillow layout compositions**
using the actual brand PNG, local fonts, HTML copy and vector icons. They are
design proofs, not browser screenshots; CSS gradients, precise line wrapping,
responsive behavior and animation still require a manual browser review.

No browser, local server or Electron app was launched. This respects the earlier
explicit browser-navigation restriction. No provider/microphone calls, new
dependencies, publication, push, merge or changes outside the new owned folder.

## Launch handoff

`dist/` is the deployable static folder. `MuseFocus.html` is the single-file
review artifact. Before an eventual publication, set a real release/waitlist
destination if desired and add canonical/absolute social URLs for the chosen
domain. Publication remains a separate action. The current page works entirely
as a local interactive introduction.

## Production deployment (2026-11-02)

The site is published at https://musefocus.app on the Vercel project `musefocus`
in `thomas-projects-18c8a57b`. `www.musefocus.app` redirects to the apex domain;
Cloudflare retains domain registration and DNS.

Vercel is connected to `VrolixThomas/MetaHackathon`. Production tracks
`design/muse-logo-motion`, with root directory
`design/muse-logo/v3/musefocus-site/dist`. Commit and push changes to the files
in that directory on this branch to update production automatically. Changes
on other branches do not update the production domain.

`dist/vercel.json` serves the committed static files directly, with no install
or build command. Edit `dist/` as the website source; `source/build.py` assembles
the standalone HTML and ZIP review artifacts rather than generating `dist/`.
The original November 1 deployment used a browser upload; the Git connection
replaces that manual update workflow. No environment variables are needed.
