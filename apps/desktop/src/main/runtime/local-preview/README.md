# Pinned local preview bridge (MET-8 handoff)

`LocalPreviewService` is a main-only reusable bridge. It starts actual selected
committed code, independent of the source checkout. It does not create a browser,
claim display, register a foreground tool, or grant execution permission.

Composition required from integration:

1. Construct one service with an absolute app-owned storage directory, installed
   npm executable and explicitly configured localhost port. Current command is
   exactly `npm start --ignore-scripts` (prestart/poststart disabled). There is no
   dependency install, shell tool, remote fetch or arbitrary command fallback.
2. Bind `authorityId` to an actual explicit user request to execute the selected
   repository revision and this command. `authorize` must consume/revalidate that
   trusted receipt, current account, exact PR/base/head or completed-job SHA and
   source ownership, returning its local repository path. Neither model input,
   repository instructions nor a generated boolean can supply consent. A source
   lacking the selected object fails closed; integration owns authorized fetching.
3. Invoke `start({selection, authorityId}, signal)` from the foreground bridge.
   Selection includes kind, sourceId, repository and full commit SHA. No user path,
   executable or environment fields belong in the model tool schema. A second
   concurrent start rejects. Stop the prior preview before selecting another.
4. After readiness, issue the existing `open-browser` workspace command with the
   returned URL, preserving turn identity and waiting for its actual display receipt.
   Reuse the persistent native browser. Keep the separate returned selection/run
   evidence; a local URL alone is not source provenance or display proof.
5. Wire explicit cancellation/account retirement to `stop()` and app shutdown to
   `dispose()`. The passed signal stays connected after readiness; it stops the
   server as well. Manual workspace navigation need not abort that signal.
   `inspect()` returns the latest run state and bounded untrusted stdout/stderr;
   a returned readiness receipt is historical, not a perpetual liveness promise.

Implementation uses existing `runProcess`, `executionEnvironment` and
`terminateOwnedProcess`. A private bare clone with no hardlinks and detached
worktree isolates index, refs/config and dirty source bytes. Git hooks/global
configuration and lazy fetching are disabled. Child HOME/TMPDIR are private and
only an allowlisted environment is inherited, without provider credentials.
This is process/environment isolation, not an OS security sandbox: explicitly
executed repository code still runs with desktop user permissions.

Readiness requires the fixed port's listener PID to belong to the spawned npm
process group (`/usr/sbin/lsof` and `/bin/ps`, macOS target), plus successful HTTP
without redirects. An already occupied port rejects; a foreign racing listener
rejects. This is a process readiness observation, not a test suite or source-line
execution proof. PORT/HOST must be honored by the project. Self-contained scripts
work now; dependencies and submodules are not installed/copied from the source.

Stop/cancellation/failure terminate the owned process group, remove its disposable
Git tree/home and retain bounded execution JSON logs with revision, command,
timestamps, state and actual exit code (null for signal termination). Startup
failures retain logs when a run directory exists. Explicit stop is required to
release the service after a post-ready exit. Hard crashes/restart recovery are not
implemented; normal awaited shutdown is the lifecycle seam.

Controlled validation: `bun test apps/desktop/src/main/runtime/local-preview/service.test.ts`
uses real temporary Git repositories and local npm HTTP children. It checks pinned
execution despite dirty user source, missing consent/SHA rejection, secret
filtering, occupied port, cancellation before/after readiness and startup timeout.
No native app, live provider, browser display or packaged npm discovery is verified.
