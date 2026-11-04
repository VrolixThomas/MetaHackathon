# Changelog

## v0.1.3 (2026-11-04)

### What's New

Keep listening and discussing work while browsing files, tickets and pull requests. MuseFocus now opens uniquely identified discussion targets, presents implementation changes in a dedicated review view, and can launch an explicitly requested local preview of a pinned revision. Bounded standing Slack clarification rules and named GitHub review requests extend the follow-up workflow with explicit consent and durable delivery records.

### Changes

- Preserve grounded replies during manual browsing; fence stale navigation, handle spoken Stop quietly, and add Command/Control-period to interrupt a reply (MET-8; `0db0a65`, `0c62865`, `d19f8fa`).
- Open observed ticket/PR discussion targets and streamline receipt-backed file navigation and grounded explanations (MET-8/MET-51; `01f4715`, `8944883`, `a34e175`, `5804138`).
- Add implementation review navigation, loading skeletons, j/k diff navigation, readable planning briefs and explanations from actual selected diffs (MET-8; `34966e6`, `3881487`, `cfe6cda`, `45cd2c8`).
- Compose explicitly requested pinned local previews, private fixes for incoming review comments, exact reviewed-fix sharing and bounded complete-source approval policies (MET-8; `0aef7c6`, `9b303bf`, `ccc0069`, `7dcfd5a`, `c89b580`).
- Add named GitHub reviewer requests and source-bound standing Slack clarification with atomic budgets, revocation, expiry and genuine voice consent gates (MET-8/MET-76; `9b6f812`, `406d9ca`, `4963a7e`, `a33b651`, `ad05c11`).
- Bootstrap pinned worker dependencies on coding/resume, retain ignored build output, fairly pace Slack reads and normalize shared proposal timestamps (MET-8; `ce359c7`, `a35f4cd`, `a59521c`, `a0894e2`).

- Keep open review dialogs visible when the primary workspace switches away from code; hide toolbar buttons without hiding their dialogs (MET-8; `eb379dc`).

### Validation limits

This release targets macOS Apple Silicon. Controlled native tests and recorded development timing samples do not prove live provider consent, physical microphone/speaker behavior, a general end-to-end latency improvement or installed-app update compatibility. Local previews require a compatible self-contained npm start command; dependencies are not installed by the preview bridge. Provider credentials and OAuth registrations remain user-supplied.

## v0.1.2 (2026-11-02)

### What's New

MuseFocus keeps interrupted conversation context available for follow-up questions and requires clear scope before starting background work. Conversation requests now focus on the relevant tools and current workspace context. New API coding jobs use Wonder/high, while existing jobs retain their recorded model and provider choices.

### Changes

- Preserve interrupted user utterances and published assistant context, retire empty capture attempts, and require source-bound user intent before admitting coding work (MET-8; `e0e4705`).
- Reuse request snapshots, reduce schema overhead, and select focused context/tool families with explicit capability expansion (MET-51; `7e67ea1`, `474e740`).
- Persist exact model/provider choices across coding admissions, checkpoints, PR fixes and team proposal work; preserve historical job behavior and reject conflicting pins (MET-8; `2cf1520`, `3699c18`, `80aa5fb`).
- Integrate native conversation and coding-routing acceptance from [PR #5](https://github.com/VrolixThomas/MetaHackathon/pull/5) (`0491939`, `5fb0bbc`).

- Give the two multi-step Git publication regressions a bounded 30-second timeout on slower hosts; retain every existing assertion (MET-8).

### Validation limits

Request-footprint and controlled native results do not establish a measured live speech speedup, physical microphone behavior, or live Wonder/subscription entitlement. This release targets macOS Apple Silicon.

## v0.1.1 (2026-11-02)

### What's New

The first published MuseFocus release brings a voice-first workspace for reviewing pull requests, following GitHub and Linear work, and managing Slack commitments. Review code alongside a persistent browser, keep local coding jobs separate from your own checkout, and inspect proposed fixes before publishing. This release includes the Pull forward desktop identity and website download discovery.

### Changes

- Ship the integrated MuseFocus desktop for macOS Apple Silicon with Developer ID signing, notarization, a bundled voice runtime, and macOS updater metadata (MET-40; `2b53f7e`, `d286e2d`).
- Prepare reviews on the desktop with optional team sharing; keep private progress local (MET-72; `c770dc8`).
- Add conditional PR approval delegations and original-thread Slack clarification with source-bound permissions and durable delivery tracking (MET-75/MET-76; #3, #4; `71e94ef`, `ade02c5`, `23077db`).
- Apply the final MuseFocus identity and add website discovery of published GitHub downloads (MET-9; `981e3fc`, `7c895da`, `946437b`).

- Align the empty-startup conversation acceptance harness with the integrated Slack clarification and PR delegation tools (MET-8; `ea6dcb4`).

### Availability and validation limits

- Apple Silicon macOS only. No Intel, Windows, or Linux installer is included.
- Provider credentials and optional OAuth registrations are user-supplied; no credentials are bundled.
- Controlled native acceptance covers application behavior; it does not establish live provider consent or physical microphone/speaker behavior.
- This first published version cannot establish an upgrade between two published signed versions.
