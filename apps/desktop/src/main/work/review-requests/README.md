# MET-8 / MET-81: named team review request

Main-only optional composition; no shared persisted job field is required.

```ts
const requests = new ReviewRequests({
  selected: async (jobId, signal) => /* fresh canonical acknowledged selected
    ready WorkReview, or null; check current account and selection */,
  publish: jobId => workJobs.publish(jobId),
  account: async signal => ({ accountKey: /* GitHub identity + epoch */, login: /* fresh /user */ }),
  provider: new GitHubReviewRequestProvider(async signal => /* current fenced token */),
}, new ReviewRequestLedger(join(userData, "review-requests")));

hubPorts.reviewRequests = {
  intent: turn => /* main ingress map lookup: exact requestId + session/turn/generation */,
  send: (intent, reviewerLogins, signal) => requests.send(intent, reviewerLogins, signal),
};
```

Import `ReviewRequests`, `ReviewRequestLedger`, `ReviewRequestIntent` from `./index`;
provider from `./github`; tool port from `../../agent/review-request-tools`.
The ingress map must be populated only for actual user turns before model navigation,
using `requestedReviewers(turn.text)` and the actually acknowledged selected job/head.
Capture `{requestId, jobId, accountKey, actor, repository, headSha, text}`. Absent,
hidden/modal, ambiguous or unselected work grants no authority. Root owns ingress
capture, selected workspace context, foreground profile tool exposure and lifecycle.
Token access must fence the captured account epoch; abort foreground requests on account
change. Keep one service/ledger instance per private profile. Do not share this directory.

Supported explicit wording: “Send this work to @alice and bob for review”,
“Send the completed job for team review to alice”, “Request review from alice”.
Full utterance matching rejects quotes, conditions, negation and how-to requests.
Model arguments are only `{jobId, reviewerLogins}`. The service repeats the exact
recipient check and rejects self, unknown/read-only collaborators, failed/missing checks,
open decisions, changed selection/account/head and mismatched author/publication.

Existing `publish_work` remains draft-only. Send uses existing publication, re-reads its
canonical job, verifies the actual GitHub PR, makes a draft ready through GraphQL, then
requests named reviewers through REST (which notifies them). No merge, permission grant,
acceptance, Team cache share or Linear completion occurs. A successful receipt includes
PR URL/number, exact head, reviewers, timestamp, operation identity and evidence type.

The exclusive-create, fsynced private ledger is admitted before publication. Crash,
transport failure or cancellation retains publishing/readying/requesting phases. They
are never automatically retried. A repeat freshly reads remote state and can reconcile
only an open non-draft exact-head PR with every named reviewer actually requested.
Completed receipts remain durable even after GitHub removes a reviewer who submitted
review; such a repeat currently fails closed rather than sending a new notification.
A fresh user request for a different recipient set has a separate operation identity.

Validation uses controlled fetch responses through the production GitHub provider and
real private ledger files; no real provider writes or native launches. Live wiring and
recipient access remain root acceptance tasks. The only current live collaborator is
not permission to grant access or invent a recipient.
