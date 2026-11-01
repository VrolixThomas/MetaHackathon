# Conditional PR approval (MET-75)

`index.ts` owns policy admission/revisions, durable confirmation, local awake monitoring, final evaluation and single-attempt review writes. Its Hub persistence port uses the existing SQLite adapter. `github.ts` reads official GitHub evidence and submits commit-bound APPROVE reviews with captured credential and epoch fencing. `confirmation.ts` grants conversational consent only from actual ingress after an exact visible proposal and, for voice, drained narration. Foreground tools call these same services; attention only narrates recorded notices.

Shared public DTOs are in `shared/contracts/pr-approval.ts`. Composition/lifecycle and account fencing live in `main/services.ts`; manual controls and the two-frame presentation acknowledgement are in `renderer/pr-approvals/`. Existing `approve_work` remains local-work acceptance.

Run controlled tests:

```sh
bun test apps/desktop/src/main/work/pr-approvals apps/desktop/src/main/agent/approval-tools.test.ts apps/desktop/src/shared/contracts/pr-approval.test.ts
```

See `docs/integration/pr-approval-acceptance.md` for scope, native acceptance and live limitations. Root/integration alone runs `bun run test:pr-approvals`; never label unit-controlled provider results as live approval or speech proof.
