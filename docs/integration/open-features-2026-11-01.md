# Open feature integration — 2026-11-01

User authorized completion of all six remaining feature areas. Source checkpoint: `42b40f2` on
main/integration. Codex-only SuperiorSwarm workers use separate finish-team, finish-foreground and
finish-release worktrees; ownership and follow-ups are recorded on MET-8. Integration alone runs
the combined/native application and owns contracts, manifests, lifecycle, router and final bindings.

| Area | Local implementation and actual checks | Remaining acceptance |
| --- | --- | --- |
| Conversational PR comments (MET-26) | Canonical composer, exact proposal, distinct explicit user turn, drained narration gate, one posting ledger. Native typed draft/edit/consent/post/cancel/stale-head checks passed with controlled provider HTTP. | Live speech and live GitHub posting require their separate user/provider check. |
| Raster canvases (MET-74) | Muse Image replaces Gemini using existing `MODEL_API_KEY`. 82 focused tests, type-check/lint/build and all four native phases pass. One real Muse Image request generated and privately round-tripped a validated 1600×1600 PNG. | No extra image key; [separate Muse evidence](muse-image-acceptance.md) distinguishes live provider and controlled canvas checks. |
| Subscription workers (MET-46) | Official CLI/SDK adapter and opt-in real-worktree question/resume/cancel harness. Existing controlled checks pass. | Root live harness stopped at actual CLI sign-in-required before any coding session/model call. |
| macOS release (MET-40/28) | Current frozen voice payload: arm64, 314308953 bytes, 274 Mach-O. Actual unsigned production DMG/ZIP and payload check passed; SQLite uses embedded DDL. | No Developer ID identity or Apple notarization credentials; signing/update acceptance pending. |
| Shared review cache/hosted preparation (MET-72/41) | Supabase RLS, PKCE/encrypted cache, org/repository onboarding and executable GitHub App webhook/leased consumer integrated. Actual native Team UI/IPC reuses the shared plan without local model preparation. Isolated PostgreSQL policy/lease tests passed. | Selected cloud project, secrets, hosting and two-real-user deployment acceptance. |
| Shared fix proposals (MET-73) | Exact highlighted before/after, patch, source/check identity, sharing, author decision and explicit isolated application integrated. Thirteen real Git apply tests and native apply/check/Completed-review flow passed; original work preserved. | Two-real-user exchange against the deployed backend. |

Backend review fixes landed for source-sensitive RPC authorization, late account-generation fencing,
progress conflicts and retry behavior. Actual PostgreSQL security and controlled/native checks pass.
Sharing, author acceptance, local application, review, publication and merge remain distinct.

Native HTTP/model inputs are controlled test data; the separate Muse Image provider check is live.
No product fixture fallback, hosted deployment, live subscription coding or Developer ID/notarization
success is claimed.
The implementation and final evidence are recorded in [all-features-acceptance.md](all-features-acceptance.md).
