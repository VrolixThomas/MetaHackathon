# MuseFocus website

This is the current website: a Next.js application, with React components,
TypeScript story state, Tailwind/PostCSS and Motion. It ports the accepted dark,
blue-and-ice design and final Pull forward graphics into the same core stack as
the user's SuperiorSwarm website. The static prototypes remain unchanged in
`../site` and `design/muse-logo/v3/` for reference.

## Run

From the repository root:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run website:dev
```

Open **http://localhost:3000**. These commands do not launch Electron or require
provider credentials. Next serves the React app; opening an HTML file is not the
website workflow.

```sh
bun run website:build
bun run website:start
```

The production command uses the normal Next server, not a buildless/static-export
wrapper. The homepage can be prerendered by Next because it does not need a data
backend; its interactive story hydrates as React client components.

## Structure and stack

| Area | Source |
| --- | --- |
| App Router page, metadata, local fonts, CSS | `src/app/` |
| Navigation, hero, narrative sections | `src/components/` |
| Six-chapter interactive story | `src/components/story/` |
| Typed state, content and reducer | `src/lib/story.ts` |
| Frozen final logo model/controller | `src/lib/identity/` |
| Final brand art, icons and social image | `public/` |

Resolved versions match the inspected SuperiorSwarm workspace: Next **15.5.14**,
React/React DOM **19.2.4**, Tailwind/PostCSS **4.2.2**, Motion **12.38.0**,
Geist **1.7.0**, TypeScript **5.9.3**. Bun and Turborepo use the repository's
existing versions. No analytics, signup backend or Supabase connection was added;
the page's purpose is explaining MuseFocus and making the workflow concrete.

The visual source is SuperiorSwarm's `apps/website`, inspected read-only, and the
accepted MuseFocus design. Local fonts and images keep builds independent of font
providers. `public/FONT-LICENSE.txt` accompanies the bundled Geist fonts. The
frozen identity files have narrow Biome exclusions and byte-equality checks.

Framework references: [Next App Router](https://nextjs.org/docs/app),
[Tailwind with Next](https://tailwindcss.com/docs/installation/framework-guides/nextjs),
[Motion reduced motion](https://motion.dev/docs/react-use-reduced-motion).

## The story

The page is built around the user's demo narrative, rather than a disconnected
feature grid:

1. **Plan:** a Linear ticket prompts a thoughtful scope question; a selection
   changes the illustrative v1 brief.
2. **Review:** inspect files from entry point to preparation to persistence.
   Select a file or ask about its relationship to the bigger ticket.
3. **Zoom out:** see the connected flow, an example run request, or a visual
   explanation. Website commands are illustrations, not executed checks.
4. **Propose:** compare before/proposed source for a concrete author-reviewed fix.
5. **Follow up:** explore notification or an explicitly scoped approval policy.
   This website choice does not grant actual approval or merge authority.
6. **Clarify:** reveal a bounded Slack clarification in the original example
   thread, with permission made explicit, then reset it.

One conversation carries the context between these moments. No chapter advances
automatically. The final logo keeps a stable foreground with subtle background
activity; intentional chapter changes trigger its handoff. Ambient motion can be
paused, and OS reduced motion is respected. Tabs support arrow keys/Home/End;
native FAQ disclosures and visible focus states work without a custom controller.

All tickets, code, policies and discussions are explicitly scripted examples.
Product copy is grounded in the current repository and the user's story, with
delegated approval, author review, execution evidence and Slack permissions kept
distinct. No app, account, microphone, provider or external work is operated by
the walkthrough.

## Validation and deployment

```sh
bun run --filter @metahackathon/website type-check
bun run --filter @metahackathon/website lint
bun run --filter @metahackathon/website test
bun run website:build
```

The tests cover story progression, preserved planning choices, code reading
order, scope questions, distinct flow/run/visual modes, before/after source,
notification defaults, bounded clarification, motion controls and exact brand
files. They render the actual React views on the server; they are not browser
interaction or accessibility-tree tests. Build validation checks the real Next
page, generated assets and routing output. Browser review remains manual under
the earlier navigation restriction; no alternate browser or preview server is
used to bypass it.

Optional non-browser design proofs use the existing Pillow/PyMuPDF pipeline.
They are layout compositions, not browser screenshots; see `preview/` when
generated. They do not validate CSS execution, animation or responsive rendering.

For a real deployment, set `WEBSITE_SITE_URL` to the actual owned HTTPS origin
before the production build so social metadata uses the chosen domain. Local
builds use localhost. No domain, published release, signup endpoint or demo-video
URL is invented here. The walkthrough is the working CTA until a real launch
destination is supplied. Deploy from the repository root with install/build
commands above and `apps/website` as the Next workspace, or configure that app as
the project root on a Next-compatible host. Publication is a separate action.
