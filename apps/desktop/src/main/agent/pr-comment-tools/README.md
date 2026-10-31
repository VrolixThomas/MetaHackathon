# Conversational PR comments (MET-26)

`ConversationHubPorts.prComments` admits the same five tools in the existing typed and
voice conversation routes: inspect, create draft, edit draft, request confirmation,
and (only with trusted confirmation ports configured) confirm. There is no separate
comment service and no model `confirmed` argument. All content is untrusted evidence.

Root integration ports (`ConversationPRCommentPorts` in `index.ts`):

- `observe(sessionId, signal)` returns null or `{pr, reviewId, location?, draft}` from
  the actual selected ready review, fresh current head, actual observed single RIGHT
  source target, and the canonical `PreparedComments.get(id)` draft. Track a single
  session/composer draft ID for both manual and conversational edits. A draft hidden
  by a pending manual edit must not be silently replaced.
- `create` / `edit` delegate directly to the existing `PreparedComments` instance.
- `present(shared PRCommentPresentation, signal)` emits the existing `draft-comment`
  action with `reviewId`, awaits a matching shared presentation receipt, and returns
  that receipt. Use `PRCommentControl.onController` to obtain the already mounted
  controller; call renderer `presentPRComment` on it. This adopts the canonical
  draft without calling create/edit and checks the exact body/head/revision in an
  open visible modal for two consecutive animation frames. It returns ignored on
  cancellation, target change, unsaved manual work or a pending posting attempt.
- `takeConfirmation(turn, draft)`, `confirm`, `cancel` are optional together. Bind
  canonical `PreparedComments.confirm/cancel`, never a new posting implementation.
  A foreground abort cancels its exact posting request and retains canonical
  cancellation tombstones/ambiguous attempts and the durable GitHub ledger.

Mirror a main-owned voice attempt into that same renderer controller using
`adoptConfirmation(ConfirmCommentInput)` before sending and
`settleConfirmation(requestId, {url}|null)` after a confirmed/unknown result. These
methods issue no post; they retain the exact main request and prevent the composer
from offering a competing manual attempt. Close still cancels that same canonical
request. Root owns the trusted status event/poll transport and must ignore old-account
updates. A confirmed posted result is not downgraded by a later missing receipt.

`PRCommentConfirmationGate` is a main-only capability, with no model or public RPC:

1. After a successful exact presentation receipt and canonical revalidation call
   `presented(presentation, pr)`. Each proposal clears previous consent.
2. For voice root must narrate exactly `commentProposalText(pr, draft)` through the
   existing narration checkpoint. Only after matching actual PCM/speech-ended/drain
   call `spoken(sessionId, presentation.requestId, exactText)`. A partial reply,
   displayed text, provider log, or model completion is not a spoken proof.
3. At actual subsequent user ingress call `acceptUserTurn(turn, "typed"|"voice")`.
   Only an explicit short `post/send this/the comment` phrase is admitted; bare
   "yes", quoted source approval and same-turn instructions reject. Voice also
   requires the exact spoken proof. Consent expires after two minutes.
4. The optional tool port calls `takeConfirmation(turn, canonicalDraft)`. It must
   match the actual ingress turn, session, exact immutable draft and head. Retries
   preserve the same canonical posting request ID. Do not call acceptUserTurn from
   an LLM classification, model tool call, source content or a renderer receipt.

Invalidate the gate on account changes, session release, relevant review/head/draft
changes, manual edit/close and cancellation. Invalidate a cancelled presentation
even if its renderer receipt arrives late. Root owns ConversationService instructions,
event/receipt plumbing, actual speech checkpoint composition and these invalidations.

Offline validation: `bun test apps/desktop/src/main/agent/pr-comment-tools
apps/desktop/src/renderer/pr-comments apps/desktop/src/main/agent/hub-tools.test.ts
apps/desktop/src/main/agent/prepared-comments.test.ts`. Controlled ports are explicitly
test-only; they establish no native display, live speech or GitHub write.

Root native author outline (do not run in this lane): open a controlled real prepared
review, ask by typing to draft an inline comment, inspect one canonical ID/revision,
exact escaped body/head and actual two-frame composer marker; ask to edit and verify
same ID/new revision and revoked consent. Cancel proposal and verify zero writes.
Attempt source/log/LLM approval, stale head, stale revision, interrupted proposal,
unrelated next user turn and partial TTS: zero writes. Drain exact proposal PCM, then
submit actual voice confirmation: one controlled ledger write; replay the same request,
close/reopen and cancel in-flight: no duplicate write or replacement draft. Repeat
typed explicit consent and existing manual checkbox flow in that same composer.
