# Foreground raster tools (MET-74)

Root supplies optional `ConversationWorkspacePorts.images`:

```ts
images: {
  generate: (input, signal) => imageService.generate(input, signal),
  cancel: (requestId) => imageService.cancel(requestId),
}
```

The actual workspace observation must include the `images` capability. The existing
ConversationWorkspaceTools then exposes `generate_raster_image({title,prompt,target?})`.
It creates its own operation request ID, passes the foreground AbortSignal, validates
the actual returned shared ImageAsset, and calls the existing workspace command path
with `{kind:"show-image",assetId,target?}`. It neither supplies model paths/data URLs
nor creates a second workspace. Completion requires the exact asset metadata on a
visible primary/secondary image canvas in the acknowledged observation. No provider
completion alone establishes displayed success. All renderer/native/persistence gates
remain root's existing WorkspaceCoordinator composition.

`show_generated_image` accepts only an actual asset ID from an observed open image
canvas. Reopen a closed image with `focus_canvas({id})` using its actual observed
Recent canvas ID; closed descriptors do not expose a fabricated provider asset ID.
Existing typed `create_visual_mock` SVG scene tools remain separate and available.
Missing credentials and generation failure never switch providers or return a fixture.

Tests use explicitly controlled image-provider ports and actual shared schema/identity
checks: `bun test apps/desktop/src/main/agent/image-tools`. The broader controller,
temporary-file, transport tests and root native author outline are documented in
`main/images/README.md`. No native app, microphone or live image-provider call was run
by this worker. Root owns final image renderer/Recent integration and acceptance.
