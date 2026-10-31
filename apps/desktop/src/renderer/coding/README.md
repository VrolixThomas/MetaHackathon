# Background coding provider settings

Root mounts the reusable card inside Settings / the existing Configuration view:

```tsx
import { CodingProviderCard } from "../coding";
<CodingProviderCard call={api.call} />
```

Use the stable existing `ConversationApi["call"]` function. The card creates its
controller, reads status on mount, polls every five seconds while mounted, and
retires local work/timers on unmount or a changed call identity. It performs no
calls during SSR. Stop/start supports React effect cleanup/remount. No App,
ConversationApp, env, main service/router, shared contract or dependency edit is
included in this bounded handoff.

Root must implement these exact routes with the shared coding-provider schemas:

| Route | Kind | Input | Output |
| --- | --- | --- | --- |
| `codingProvider.status` | query | `{}` | `CodingProviderStatus` |
| `codingProvider.configure` | mutation | `CodingProviderSettings` | `CodingProviderStatus` |
| `codingProvider.openLogin` | mutation | `{}` | void |
| `codingProvider.refresh` | mutation | `{}` | `CodingProviderStatus` |

Configure must return the exact saved provider/path. Main also needs to validate
an explicit executable path as absolute, apply safe CLI discovery/launch rules,
bound probes, and return only contract metadata plus fixed error codes. The UI
validates POSIX absolute paths, blocks control characters/relative paths, and
sends null for a blank Auto path. Configuration never installs helpers, edits
global CLI setup or executes a model turn.

Provider radios/path are unsaved drafts until **Save coding provider**. Polling
never overwrites unsaved text. A save response cannot replace edits made after it
started; it updates the actual saved-provider status separately. Read generations
prevent an older poll from overwriting a later save. Mismatched save responses,
schema failures or timeouts invalidate readiness and show fixed local text.
No backend exception/frame is displayed.

Saving an unavailable Muse Code choice is allowed so the user can select it,
then sign in. **Open Muse Code sign-in** requires a found, supported CLI at the
saved path with no unsaved settings. It only requests the root-owned official
Terminal/vendor flow. A launch acknowledgement never proves authentication or
subscription readiness; the user completes the vendor browser flow and a new
status observation establishes the result. There are no credential/key inputs,
credential copying, browser automation or install controls.

Readiness is conservative: Muse Code requires main ready + CLI ready, installed,
account authentication, subscription billing and no error code. API-key override,
unknown account/billing, quota block and unsupported/missing CLI never become a
subscription-ready display, even with an inconsistent top-level flag. Explicit
Meta API selection requires its configured-key flag and main ready; CLI status
does not silently switch that choice. Version accepts a plain public semver;
unrecognized version/plan labels are shown as Unknown / Not reported. Fixed error
code messages cover all supported CLI errors.

The card says new jobs use the latest saved selection, existing jobs keep their
pinned provider, and foreground/API/ElevenLabs voice remain separate. Root owns
those actual admission/checkpoint/availability rules and must never silently
fallback from Muse Code to API billing. The card makes no account, quota, billing,
installation or cloud-sharing claims beyond the supplied validated status.

For custom composition/tests, exports also include `CodingProviderForm`,
`createCodingProviderController(call, options?)`, controller/state/clock types.
Controller methods are `start/stop/reset/dispose`, `observe` (status query),
`refresh`, `setProvider/setMusePath/save`, `canOpenLogin/openLogin`. A bounded
20-second local deadline retires waits; `stop/reset/dispose` fence pending results.
Local cancellation does not undo a main-process settings mutation or close an
already opened official sign-in flow. Main still owns actual cancellation,
serialization, credential generation and probe cleanup. No mutation is retried
automatically. After an uncertain save, refresh the actual applied state.

Controlled tests inject a manual clock and fake IPC; they never start live probes,
timers, model turns, providers, UI browsers, native apps or microphone access.
Run `bun test apps/desktop/src/renderer/coding`. Root alone verifies the real
local CLI/account, Settings mount, official sign-in opening and background-job
provider routing. Tests using 1.4.13 and a plan label are test data, not live
evidence about the installed account.
