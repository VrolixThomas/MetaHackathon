# GitHub access for hosted review preparation

GitHub OAuth identifies the person using Muse. The hosted worker uses a separate **GitHub App
installation** to read approved repositories when no desktop is running. Confirmed review comments
continue to use the existing user connection; hosted preparation never posts comments or merges.

Create a GitHub App in the account or organization that will own Muse's integration. Install it on
**only the repositories** that should receive preparation. Keep SSL verification enabled.

| Setting | Value |
| --- | --- |
| Suggested name | Muse Team Review Prep (must be globally unique) |
| Homepage | https://github.com/VrolixThomas/MetaHackathon |
| Webhook URL | https://vmydpscnfgvbciotoaln.supabase.co/functions/v1/muse-team-webhook |
| Repository permissions | Metadata: read; Contents: read; Pull requests: read |
| Events | Pull request |
| User authorization / device flow | Not needed for this server installation flow |

A callback URL/client secret for user OAuth is not required by this worker. The existing **Muse
Team Sign-in** OAuth app stays separate. If installing across accounts, the App's installation
policy must allow the account that owns the target repositories.

The server needs:

- `GITHUB_APP_ID`, the numeric App ID.
- `GITHUB_APP_PRIVATE_KEY`, generated/downloaded from the App settings as PEM.
- `GITHUB_WEBHOOK_SECRET`, the same strong secret in GitHub and Supabase Edge secrets.
- An installation on the selected repositories. Muse verifies and records its installation ID during
  repository registration; membership alone grants no repository access.

Place credentials only in the private backend configuration/secret store. Never put the PEM or
webhook secret in the desktop `.env`, repository, chat, a URL or frontend state. Browser credential
entry is a user handoff; preserve the downloaded PEM in a private local location for server setup.
The already configured `MODEL_API_KEY` powers Muse preparation; no new model provider is needed.

See the [official GitHub App registration guide](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app).
The Edge endpoint and scheduler are enabled only after the actual provider configuration has been
verified. Missing credentials produce configuration errors, not prepared reviews or test evidence.
