# Changelog

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
