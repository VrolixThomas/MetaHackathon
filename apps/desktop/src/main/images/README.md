# Private raster images (MET-74)

The implementation uses the [official Muse Image REST API](https://dev.meta.ai/docs/image-generation)
(One-off generation, Useful parameters and Response shape) at the fixed
`POST https://api.meta.ai/v1/images/generations` endpoint. The exact JSON request is
`{model:"muse-image-1.0",prompt,n:1,response_format:"b64_json",output_format:"png"}`
with `Authorization: Bearer <MODEL_API_KEY>` and `Content-Type: application/json`.
The response must contain exactly one `data:[{b64_json}]` entry and echo
`output_format:"png"`. Generation metadata is provider `meta`, model `muse-image-1.0`.
This adapter uses no SDK, arbitrary image download, redirect, alternate key/provider,
automatic fallback or product fixture.

Root composition API:

```ts
const images = new ImageService(
  createMuseImageProvider(mainOnlyActiveEnvironment),
  new PrivateImageStore(join(userData, "workspace", "images"))
);
images.generate(sharedGenerateImageInput, foregroundSignal); // Promise<ImageAsset>
images.read(assetId, signal); // Promise<ImageReadResult> with bounded local data URL
images.cancel(requestId); // tombstone also wins before registration
images.dispose(); // lifecycle/configuration change; abort outstanding generation
```

The existing main-only `MODEL_API_KEY` alone enables image generation. Legacy
`IMAGE_PROVIDER` and `GEMINI_API_KEY` are ignored, including when no model key exists.
Never pass the environment or key to renderer, model contexts or diagnostics. Missing
configuration raises fixed `image-not-configured` without calling a provider; it does
not disable other conversation/workspace tools. Reading saved assets needs no key.
The public index exports `createMuseImageProvider`, `MUSE_IMAGE_MODEL`, `ImageProvider`,
`ImageError`, `ImageService` and `PrivateImageStore`.

Limits: prompt 12,000 characters; request shape is text only; one fixed-model image;
90-second transport timeout; 18 MiB streamed JSON response; 16 MiB canonical base64;
12 MiB generated PNG asset (existing saved PNG/JPEG assets remain readable);
4096 maximum width/height; two concurrent generations and 256 retained request records.
PNG checks include chunk CRC, bounded decompression, complete scanlines and filter
bytes (noninterlaced only); JPEG checks include supported frame, dimensions and scan
markers. Actual browser `img.decode()` remains mandatory before display acceptance.
Strict UTF-8/JSON, response shape, canonical base64 and actual PNG bytes are validated.
Unsupported, refused, URL-only, multiple-image, format-mismatched, truncated, oversized
or malformed results fail. HTTP/provider errors expose fixed messages only.

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

Validation: `bun test apps/desktop/src/main/images` exercises the exact official
request/headers, MODEL_API_KEY-only enablement, ignored legacy configuration,
invalid/URL-only/multiple/format-mismatched/oversized/truncated responses and
transport/read/service cancellation. Temporary-file checks cover private permissions,
persistence/reopen, deduplication, legacy asset reads and tampering. Scoped lint:
`bunx --no-install biome check apps/desktop/src/main/images`.
These are controlled transports, not live provider calls or native decode proof.

Root owns configuration/services composition, all builds, native smoke and live
acceptance. Its controlled native check should inject official `data:[{b64_json}]`
with `output_format:"png"` through actual HTTP/IPC, verify exact generated metadata,
decoded dimensions, two-frame receipts, Recent close/reopen and private-store reads,
then check cancellation and missing MODEL_API_KEY without disabling conversation.
Separately authorized live success requires the user-provided MODEL_API_KEY. This
bounded worker reads no live keys and runs no build, native Electron, live provider,
microphone or deployment check. Existing saved assets retain their original provider
and model attribution; a provider change does not rewrite bytes or metadata, and a
conflicting request ID never silently regenerates an old asset.
