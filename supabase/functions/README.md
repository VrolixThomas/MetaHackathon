# Generated Muse team Edge functions

Root's Bun build generates these deployment entrypoints from the existing locked repository:

- `muse-team-api/index.ts` from `services/team/edge/muse-team-api.ts`
- `muse-team-webhook/index.ts` from `services/team/edge/muse-team-webhook.ts`
- `muse-team-worker/index.ts` from `services/team/edge/muse-team-worker.ts`

Do not deploy the unbundled extensionless source graph or `services/team/entry.ts`. Generated
bundles, config.toml, build/deploy commands, secrets, scheduler migration and actual runtime
acceptance are root-owned. No generated bundle is claimed by this source handoff.

See [adapter exports, auth, runtime and background requirements](../../services/team/edge/README.md).
