# Manual review opening recovery

The user could see a cached ready PR but selecting it from Open repository failed with a generic
workspace error. The main checkout had a blank `.env`; the previously configured keys were in
the integration checkout. A cached plan can render in the inbox without credentials, while
opening source deliberately revalidates its current GitHub revision.

The missing configuration was repaired locally by reusing the existing app keys for the main
checkout, preserving populated values. No credential values are committed or logged. The main
checkout also reuses the existing ignored Python voice environment.

Manual show-review preparation now returns a fixed GitHub connection diagnostic before attempting
GitHub access. IPC preserves only that known diagnostic; arbitrary provider text remains hidden.
The error offers a Connect GitHub button opening Settings. After configuration, the same PR can
be selected again without restarting or rebuilding its prepared plan.

Manual workspace commands also refresh the canonical main snapshot before preparing effects.
A picker left open across source or agent changes must not submit its stale workspace sequence.
The existing source/native/durable receipt, cancellation and revision guards remain in force.

Validation:

- 695 TypeScript tests, type-check, lint and production build pass.
- Native prepared-review regression removes its isolated test GitHub credential after preparation,
  clicks the actual ready PR entry, verifies the connection error/Settings recovery, restores only
  the fake test credential and opens the same PR. Source, syntax, progress and dirty-file checks pass.
- Native workspace/browser layout and three-file walkthrough, plus V1 conversation checks pass.
- Separately, an actual native picker selection opened the user's provided duckdemo PR #2 from an
  isolated backup of the existing review database, using live read-only GitHub requests and real
  pinned local Git objects. It displayed `tests/gift-wrapping.test.mjs` with 34 source/patch rows.
  The original review database was opened read-only; GitHub writes, model and speech calls were
  blocked in that check. This does not establish live speech verification.

`bun run test:prepared-reviews` enables the missing-credential recovery check by default.
