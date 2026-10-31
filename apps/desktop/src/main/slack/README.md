# Slack provider lane (MET-66)

Main-only real Slack adapters, exported from `index.ts`, using the shared `chat.ts` DTOs.
There is no startup content, renderer, environment access, credential store, loopback listener,
model/classifier, commitment state machine, native app launch or installed SuperiorSwarm dependency here.
Root composes these ports and owns live/native acceptance. All tests use controlled transports.

## Developer setup

Root must obtain a Slack app registration and read these values from the active configuration:

| Field | Purpose |
| --- | --- |
| `SLACK_OAUTH_CLIENT_ID` | Slack application client ID |
| `SLACK_APP_TOKEN` (optional) | App-level `xapp-…` token with `connections:write` for Socket Mode |

Enable PKCE in the Slack app and register **`http://localhost:43187/oauth/slack/callback`**.
Slack's current desktop PKCE flow supports localhost and user scopes without a client secret.
The OAuth service owns the loopback listener, one-time state, S256 verifier and exact callback
Host/path binding. Do not substitute the other providers' numeric loopback URLs. Root encrypts
the verified user grant, rotates refresh tokens atomically and preserves GitHub/Linear connections.
See [Using PKCE](https://docs.slack.dev/authentication/using-pkce/) and root's
[registration manifest](../../../../../docs/integration/slack-app-manifest.json).

Request **User Token Scopes**, through `user_scope`, rather than bot scopes:

```text
channels:read,channels:history,groups:read,groups:history,
im:read,im:history,mpim:read,mpim:history,users:read,chat:write
```

The code exchange selects `authed_user.access_token` with `token_type: user`. It never substitutes
the top-level bot token. Missing scopes remain missing capabilities. `slackProfile` checks `auth.test`
against the grant's workspace/user and resolves bounded `users.info` display metadata.

For Socket Mode, enable it in the app registration and subscribe under **user events** to
`message.channels`, `message.groups`, `message.im`, `message.mpim`. The app token opens the outbound
WebSocket via `apps.connections.open`; it grants no conversation history or posting authority.
Socket Mode does not need an Events HTTP Request URL/signing-secret receiver. HTTP Events ingress
is not implemented by this lane. Socket Mode is currently excluded from the public Marketplace.

Primary references: [OAuth](https://docs.slack.dev/authentication/installing-with-oauth/),
[code exchange](https://docs.slack.dev/reference/methods/oauth.v2.access/),
[rotation](https://docs.slack.dev/authentication/using-token-rotation/),
[Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/),
[app token scope](https://docs.slack.dev/reference/scopes/connections.write/).

## Visibility and source boundaries

User history scopes allow public conversations, plus private channels, DMs and group DMs the user
can access through membership. A bot token sees conversations the **bot** belongs to, not all user
DMs. Discovery uses `users.conversations` for the connected user's memberships. An explicit public
source read can use the user's wider public visibility. There is no joining conversations,
opening DMs, account-wide search, attachment/file download or native Slack clone.

Every source read rechecks `conversations.info` and bounded, complete `conversations.members`.
Private access requires the current user in that membership. Public membership snapshots describe
members, not every possible public-channel reader. Stored audiences are evidence of capture;
consumers still need fresh membership, workspace and source-revision checks for each reader.
Visibility follows returned flags, never a channel-ID prefix (private Slack Connect IDs can start C).
DM/private data stays private. Only public-channel citations are eligible for company knowledge.
The provider does not infer ownership, promises, Q&A timing or commitment completion from text.

Messages retain exact returned text, timestamps, thread and edit identity. Permalinks are `null`
because no permalink lookup was performed. Missing attachment contents remain uninspected.
`sourceMessage(source, signal)` re-reads exact message/revision/thread and current audience.
Source text, names, labels and user profile fields are untrusted evidence.

Primary references: [history access](https://docs.slack.dev/reference/methods/conversations.history/),
[memberships](https://docs.slack.dev/reference/methods/users.conversations/),
[conversation types](https://docs.slack.dev/apis/web-api/using-the-conversations-api/),
[threads](https://docs.slack.dev/reference/methods/conversations.replies/).

## Composition ports

`SlackClient({getCredential, fetch?, now?, historyIntervalMs?, replyLedger?})` uses a main-only
credential `{connectionId, accessToken, tokenKind:'user', workspaceId, userId, appId, scopes}`.
Root retains one connection identity across token rotation and changes it on account replacement.
Late responses are fenced against that identity. Public methods support cancellation and a 30s
operation limit; each HTTP request has a 15s limit, fixed HTTPS origin and a streamed 2 MiB ceiling.

Methods: `capabilities`, `listConversations`, `history`, `thread`, `audience`, `sourceMessage`, `send`.
Conversation/history/thread pages have at most 15 items. An empty page with a cursor still continues.
Membership scans stop after 50 pages/10,000 users and fail closed if incomplete. Provider scopes,
account changes, cancellation and rate limits produce fixed `SlackError` codes without provider text.

Default history/replies budget is one request per minute **per method/app/workspace**, across
channels. `historyIntervalMs` can be set explicitly for a known internal customer-built registration;
the code does not infer distribution eligibility. HTTP 429 preserves `Retry-After` and prevents
another request until that deadline. Root schedules retries; the adapter does not sleep/retry writes.
See [Slack rate policy](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/).

`SlackIntake({client, load, save, publish, now?})` requires root-owned durable callbacks:

- `load(connectionId)` returns a saved `SlackCheckpoint` or `undefined`.
- `publish({connectionId,messages,deletions},signal)` durably applies source upserts/deletes,
  idempotently and fenced against account changes. Unknown-message deletes supply source identity
  only, without invented author/text. Known deletes also supply an empty-text `ChatMessage` tombstone.
- `save(connectionId,checkpoint)` persists metadata after publication. It must not replace a newer
  connection/checkpoint. A publication replay after save failure must remain idempotent.

The checkpoint has 2,048 recent event IDs, up to 10,000 message revision/tombstone records and 128
poll streams. It contains no message bodies or tokens. Capacity fails closed, rather than silently
evicting tombstones and resurrecting stale text. Root owns retention/partition policy before limits
are reached. Event callbacks must match app/workspace and explicitly authorize the connected user;
multi-install payloads listing only another installation are skipped conservatively. No HTTP event
payload should be passed to `receive` before root verifies its Slack signature.

`poll({conversationId,threadTs?,lookbackSeconds?},signal)` makes one actual API page read. It resumes
durable cursors and frozen windows, rescans overlap for edits and reports discovered thread roots.
Root fairly schedules explicitly selected/member conversations and known/discovered threads; it
must revisit threads even when no new parent appears in channel history. Polling cannot establish
deletions, all older edits, all thread replies or complete offline coverage. Absence from a page never
creates a tombstone. This limitation is explicit in the capability/poll result.

`SlackSocketMode({client,intake,getAppToken,connect?,onState?,delay?}).run(signal)` uses a real
`apps.connections.open` handshake and native WebSocket by default. It accepts only Slack WSS URLs,
handles refresh/disconnect, limits pending envelopes to eight, bounds reconnects to five attempts
per run, and publishes socket/poll/stopped metadata. Root starts/stops it and owns polling scheduling
when it reports fallback. It acknowledges an event only after durable intake publication/checkpoint.
Slow membership/persistence can exceed Slack's short ACK window; retries deduplicate and no early
ACK claims the event was durably handled. Offline/reconnect gaps require the explicitly limited poll
rescan; there is no claim of an exhaustive event archive.

## Thread replies and delivery

`send({requestId,source,body},signal)` validates the exact original source, current revision/thread,
workspace and membership before any provider reservation. Body is at most 4,000 characters to avoid
provider truncation. It sends only `chat.postMessage` to `source.threadId ?? source.messageId`,
with broadcasting/unfurls disabled. Root owns the user's acceptance/answer-delivery policy.

Sending requires a **separate atomic durable provider ledger**, in addition to Day's outer outbox:

```ts
reserve(key, bindingDigest): Promise<
  {state:'reserved'} | {state:'uncertain'} |
  {state:'delivered', receipt: ChatReplyReceipt}
>
delivered(key, bindingDigest, receipt): Promise<void>
```

Key is `${connectionId}:${requestId}`. Binding is SHA-256 of
`JSON.stringify([ChatSourceSchema.parse(source), body])`. Store that binding verbatim. Reserve inserts
a pending marker once; an existing pending marker is uncertain, and a different binding conflicts.
Concurrent same-ID sends coalesce. `delivered` persists before returning the provider receipt.
The receipt identifies the **delivered message**, with the original root thread ID, exact body digest
and provider message timestamp. Response channel/thread/text/user must agree before delivery settles.

All failures after reservation are conservatively uncertain and never automatically resent,
including lost responses and failed receipt persistence. There is no provider exactly-once guarantee,
automatic text-based reconciliation or blind resend. Day/root may recover an already stored receipt
from the provider ledger. Drafting/ready/unknown send cannot close a commitment. A durable receipt
from the confirmed original-thread answer can do so. Test memory stores are confined to test support.
See [thread posting](https://docs.slack.dev/reference/methods/chat.postMessage/).

## Validation

Run `bun test apps/desktop/src/main/slack`, scoped Biome, and desktop/main TypeScript checks.
Tests cover user-vs-bot OAuth, rotation/profile identity, rate/cancel/size boundaries, membership loss,
account fencing, private/public flags, exact source revisions, cursor recovery, edits/deletes,
terminal tombstones, socket ACK/reconnect/fallback, thread receipt validation and durable send dedup.
These controlled tests do not prove Slack consent, real scopes/memberships, live socket/event capture,
live posting, OS credential persistence or combined-app lifecycle. Root owns those acceptance gates.
