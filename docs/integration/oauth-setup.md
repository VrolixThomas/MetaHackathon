# GitHub, Linear and Slack login (MET-53 / MET-66)

Muse owns this connection flow. SuperiorSwarm is not required at runtime, and its app credentials
are not copied. Register your own applications and add the following fields to the active `.env`.
Development worktrees on this machine use `/Users/Werk/Documents/Repositories/MetaHackathon/.env`.
Settings shows the exact path; **Configure login** opens that file.

| Provider | Registration | Exact callback URL | Required `.env` fields |
| --- | --- | --- | --- |
| GitHub | Settings → Developer settings → OAuth Apps → New OAuth App | `http://127.0.0.1:43187/oauth/github/callback` | `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` |
| Linear | Workspace settings → API → OAuth applications | `http://127.0.0.1:43187/oauth/linear/callback` | `LINEAR_OAUTH_CLIENT_ID` |
| Slack | Slack app → OAuth & Permissions → enable PKCE | `http://localhost:43187/oauth/slack/callback` | `SLACK_OAUTH_CLIENT_ID` |

For Slack, create a dedicated Muse app using [slack-app-manifest.json](slack-app-manifest.json)
at [Slack Apps](https://api.slack.com/apps). It configures the exact localhost callback, user scopes,
PKCE and token rotation. Copy the app's Client ID from Basic Information into the active `.env`.
Choose **Sign in with Slack** in Muse Settings and approve in the browser. Muse automatically follows
all active joined conversations; individual exclusions are optional. Tokens are obtained and stored
by the app; no manual user-token copy is needed.

Slack's [desktop PKCE flow](https://docs.slack.dev/authentication/using-pkce/) supports `localhost`
redirects and user scopes without a client secret. The callback is deliberately `localhost`, while
GitHub/Linear retain `127.0.0.1`. No hosted HTTPS relay is required for this flow. Slack desktop
redirects cannot request bot scopes; optional Socket Mode app tokens remain a separate capability.
The main process validates callback Host/path/state, checks the PKCE verifier, verifies the actual
workspace/user, encrypts the grant and rotates expiring tokens without changing connection identity.
Slack disconnect clears only its saved grant and manual Slack user token, preserving other providers.
Signing in enables joined-conversation discovery and background source intake. The Slack sidebar
provides an actual message/thread reader. Sending remains a separate confirmed action.

`LINEAR_OAUTH_CLIENT_SECRET` is optional: the authorization-code flow uses S256 PKCE.
When registering Linear, enable **Public** to allow users in other workspaces to install Muse.
Use the per-user authorization flow; client-credentials grants and webhooks are not required.
GitHub requires the client secret for this flow even with PKCE. GitHub scopes are `repo`,
`read:user`, `read:org` and `offline_access`; Linear uses `read,write` with `actor=user`.
Write scopes support existing explicitly initiated PR and ticket actions; signing in itself does
not publish a review, merge a PR or complete a ticket. Organizations may require separate approval.

Reload Settings after saving. Choose **Sign in with GitHub** and **Sign in with Linear**, approve
in your system browser, then return to Muse. The callback listener runs only during sign-in.
**Cancel** closes it. A second pending login waits until the first is finished or cancelled.
Use **Reconnect** to replace an account; cancellation preserves the previous saved connection.

The same authenticated clients power real repositories, requested reviews, own-PR feedback,
assigned Linear tickets, team/project scopes and existing worker actions. Account changes clear
fetched queues and reject in-flight responses from the previous connection before refreshing.
Local repository registrations and app-owned job history are retained.

Tokens and refresh tokens are encrypted with Electron `safeStorage` in the private user-data
directory (`oauth/oauth.sessions.encrypted.json`, owner-only permissions). The renderer receives
only connection/profile metadata. Expiring tokens refresh before data requests; concurrent
refreshes coalesce. A failed refresh asks for reconnection rather than silently switching accounts
to a token from `.env`. Long-lived GitHub tokens without an expiry are also supported.

**Disconnect** removes the selected provider's encrypted session and its local manual token from
`.env`. Registered client settings and the other provider stay intact. It does not revoke the
remote grant; revoke that in GitHub or Linear settings when needed. Existing `GITHUB_TOKEN` and
`LINEAR_API_KEY` are development alternatives, with OAuth taking precedence once connected.

This local POC reads registration credentials from `.env`. For wider distribution, GitHub's
client secret should be exchanged through an app-owned backend rather than bundled into a public
desktop binary. That deployment service is not part of the local connection flow.

Implementation: `src/shared/contracts/oauth.ts`, `src/main/oauth/`, `src/renderer/oauth/`,
`src/main/services.ts` and root router composition under `apps/desktop/`.

Validation: `bun run test:oauth` runs the built default Electron UI, preload and IPC, real loopback
HTTP callbacks, OS encryption, provider clients, token refresh, disconnect and shutdown against
controlled provider responses. It does not authorize a human account or call live OAuth endpoints.
Real browser approval needs the registrations above.

Provider references: [GitHub authorization flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
and [Linear OAuth](https://linear.app/developers/oauth-2-0-authentication).
