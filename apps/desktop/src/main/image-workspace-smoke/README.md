# Root-only raster workspace native acceptance

After integrating and building root's complete image composition, root alone runs:

```sh
env -u ELECTRON_RUN_AS_NODE electron src/main/image-workspace-smoke.cjs
```

Run from `apps/desktop`; optionally supply an explicit built main path. Reports and
success/failure screenshots are written under `apps/desktop/out/image-workspace-smoke*`.
The harness owns and removes an isolated temporary user-data directory and a dummy
0600 environment file. It never opens the repository environment. Ambient provider
credentials are cleared in the test process; Chromium permissions and remote network
are denied. Real fixed-endpoint Muse Image/model fetches use the same dummy MODEL_API_KEY and map to an owned loopback
HTTP server. No product service, app result or receipt is fabricated.

The actual default App receives typed user input and uses the real foreground model
tool loop, ImageService, Muse Image request parser, private PNG store, IPC and Chromium
image decoding. The controlled HTTP response contains a real 2×2 RGB PNG with checked
CRC and compressed pixels. Acceptance checks exact SHA/bytes, natural dimensions,
two actual visible animation frames and the genuine matching workspace receipt;
persisted private files and Recent close/reopen without another generation; a held
HTTP response cancelled through the real foreground RPC with no late canvas; and
an image-specific provider denial followed by successful ordinary conversation using the same key. Missing
MODEL_API_KEY is covered by adapter tests and prevents new model requests, including conversation. The harness does not
establish live-provider generation, microphone/speaker behavior or full process restart.
Private file reopen and Recent restoration occur within the actual app process.

Author-safe validation (no Electron, HTTP listener or network is started):

```sh
node --check apps/desktop/src/main/image-workspace-smoke.cjs
node --check apps/desktop/src/main/image-workspace-smoke/support.cjs
node apps/desktop/src/main/image-workspace-smoke.cjs --self-check
```

Only root execution can establish native acceptance. If root changes composition
schema/selectors, adapt this isolated harness rather than stubbing a product path.
