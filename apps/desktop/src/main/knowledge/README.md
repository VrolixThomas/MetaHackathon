# MET-69 main-only knowledge seam

This module owns internal input types, authorization policy and a source-backed
service. Public DTOs use the canonical shared `chat.ts`/`knowledge.ts` schemas from
root bootstrap `689f66ab34d9a64a9c18953ab2dc4b951a669758`. Root owns shared contracts,
SQLite migrations/adapter and all app bindings.
There is no default store, model, embedding service, connector or product fixture.

The composition layer supplies authenticated actors (never model-selected user,
workspace or agent identities). It also supplies connector-verified source snapshots.
`applySource` is a connector-only entry point, never an agent/renderer tool. Slack
public/private/DM identities and audiences come from the actual provider, not text.
Private notes require actual owner authority. An incomplete/unknown ACL fails closed.

The authorization port resolves only requested identities and source references on
every operation. It must check current workspace membership, agent ownership, source
revision/state and actual source audience. Its synchronous final fence covers account
changes, membership/owner changes and source deletion/ACL changes. The transaction
adapter must commit in that same synchronous turn. Neither a cached source row nor a
persisted admission grants future access. Provider availability/uncertainty denies.
Each current source grant includes `readableUserIds` for requested users and the
current owners of requested agents. Even public Slack visibility plus workspace
membership is insufficient without that actual read check (for example, guests).

Company facts require exclusively public Slack sources. Private facts belong to one
current owner and remain restricted by every source. Source references include exact
revision and attribution remains in source records. Recorded facts quote exact source
text; interpretation is explicitly inferred. Parent facts and supersession/contradiction
edges add all their source dependencies. Facts are immutable; contradictory evidence
coexists. Supersession is an explicit edge, never an automatic rewrite or truth claim.
Stored facts remain immutable. Reverse relationships project supersession/contradiction
only after their complete source dependencies pass current authorization. An unreadable
successor cannot leak its identity or suppress an otherwise readable predecessor.

Search returns only authorized literal substring matches from at most 50 candidates,
with at most 256 related facts. It exposes no inaccessible totals. A dependency closure
is limited to 30 distinct sources; conflicting revisions fail closed. Source edits hide
old-revision descendants, rather than silently updating their text. Source tombstones
clear source payloads and fence descendant reads; retained fact/message audit rows do
not become readable after deletion. Deleted source IDs cannot be resurrected. There
is no semantic/vector search or unbounded pagination/ranking.
Direct messages require current sender/recipient ownership and membership and permission
for both owners on every source and parent fact. Message and admission audit commit
atomically. Rejected attempts record fixed reasons and a digest, not private body text.
Bodies are always untrusted evidence; this module never executes them or delegates tool
authority. Integration must expose them as evidence, never as system/developer prompts.

Composition entry points:

- `new KnowledgeService({ store, authorization, now?, id? })` has no storage fallback.
- `sourceFromChatMessage(message, sequence)` preserves exact connector-supplied identity,
  revision, text, attribution and captured audience. It rejects truncated/empty active
  text and unknown private audiences. `chatSourceId` derives a stable workspace-bound
  local key from the complete provider message identity. Neither helper grants access.
- `applySource(source)` admits independently verified connector snapshots/tombstones.
- `recordFact(actor, input)` stores an immutable fact, exact recorded text or explicit
  inference, and the restrictive dependency closure. `title` is presentation metadata.
- `searchExact(actor, { scope, text, limit? })` returns attributed internal views with
  currently visible reverse edges. `searchSharedExact` projects canonical public DTOs
  inside the same final authorization fence. Private notes and uncited internal sources
  remain local-only; public projection rejects rather than fabricating Slack citations.
- `admitDirectMessage(actor, input)` records a fixed admission result and audit. Stable
  sender/request identity deduplicates accepted messages; changed payloads or owners
  cannot reuse an old receipt. `readInbox` and `readSharedInbox` revalidate access again.
  Shared communications stay `queued` with `deliveredAt: null`; actual recipient delivery
  receipt handling is future integration work, never implied by admission or inbox read.

`KnowledgeTransaction.getRelatedFactIds` is a complete workspace-bound reverse-edge
lookup; throw on more than 256 entries in either set, never silently truncate it. All
query/lookup return values must be detached JSON records. Source heads, immutable fact
edges, accepted message uniqueness and append-only admission audits must commit durably
under the supplied SQLite transaction. A failed audit write rolls back the message.

Run `bun test apps/desktop/src/main/knowledge` for controlled unit tests. Test doubles
live only in `tests/harness.ts`, are not exported by `index.ts`, and establish no actual
provider, SQLite-reconnect, native-app or live authorization verification.

All submitted provenance must be complete: policy enforces the supplied dependency
closure, but cannot detect an omitted dependency or prove an inferred sentence true.
Trusted generation/ingestion must retain lineage rather than allowing a model to erase
it. This service provides no permission to send an external Slack/provider message.
