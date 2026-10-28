# Browser pane follow-up

The user screenshot showed a 1024×768 page scaled into the corner of a much larger canvas.
Desktop now follows the actual pane width/height. Phone remains a centered 390×844 viewport.
This uses the same persistent native webContents; it does not reload or replace the page.

The optional conversation pane is on the left, with the canvas area on the right. Browser,
code, document and visual tabs share this shell. Browser tabs show the observed page title
without repeated kind labels; navigation, address and viewport selector share one compact row.
Page dimensions and revision provenance remain accessible in descriptions/tooltips.
Transcript and typing remain hidden until requested, and voice controls remain available.

## Verification

692 TypeScript tests, type-check, lint and production build pass.

The integrated native workspace check uses a real loopback website, actual renderer/preload/IPC,
controlled GitHub/model responses and a temporary dirty Git repository. It verifies rendered
canvas content, browser interaction, review source, narration receipts and persistence.
Additional native layout checks compare the actual WebContentsView bounds, renderer host bounds
and observed DOM viewport, rather than relying on CSS declarations.

One measured run (CSS pixels):

| State | Observed page viewport |
| --- | --- |
| Desktop beside conversation, window 1440×900 | 1008×684 |
| Phone | 390×844, native surface centered inside its pane |
| Desktop after window resize to 1280×820 | 896×604 |
| Conversation closed | 1280×604 |
| Conversation reopened on left | 896×604 |

All five states retained the same browser ID and submitted form value. The compact browser
control row measured 40px. A three-file source review then completed in the same application.
The local-browser native check additionally covers back/forward/reload, source/browser tabs,
phone selection, split resizing, modal hiding, preserved unsent input, close/reopen and shutdown.
V1, prepared-review/source highlighting and controlled hands-free native checks also pass.

Run from the integration checkout:

```sh
bun run build
bun run --filter @metahackathon/desktop preview
```

Regression commands:

```sh
bun run type-check
bun run lint
bun test apps/desktop/src
bun run test:workspace
bun run test:local-browser
```

The workspace script now enables its native layout checks by default. Reports remain under
`apps/desktop/out/`. Optional `WORKSPACE_SMOKE_HOLD_MS=30000 WORKSPACE_SMOKE_HOLD_STAGE=browser`
leaves its real controlled website open for inspection. Test content never enters normal startup.
These checks are not live speech verification or PR execution evidence.

Native window screenshot capture was unavailable under the current macOS capture permission.
A renderer-only capture omits WebContentsView, so it was discarded; no blank or composited image
is presented as a screenshot of the working browser.

A related integration race was fixed while validating the source transition: a connection poll
must not publish a source change for an empty review, or discard a matching pinned navigation
still loading. Existing revision, cancellation and foreign-source guards remain enforced.
