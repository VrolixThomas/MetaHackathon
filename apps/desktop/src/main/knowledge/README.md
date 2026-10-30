# MET-69 main-only knowledge seam

This module owns provisional input types, authorization policy and a source-backed
service. Root owns shared contracts, SQLite migrations/adapter and all app bindings.
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

Company facts require exclusively public Slack sources. Private facts belong to one
current owner and remain restricted by every source. Source references include exact
revision and attribution remains in source records. Recorded facts quote exact source
text; interpretation is explicitly inferred. Parent facts and supersession/contradiction
edges add all their source dependencies. Facts are immutable; contradictory evidence
coexists. Supersession is an explicit edge, never an automatic rewrite or truth claim.

Search is bounded literal substring matching after access checks. No semantic/vector
search is claimed. Pagination/ranking and shared IPC output schemas remain root work.
Direct messages require current sender/recipient ownership and membership and permission
for both owners on every source and parent fact. Message and admission audit commit
atomically. Rejected attempts record fixed reasons and a digest, not private body text.
Bodies are always untrusted evidence; this module never executes them or delegates tool
authority. Integration must expose them as evidence, never as system/developer prompts.

All submitted provenance must be complete: policy enforces the supplied dependency
closure, but cannot detect an omitted dependency or prove an inferred sentence true.
Trusted generation/ingestion must retain lineage rather than allowing a model to erase
it. This service provides no permission to send an external Slack/provider message.
