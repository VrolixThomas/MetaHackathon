# Private raster images (MET-74)

The real implementation uses the [official Gemini image generation REST API](https://ai.google.dev/gemini-api/docs/generate-content/image-generation)
at the fixed `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash-image:generateContent`
endpoint. The documented request sends `contents.parts.text`, an `x-goog-api-key`
header and image response modalities; successful image parts carry MIME/base64
`inlineData`. This adapter uses no SDK, external image download, search grounding,
Meta-key assumption, automatic provider fallback or product fixture.

Root composition API:

```ts
const images = new ImageService(
  createGeminiImageProvider(mainOnlyActiveEnvironment),
  new PrivateImageStore(join(userData, "workspace", "images"))
);
images.generate(sharedGenerateImageInput, foregroundSignal); // Promise<ImageAsset>
images.read(assetId, signal); // Promise<ImageReadResult> with bounded local data URL
images.cancel(requestId); // tombstone also wins before registration
images.dispose(); // lifecycle/configuration change; abort outstanding generation
```

Explicit main-only configuration is `IMAGE_PROVIDER=gemini` and `GEMINI_API_KEY`.
Never pass the environment or key to renderer, model contexts or diagnostics. Missing
configuration raises fixed `image-not-configured` without calling a provider; it does
not disable other conversation/workspace tools. Reading saved assets needs no key.
No credentials were read, added or modified during implementation.

Limits: prompt 12,000 characters; request shape is text only; one fixed-model image;
90-second transport timeout; 18 MiB streamed JSON response; 12 MiB PNG/JPEG asset;
4096 maximum width/height; two concurrent generations and 256 retained request records.
PNG checks include chunk CRC, bounded decompression, complete scanlines and filter
bytes (noninterlaced only); JPEG checks include supported frame, dimensions and scan
markers. Actual browser `img.decode()` remains mandatory before display acceptance.
Unsupported, refused, text-only, remote-file, oversized or malformed results fail.

Private storage uses a 0700 app-owned directory, 0600 files, opaque request-derived
IDs, atomic binary/record replacement and SHA-256. Pending requests are admitted before
provider execution. Completed requests reopen their exact bytes; interrupted/failed
requests never automatically replay provider work. Same-ID/different-content conflicts
reject. Reads use bounded no-follow file descriptors and recheck MIME, dimensions,
digest and size. Paths and prompts are not returned to the renderer/model. Cancellation
aborts transport, rejects late results and cannot publish a later workspace effect.

Renderer exports `ImageCanvas({asset, read, onReady?})`, `loadImageAsset` and
`waitForImagePresentation` from `renderer/images`. Root supplies a stable authenticated
`read(id,signal)` IPC adapter returning shared `ImageReadResult`. The loader checks
exact metadata, MIME/base64, bytes and SHA. The actual DOM image must decode at the
exact natural dimensions and survive two visible animation frames. Only then are
`data-image-asset-id`, `data-image-sha256`, `data-image-ready="true"` emitted and
`onReady(asset,true)` called. Root's existing canvas gate must wait for readiness and
its own matching committed frames/native presentation; loading/error markup is not
display proof. Root owns image canvas/command schemas, persisted Recent descriptors,
RPC registration, services/lifecycle and final bindings.

Validation: `bun test apps/desktop/src/main/images apps/desktop/src/renderer/images`
passes controlled provider/decoder/controller and real temporary-file tests. These
are explicitly simulated transports, not a live provider call or native decode proof.

Root native author outline (root alone runs): inject controlled inline PNG and JPEG
provider responses through actual IPC; ask typed/voice conversation to generate;
verify exact metadata and decoded natural dimensions in the primary/secondary pane,
two-frame receipt, closed canvas reopening through Recent and binary bytes across
store reopen. Reject bad digest, invalid decoder bytes, wrong natural dimensions,
remote URL, missing key, oversized stream and unsupported MIME. Cancel during provider
read and during decode: no late positive canvas receipt. Keep existing SVG mock tools
working and verify an image-only configuration error leaves ordinary conversation
available. Separately configure a user-provided Gemini key for an explicitly authorized
live generation; no live generation, native Electron, microphone or deployment check
was run by this bounded implementation worker.
