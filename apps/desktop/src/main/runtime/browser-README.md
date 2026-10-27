# Persistent visible browser (MET-8)

Main composes one `BrowserService` with `openPreview: browserPreviewOpener(getRuntime)` and
`createPage: origin => createElectronBrowserPage(origin, getMainWindow)`. No new dependency.
The service never imports Electron; the adapter owns one sandboxed `WebContentsView` per
open conversation and attaches that very view to the supplied main window when presented.
There is no agent-only page. The accepted preview runner still owns its initial marker
measurement page/server; browser actions and observations never target that measurement page.

Expose `execute(BrowserCommand, AbortSignal?)`, `observe(sessionId, AbortSignal?)`, and
`present(BrowserPresentInput)` through integration's root router/agent ports. Main must
forward the agent turn signal. Transport cancellation alone does not cancel main work.
`close(sessionId)` cancels pending work and retires its page; await `dispose()` before
disposing runtime or cleaning up worktrees. Dispose is idempotent. Root's catalog runtime
subclass must forward the fourth `startPreview(..., revision = "head")` argument.

An open of the same PR/revision keeps the page, inputs, scroll and browser ID. A revision
change closes the old lease/page and returns a new ID and pinned commit. Desktop defaults
to 1024×768; request `{width:390,height:844}` for phone. `present({sessionId,bounds:null})`
hides without closing; bounds are main-window content DIP coordinates. Emulation scales
the requested CSS viewport to fit the native rectangle, preserving website scroll.

Observations contain bounded actual visible text and up to 150 rendered interactive/marker
elements (off-screen rendered elements can be used with scroll). Refs survive observations
within the same document and expire on navigation/replacement. Sequence advances only when
the snapshot changes. Before mutation, both main and the isolated JS world compare the
observed state; stale refs/sequences fail. Each accepted action returns a new observation.
`type` replaces a normal text input's value and fires input/change events; `click` uses the
page's element, including normal form submission/link navigation. Scroll coordinates are
absolute CSS document positions. Password/file/hidden and credential-like inputs are omitted
and cannot be typed. Frames/shadow-root internals and contenteditable are not yet traversed.

The page has an ephemeral partition, no preload, Node or app credentials. All network
requests, navigations and redirects are restricted to the exact active owned loopback
preview origin (including port); external links/resources, permissions, downloads, popups
and embedded webviews are denied. This is a local preview browser, not an arbitrary external
authenticated browsing endpoint. Action cancellation/timeout destroys its page to prevent
late scripts from mutating or reporting state. The next turn must open a new page.

Fixtures now use ordinary GET forms and same-origin cart navigation. Pricing executes the
actual pinned base/head modules (VIP30: base €84, head €72; SPRING15: base €102, head €78).
No payment occurs. Authored fixtures remain fixtures; HTTP/DOM observations are live state,
not proof of real provider operation. Tests mock only native page geometry/ports and cover
service ownership, cancellation, stale actions, origin confinement, actual HTTP pricing,
Git identity and server cleanup. Integration owns native visual/IPC acceptance.
