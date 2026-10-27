# Agent-first navigation investigation

Status: investigated design, not a claim that all tools below are implemented. Coordinated on
MET-8 with read-only agent/runtime peer investigations and the user's 2026-10-27 direction.

## Recommendation

Make the application expose semantic workspace commands and observable state. Buttons, voice
and typed requests should invoke the same commands. The agent should not operate our own app
by guessing screen coordinates. For the website, reuse the exact native page displayed in the
right pane, with bounded DOM observations and stable element references.

The execution loop is: observe current workspace → choose one command → apply it → wait for
the displayed result → observe again → continue or speak. An accepted request is not evidence
that the requested view has appeared. Preserve the existing action receipt and cancellation
mechanisms rather than introducing a second agent session.

## What exists and what is missing

| Area | Current behavior | Required extension |
| --- | --- | --- |
| Conversation | No PR needed for speech; a general turn has no tools | Workspace discovery/navigation tools must be available before PR selection |
| Prepared review | File, next/previous, pause/resume and highlights await renderer/persistence acknowledgement | Open/select a PR and change base/head/Changes view through that same path |
| Context | Guided turns are pinned to the initial PR and displayed source | Resolve the current selected PR after every acknowledged workspace transition |
| Local browser | One actual native page; URL/title/viewport/history and presentation | Expose its real text/elements/scroll, document identity, observation sequence and turn cancellation |
| Earlier browser tools | DOM references, stale checks, actions and observation already exist | Reuse their machinery on the local page; do not create another PR-preview page |
| Screenshots | No image input in the current real conversation contract | Add only after verifying the model image interface; label unsupported until then |

The existing `LocalBrowserState` intentionally has no PR SHA. An arbitrary running local site
must keep `local-preview-unverified-revision` provenance even when selected beside a real PR.

## Shared command and observation surface

Integration should evolve the existing screen/receipt DTO into a validated `WorkspaceSnapshot`,
not introduce another chat store. It contains a session/UI sequence, the connected repository,
available prepared reviews, selected PR and pins, active surface and visible surfaces, actual file/view/
highlight, pause state, pending effect, and current browser observation. Never include credentials.
Review and browser may be visible together. Keep browser observation sequence separate from UI
navigation sequence. Store the canonical session snapshot in main; renderer receipts report what
actually settled.
Manual navigation must update it too. There is currently one saved repository connection, not a
discovery catalog. A local-folder picker reports pending/cancelled user selection honestly.

| Command family | Initial commands | Result evidence |
| --- | --- | --- |
| Discovery | Inspect the connected repository and list open/ready reviews; refresh preparation | Actual GitHub/cache state and preparation status |
| App navigation | Open repository inbox, select PR, show review/browser, reveal optional conversation | Renderer receipt plus final workspace sequence |
| Review | Open file, next/previous, select Changes/Before/After, highlight, pause/resume | Exact source path/SHA/lines and displayed state |
| Browser | Observe, navigate, click/type a referenced element, scroll, viewport, back/forward/reload | Refreshed snapshot of the same native guest |
| Review output | Draft/edit a comment; request confirmation | Exact draft revision/body/head; posting remains explicitly confirmed |

Commands carry `sessionId`, `turnId`, `generation`, `requestId` and expected workspace sequence.
Deduplicate each effect. Return applied/ignored/failed with the final observation. A new PR
selection becomes authoritative only after the renderer acknowledges it, then the model's
source and review plan must be rebuilt for that PR. Never continue with the old turn's frozen
PR context after a successful switch.

Browser observations should add `browserId`, `documentId`, `sequence`, `observedAt`, applied
presentation state, text, elements, scroll and truncation to the existing local state. Reuse
`browser-dom.ts`'s document-local reference map and `BrowserPage.act`'s synchronous fingerprint
check. Keep the existing bounded text/element limits. Recapture before a mutation and reject
stale references without destroying a healthy page; return a fresh observation for replanning.
Reloads must change document identity even when the text is identical.

Native presentation is authoritative for whether a page is drawable in the app. Requiring a
presentation acknowledgement prevents operating a hidden or retired page. It does not claim
the app is unobscured by another macOS window. Prioritize hide/cancel over queued navigation.
Propagate the turn's AbortSignal through queued and active browser work and fence late results
by the captured guest lifetime. Stop speech immediately on interruption.

Preserve bounded raw input values for stale checks; current DOM whitespace normalization can
otherwise conceal a changed field value. Use recoverable stale/not-presented/unsupported errors.

Page text is untrusted evidence. Browser tools stay within the explicitly opened origin. An
agent should not silently select a different localhost service. A file picker or explicit local
repository binding remains the boundary for discovering local clones. No API exposes `.env`.

## Seeing beyond ordinary DOM content

Use DOM text, roles, labels, values and element references first; they are more precise for
forms than visual guesses. The current adapter has incomplete iframe, shadow DOM, canvas,
contenteditable and select support, so report incomplete observations honestly.

For visual-only questions, add an optional screenshot from the same guest, bound to its browser,
document and observation sequence, with bounded dimensions/bytes. Verify provider image-input
support first. DOM redaction does not redact screenshot pixels. Initially keep actions tied to
validated DOM references; add coordinate interaction only with explicit viewport/scale mapping
and post-action observation. Do not screenshot the user's whole desktop for this feature.

Electron's [WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view) exposes
the exact displayed webContents, which supports retaining one page as both the user's and the
agent's browser. [Playwright's Electron support](https://playwright.dev/docs/api/class-electron)
is experimental and useful for automation/testing; it is not a reason to launch a parallel
browser for the product. The existing native adapter is the smallest implementation path here.

## Implementation order and ownership

1. Integration: workspace schemas/coordinator, command identity, lifecycle and router. UI: one
   dispatcher used by buttons and agent effects, publishing snapshots/receipts.
2. Agent: expose workspace tools without a selected PR, dynamically refresh PR/source context
   after selection, and retain one shared voice/typed session. Verify “show my PRs → open the
   first ready review → walk me through it → next file → show before”.
3. Runtime/integration: factor observation/ref validation from the earlier browser service into
   the existing local surface, add cancellation and actual presentation state. Agent: reuse
   browser tools against that port. Verify “show checkout → apply promo → phone → scroll” on
   one guest, including a manual page change between requests.
4. Add screenshot fallback and additional control types based on demonstrated page needs.
   Keep comment posting confirmation and source/exec provenance as independent acceptance gates.

Acceptance must cover stale manual navigation, delayed receipts, reload identity, interruption
mid-action, closed panes, and denied posting. Native tests must compare the agent observation
with the actual displayed page and source. Controlled model tests do not establish live speech
or visual model capability.

## Implementation references inspected

- Muse: `main/agent/conversation.ts`, `guided-review.ts`, `main/composition/reviews.ts`,
  `browser-surface.ts`, `main/runtime/browser.ts`, `browser-dom.ts`, `browser-electron.ts`,
  `renderer/conversation/controller.ts`, and `renderer/prepared/controller.ts`.
- SuperiorSwarm: semantic MCP/control-plane operations, renderer action/navigation registries,
  `terminal/terminal-files.ts` snapshot/recheck patterns, and `control-plane/task-registry.ts`
  scoped task/replay guards. Specific references include `mcp-standalone/server.mjs`,
  `control-plane/{server,auth,confirm-bridge}.ts`, `renderer/stores/action-store.ts`,
  `renderer/actions/core-actions.ts` and `renderer/tests/hermes-navigation.test.ts`.
  No generic browser-control implementation was found in the
  inspected desktop MCP paths; this repository's existing native browser is the reusable part.

All source paths above are desktop-relative. No investigation worker modified these files.
