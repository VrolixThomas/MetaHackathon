# Root-only Team workspace native acceptance

Root builds the complete facade/router/Settings composition, then runs from `apps/desktop`:

```sh
env -u ELECTRON_RUN_AS_NODE electron src/main/team-workspace-smoke.cjs
```

An optional final argument selects a built main file. The harness writes JSON evidence
and success/failure screenshots under `out/team-workspace-smoke*`. Only root executes
native acceptance. Author checks are syntax, scoped lint and the offline self-check:

```sh
node --check apps/desktop/src/main/team-workspace-smoke.cjs
node --check apps/desktop/src/main/team-workspace-smoke/runtime.cjs
node --check apps/desktop/src/main/team-workspace-smoke/providers.cjs
node apps/desktop/src/main/team-workspace-smoke.cjs --self-check
```

The self-check creates no app, Git repository, HTTP listener, provider or DB process.
The root-only path owns an isolated profile, dummy 0600 environment and local Git
repository; original source dirt is checked byte-for-byte before cleanup. It clears
ambient credentials in its own process, denies Chromium remote traffic/permissions,
and maps only Supabase/GitHub/team provider fetches to owned loopback HTTP. It replaces
external browser opening solely to exercise the actual TeamLogin loopback callback,
verifying its random path and real PKCE verifier/challenge. The actual TeamAuth,
TeamService, renderer, IPC, ReviewCoordinator and OS encryption remain unchanged.
No product service return value or positive receipt is injected.

The five native phases cover:

1. Actual Settings TeamCard reads active `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` and
   `MUSE_TEAM_SERVICE_URL`; startup is disconnected with no product fixture fallback.
2. UI login, real callback and encrypted session; actual organization selection and
   authorized repository scope; OS decryption verifies the persisted test session
   while public status and visible UI contain no credential values.
3. Actual `reviews.connect` to owned pinned source, shared artifact lookup through
   TeamService and root ReviewCoordinator, exact shared PreparedReview identity and
   source display with a genuine accepted workspace receipt. Any local model HTTP
   call fails; the controlled team artifact hashes the independently reconstructed
   GitHub context, preventing a permissive fixture from masking a wrong context key.
4. Settings proposal list/detail displays exact Before/Proposed after/patch/head/hash
   for two real frames. Acceptance starts disabled, wrong digest rejects in main,
   a real checkbox/button records one decision, and exact request replay deduplicates.
5. UI disconnect removes the encrypted session and retires old proposal detail.

Facade names match the team peer's real controller: query `team.status`,
`team.organizations`, `team.repositories`, `team.proposals`, `team.readProposal`;
mutation `team.login`, `team.logout`, `team.selectScope`, `team.decideProposal`.
The harness uses existing semantic button labels plus `data-team-card`,
`data-team-proposal`, `data-team-bundle-digest` and exact source-side/path/SHA markers.
The root Settings binding must pass the current repository/PR context and preserve
controller state as appropriate, so reopening Settings can browse its selected scope.

The controlled remote proposal explicitly represents another submitter's reported
local candidate; no independent execution is invented. Sharing a locally prepared
candidate and separately applying an accepted proposal remain root's real coding/fix
acceptance paths. This harness records an author decision without implicitly applying,
posting, publishing or merging. SQL RLS is exercised separately by root; native
controlled HTTP establishes neither deployed hosting, two real users, live consent,
live provider access, physical speech nor full process restart.
