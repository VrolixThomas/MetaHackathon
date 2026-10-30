# GitHub and Linear login (MET-53)

Muse owns this connection flow. SuperiorSwarm is not required at runtime, and its app credentials
are not copied. Register your own applications and add the following fields to the active `.env`.
Development worktrees on this machine use `/Users/Werk/Documents/Repositories/MetaHackathon/.env`.
Settings shows the exact path; **Configure login** opens that file.

| Provider | Registration | Exact callback URL | Required `.env` fields |
| --- | --- | --- | --- |
| GitHub | Settings → Developer settings → OAuth Apps → New OAuth App | `http://127.0.0.1:43187/oauth/github/callback` | `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` |
| Linear | Workspace settings → API → OAuth applications | `http://127.0.0.1:43187/oauth/linear/callback` | `LINEAR_OAUTH_CLIENT_ID` |

`LINEAR_OAUTH_CLIENT_SECRET` is optional: the authorization-code flow uses S256 PKCE.
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
