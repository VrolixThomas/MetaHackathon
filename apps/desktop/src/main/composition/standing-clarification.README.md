# MET-8 production standing Slack clarification

Production wiring lives in `services.ts`, `standing-clarification.ts`,
`standing-clarification-tools.ts`, `hub-tools.ts`, and `foreground-profile.ts`.
No manifest, shared contract, renderer, or ConversationService change is required.

## Durable intake and delivery

`initializeDay` constructs `StandingClarification` against the existing
`DayStore.standingTransaction`. The same controller serves foreground rules and
DayService admission/parent authorization. The existing `replies` adapter and
original-thread send ledger are unchanged; this composition has no sender.

Slack intake captures the selected credential before `classifyDayMessage`, checks
its actor and final current credential, then retains the original validated result
before reducing it to Day metadata. It never reconstructs a classifier binding
from summaries. `classifyStandingIncoming` obtains fresh channel access, checks the
Day actor, and consumes the original source/body/connection binding once.

Bindings require an unchanged, recent message from another author with a literal
mention of the selected user. They expire after 30 seconds, are capped at 128,
and clear during account refresh/Day replacement/shutdown. Backlog/cache/tool reads
cannot mint bindings. DayService keeps its fresh complete thread checks, atomic
parent budgets, explicit standing child with `confirmedAt: null`, parent expiry
and revoke checks, and existing original-thread durable delivery ledger. Foreground
speech cancellation does not cancel admitted children or independent workers.

## Actual foreground ingress

`onUserTurn` invokes `StandingClarificationComposition.admit` for **every actual
user turn**, before model work. The previous opaque capability is retired
synchronously. Unrelated/negative turns invalidate pending consent immediately and
need no Slack network access. Assistant attention, model/source text and history
never enter this hook. Existing teamShare, reviewRequests, comment and approval
hooks remain intact.

The existing `ConversationHubTools.approvalContext` call is the foreground
preflight in ConversationService, before workspace observation/navigation/model
work. It now awaits `standing.ready`, then constructs tools with the single
captured opaque token. Rebuilding hub tools reuses that token, never registers
another user event. Controlled tests hold capture and verify no model/navigation
can overtake it. Both review and workspace runners use this preflight.

Capture uses only the acknowledged workspace snapshot. A unique Slack channel
selected in the visible primary or secondary pane is required; hidden tabs,
model-proposed channels, source text and multiple different visible channels do
not qualify. A review may remain primary with Slack secondary. The selected
channel is rechecked after fresh credential/membership access. The presentation
label is the main-owned channel ID; no provider label grants authority. Missing
selection/access omits rule tools and asks the human to select the channel.

Session release, account/connection epoch changes, explicit Stop speech,
foreground cancellation and shutdown retire pending authority. Each operation
rechecks actor, connection, channel and fresh joined/reply access. Original
request/turn identities reject same-turn consent. Only the immediately following
actual affirmative turn may consume a pending proposal; even an unused affirmative
cannot be replayed by a later yes.

## Canonical typed and voice publication

A clear request such as “Let Muse ask clarification on fresh mentions while I
review” selects standing-rule tools. Explicit propose/draft/set-up rule requests
and list/revoke are supported. Bounds remain 5–30 minutes, 1–5 threads, 1–3
messages per thread and 1–10 messages total. Model-selected defaults are proposals
only. Scope, channel, every bound, exclusions and the final activation question
are included verbatim in the canonical text.

The production publisher calls **ConversationService.narrateProposal** directly
while the tool awaits it. Its existing narration checkpoint returns `spoken`
after the renderer's drained speech acknowledgement, or `displayed` after the
renderer text receipt. The main-only standing receipt binds that delivery kind
to exact proposal ID, digest, text, session, turn and request. Tool JSON is never
publication proof. Voice proposals require `spoken`; typed proposals require
`displayed`. A voice confirmation cannot activate a merely displayed proposal.

After verified publication the existing terminal foreground handoff returns an
empty acknowledgement: the exact canonical question is already in the conversation,
and neither runner makes another model request or appends a paraphrase. Proposal
and confirmation must be distinct actual turns. Negative/conditional/quoted or
extra-clause responses cannot confirm. Publication may drain for up to five minutes
once admitted, so a full spoken canonical policy is not invalidated by the short
30-second ingress admission window. The resulting receipt expires in five minutes.
Cancellation/identity checks still apply throughout. There is no voice-unavailable
fallback and no fabricated narration receipt.

## Controlled validation and remaining root acceptance

Use integration's `node_modules` symlink. Focused validation:

```sh
bun test apps/desktop/src/main/agent/standing-clarification-tools.test.ts apps/desktop/src/main/composition/standing-clarification.test.ts apps/desktop/src/main/day/standing-clarification.test.ts apps/desktop/src/main/day/service.test.ts apps/desktop/src/main/agent/foreground-profile.test.ts apps/desktop/src/main/agent/hub-tools.test.ts
bunx tsc --noEmit -p apps/desktop/tsconfig.main.json
```

Tests exercise the real controller, composition, ConversationService and both
foreground runners with controlled persistence/access/provider/renderer receipts.
They distinguish typed display from spoken delivery, block model work during
capture, require distinct actual ingress, preserve the canonical terminal question,
and cover account/source/access drift, cancellation, expiry/revocation and budgets.
They do not establish native visibility, microphone/speaker acoustics, live Slack,
or a production database restart.

Root retains these acceptance steps in the integration checkout:

1. Run normal integrated type/lint/unit/contracts/build checks and relevant native
   Day, workspace and hands-free/attention regressions. Retest review requests and
   team sharing in the integrated app; their existing ports/hooks were retained.
2. With an authorized Slack account, select a real joined channel in an acknowledged
   visible pane, keep review primary, and speak the fresh-mention request. Verify
   full canonical speech drains, ends exactly at the activation question, and a
   separate spoken yes activates the exact bounds. Repeat typed proposal/yes.
3. Verify no activation from wrong delivery kind, interrupted speech, a conditional
   reply, unrelated intervening turn, changed channel/account or expired proposal.
   Explicit Stop must retire pending consent without stopping independent work.
4. After confirmation, use an authorized fresh mention by another actor. Verify
   original classifier/source binding, complete fresh thread read, original-thread
   clarification only, and actual send-ledger identity/dedup. Old/edited/unmentioned
   requests, changed access, exhausted budgets, expiry and revocation must not send.
5. Restart the app and inspect real SQLite rules/children/send records. Confirm
   durable active bounds survive but ephemeral presentation consent does not.

No live providers, Slack messages, native launches or credentials are used by this
handoff. Do not mark live/native acceptance complete from these controlled tests.
