# Muse-only images — 2026-11-01

User direction replaces the initial Gemini choice. Image generation now uses `muse-image-1.0`
through the [official Meta API](https://dev.meta.ai/docs/image-generation), with the same main-only
`MODEL_API_KEY` as conversation. There is no new key, provider selector, fallback or SDK dependency.
Legacy image settings are ignored; existing saved image bytes and provenance remain readable.

The adapter posts one request to `https://api.meta.ai/v1/images/generations`, requesting one PNG
as inline base64. Response size, canonical encoding, PNG structure/checksums, dimensions and private
storage remain validated. Cancellation aborts both transport and pending reads; cancelled or
interrupted requests cannot publish a late canvas or silently replay generation.

Actual validation:

- 82 focused tests pass across 13 files, including the adapter, image tools, contracts, renderer
  images and configuration. Type-check, lint and build pass.
- All four native Electron image phases pass: generation/display after actual decode and frames;
  Recent persistence/reopen without regeneration; cancellation without a late canvas; and an
  image-specific 403 followed by ordinary conversation using the same key. External HTTP is controlled.
- One **live** Muse Image request through the actual ImageService and existing environment key
  generated a valid **1600×1600 PNG, 679220 bytes**, then verified exact private-store readback.
  It took 7235 ms in this run. This is one provider observation, not a latency guarantee. The prompt
  requested a blue circle on white and sent no repository/private source. Temporary image files
  were removed after verification; no credential or image bytes are committed.

[Machine-readable evidence](evidence/muse-image-2026-11-01.json) separates the live provider check
from the controlled native canvas checks. This follow-up does not establish physical speech, real
GitHub posting, two-user cloud deployment, signing or updater behavior. Existing unsigned release
artifacts predate the provider change and must be rebuilt before distribution.

Launch from the integration checkout with `bun run --filter @metahackathon/desktop preview`.
Ask Muse to generate an image; the existing model key is sufficient. No `.env` changes are needed
for this correction.
