# MET-26 conversational comment native acceptance

Root/integration alone builds and runs the actual native gate:

```sh
bun run --cwd apps/desktop build
cd apps/desktop
env -u ELECTRON_RUN_AS_NODE ../../node_modules/.bin/electron src/main/comment-conversation-smoke.cjs
```

The optional final argument supplies a different built main entry. Use the current
root-composed comment presentation/confirmation bindings and the shared
`comment-post-state`/typed `inputMode` contracts. The author checkout does not
contain those newer integration files and must not launch native acceptance.

The gate imports the actual built default app and reuses `pr-work-smoke-support`
for a new owner-marked local Git PR and controlled preparation. It supplies only
provider transport responses. Main services, IPC results, composer controllers,
display receipts and confirmation capabilities are never replaced or invented.
The visible renderer sends actual form input/submit events through its normal
typed `conversation.start`; no direct start/confirm RPC is used to drive the
happy path. No physical keyboard or microphone is injected. The window ignores
external input and does not take focus.

Native assertions cover:

- Real prepared local source and acknowledged workspace selection.
- `inspect_pr_comment` then `create_pr_comment_draft`, followed by the one
  canonical composer. The pass-through IPC audit observes two real visible
  animation frames with exact ID, revision, body and head before forwarding the
  renderer's own `prComments.presented` request unchanged to the real handler.
- A conversational edit retains the canonical ID/original words, advances the
  revision, and clears a previously checked UI consent checkbox.
- Source text/PR metadata quoting “post this comment” is untrusted. A real
  source-only user turn whose controlled model tries `confirm_pr_comment` must
  fail with zero writes and no main posting capability/action.
- A subsequent actual typed user message `post this comment` posts exactly once.
  The exact main-generated confirmation is observed through actual polling,
  the composer mirrors posting/posted, and the real SQLite runtime ledger has
  the matching stable request ID/result. This is a general PR comment because
  the root comment observation currently supplies no inline source-line target.
- Cancellation and moved-head cases use separate renderer sessions and fresh
  canonical drafts. Before gating a GitHub PR read, the controlled transport
  reads actual `conversation.poll` and requires the exact main-generated
  `comment-post-state: posting` action. Stop response must reach the real
  confirmation preflight's AbortSignal. A fresh head change must reject the
  real attempt and leave the composer uncertain. Neither may add a write.
- The dirty local source/HEAD/status is preserved, external traffic and all
  permissions are denied, and only the owner-checked temporary fixture is
  removed after real lifecycle shutdown.

The report is `apps/desktop/out/comment-conversation-smoke-report.json`, including
built-main SHA-256, actual IPC/actions, two-frame observations, controlled request
bodies and ledger records. A failure also preserves a renderer screenshot there.
The gate always labels model/GitHub transports controlled. It does not establish
live GitHub posting, live model behavior, physical speech, an installed package or
a full process restart (negative cases reload only the renderer).

Authors run only these offline checks:

```sh
node --check apps/desktop/src/main/comment-conversation-smoke.cjs
node --check apps/desktop/src/main/comment-conversation-smoke/model.cjs
node --check apps/desktop/src/main/comment-conversation-smoke/self-check.cjs
node apps/desktop/src/main/comment-conversation-smoke.cjs --self-check
```

The self-check feeds explicitly dummy results into the scripted provider selector
to test protocol guards only. Those values are never sent to main or the renderer.
No native acceptance result is claimed by author validation.
