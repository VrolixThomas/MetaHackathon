# MET-8 standing Slack clarification wiring

These new modules are deliberately unregistered. Root still owns services, hub tools,
foreground selection, ingress/publication plumbing, contracts and DayStore. No Slack sender,
model call, native app launch or dependency change is included.

## Durable controller and Day admission

The existing APIs are `DayStore.standingTransaction`, `StandingClarification`,
`DayPorts.standing`, `DayPorts.classifyStandingIncoming`, `DayPorts.readStandingAccess`,
`getSlackWorkspace().client`, and `DayReplyPort.readClarification`.
Create the controller against the existing store (do not substitute memory in production):

```ts
const standing = new StandingClarification({
  transaction: (mutate) => stores.day.standingTransaction(mutate),
});
const incoming = new StandingIncomingBindings();
const readStandingAccess = (channelId: string, signal: AbortSignal) =>
  readStandingSlackAccess(getSlackWorkspace().client, channelId, signal);
```

In the existing `services.ts` `classify` callback, capture the selected credential **before**
`classifyDayMessage` and retain the original validated result **before** reducing it to the
current `{kind,title,summary,...}` return. Do not reconstruct a classification from that summary.

```ts
const client = getSlackWorkspace().client;
const credential = await client.credential(signal);
if (credential.workspaceId !== actor.workspaceId || credential.userId !== actor.userId)
  throw new Error("Slack account changed");
const result = await classifyDayMessage(
  conversationClient, { actor, message, repositories }, signal
);
await client.assertCurrent(credential, signal);
signal.throwIfAborted();
if (!result) return null;
incoming.retain(actor, credential.connectionId, message, result);
// Continue the existing own-promise handling and metadata return unchanged.
```

In `initializeDay`'s existing `new DayService({...})`, add these ports, retaining its actual
`replies` adapter (including complete fresh thread reads):

```ts
standing,
readStandingAccess,
classifyStandingIncoming: async (message, signal) => {
  const access = await readStandingAccess(message.citation.source.conversationId, signal);
  if (access.actor.workspaceId !== currentActor.workspaceId ||
      access.actor.userId !== currentActor.userId) throw new Error("Slack account changed");
  return incoming.take(currentActor, access.connectionId, message);
},
```

The retention helper requires the original bound classifier result, a literal mention of the
selected user, another author, unchanged source/body and a message no older than 30 seconds.
Bindings expire after 30 seconds, are consumed once, and are capped at 128. This deliberately
misses slow/offline requests rather than replaying history. Do not call it from backlog scans,
manual captures, restored source caches or model tools. Clear it at account/connection changes.
DayService additionally admits only messages created after parent confirmation, freshly rereads
the thread, atomically reserves parent budgets and installs an explicit standing child.
`confirmedAt` on that child stays **null**. Existing DayService revalidates parent authority at
send boundaries; do not fabricate per-thread confirmation times or call thread confirmation.

## Actual user ingress and model tools

Create one `StandingClarificationConversation` per authenticated foreground conversation session,
using the shared durable controller. Dispose it on session/account/connection retirement. Pending
presentation receipts are intentionally ephemeral and cannot be restored as authority.

```ts
const rules = new StandingClarificationConversation({
  controller: standing,
  readAccess: readStandingAccess,
  publish: publishStandingProposal, // root adapter described below; not present in this base
});
```

At actual user admission (before the model), bind the authenticated actor/connection and the
channel the human explicitly selected. Do not obtain these from tool arguments or infer a channel
from provider text. If selection is ambiguous, ask the user first. The label is a root-owned
presentation label, not authority. The following `actualUserTurn` and `selectedChannel` are root
bindings, not newly existing APIs:

```ts
const ingress = rules.userIngress({
  sessionId: actualUserTurn.sessionId,
  turnId: actualUserTurn.turnId,
  requestId: actualUserTurn.requestId,
  text: actualUserTurn.text,
  inputMode: actualUserTurn.inputMode, // app ingress, never model supplied
  actor: selectedActor,
  connectionId: selectedConnectionId,
  channelId: selectedChannel.id,
  channelLabel: selectedChannel.label,
});
const standingTools = new StandingClarificationTools(rules, ingress, turnSignal);
```

Register `standingClarificationToolDefinitions` beside the existing Day definitions in
`hub-tools.ts`, and dispatch before the generic unknown-tool branch:

```ts
if (isStandingClarificationTool(name))
  return standingTools.execute(name, rawArguments);
```

The adapter exposes propose/list/confirm/revoke only. Never expose `userIngress`, controller
`confirm`, the publication callback or retained classifier bindings through tools/RPC. Wire every
actual user turn through ingress, including unrelated or negative replies, so old proposals cannot
be revived by a later bare yes. Never mint ingress from assistant/source/provider history or an
attention turn. Pass the *same opaque ingress* when rebuilding tools for the same turn; duplicate
turn/request registrations reject. Ingress expires after 30 seconds; ask again if access/publishing
is too slow. Root must retain normal cancellation and account-epoch fences around its lifecycle.

The conservative request grammar currently accepts “Propose a clarification rule …”, “Draft a
clarification rule …”, and “Set up a clarification rule …”. Bounds are 5–30 minutes, 1–5 threads,
1–3 messages per thread, and 1–10 total messages. Scope and all bounds appear verbatim in the
canonical proposal. Defaults chosen by the model remain proposals only. Confirmation accepts a
whole typed reply such as “Yes”, “Activate this rule”, or “I confirm this rule”. Negative, conditional,
quoted and extra-clause responses invalidate the pending proposal. A receipt expires after five
minutes. The list is scoped to the selected account/connection/channel and reports expired active
records as expired. Revocation requires a list in the same turn plus “Revoke this rule” when exactly
one rule exists, or the explicit typed command `revoke rule <observed-id>` for multiple rules.
A future root-owned selector can improve that multi-rule UX without granting model consent.

In `foreground-profile.ts`, keep standing proposal/list/revoke requests and a pending proposal's
next actual user confirmation in the tools-capable path. Do not route a bare confirmation to the
existing per-thread Day confirmation heuristic. These helper tools do not update shared contracts.

## Publication is a required root dependency

`publishStandingProposal` must publish `proposal.text` as the exact assistant conversation message
and resolve **after actual text publication**, returning this exact receipt:

```ts
return {
  kind: "text-published",
  proposalId: proposal.id,
  policyDigest: proposal.policyDigest,
  text: proposal.text,
  sessionId: proposal.sessionId,
  turnId: proposal.turnId,
  requestId: proposal.requestId,
} satisfies StandingPublicationReceipt;
```

The callback receives an AbortSignal. Root must reject on cancellation, failed publication, stale
session/generation or account change. It must use the real conversation publication path, not simply
return the object above. Publish directly while the helper awaits the callback; do not wait for the
same tool call to return before publishing (that deadlocks). End that assistant turn with the
canonical question; do not append a model paraphrase or a different confirmation question.
`StandingProposal` is a main-only typed DTO, not a claim that the current renderer already supports
it. A renderer receipt contract or a main-owned publication callback still needs root implementation.
Until that exists, omit the tools or make the callback reject. Returning JSON in model context is
not publication. Tests use controlled receipts and establish no UI visibility.

Voice proposal returns `presentation: "unpublished", confirmation: "voice-unavailable"`; voice
confirmation always rejects, even after text publication. Do not silently convert this to a text
receipt or enable voice yes. Root must add and validate exact drained narration/playback receipts
before extending this contract. For now request a new typed proposal and typed confirmation.

## Validation and handoff

Run targeted tests with the integration node_modules symlink:

```sh
bun test apps/desktop/src/main/agent/standing-clarification-tools.test.ts apps/desktop/src/main/composition/standing-clarification.test.ts apps/desktop/src/main/day/standing-clarification.test.ts
bunx tsc --noEmit -p apps/desktop/tsconfig.main.json
bunx biome check apps/desktop/src/main/agent/standing-clarification-tools.ts apps/desktop/src/main/agent/standing-clarification-tools.test.ts apps/desktop/src/main/composition/standing-clarification.ts apps/desktop/src/main/composition/standing-clarification.test.ts
```

Tests exercise the real controller with controlled transactional/access/publication ports. They
cover exact distinct-turn consent, injection/negative/conditional replies, stale and changed
identity/channel/access/source, no voice consent, budget schemas, expiry and revoke. Existing
controller tests cover durable reservations, source freshness and child-parent revalidation.
No live Slack send, native UI, microphone, model provider or production wiring is established.
Root owns those remaining integrations and acceptance checks; do not mark the feature Done yet.
