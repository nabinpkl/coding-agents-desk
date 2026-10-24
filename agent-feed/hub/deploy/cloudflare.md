# Cloudflare resources

What the hub needs from Cloudflare, and where each value goes. Nothing here is specific to one
deployment: keep your own account, zone, application and token ids in `cloudflare.private.md` beside
this file, which is gitignored. Secrets live only in `deploy/.env` on the machine running the hub
(mode 0600), never in either file.

| Resource | Settings | Feeds |
|---|---|---|
| A zone you control, and a hostname in it for the hub (say `relay.example.com`) | | the hub's public URL, `HUB_URL` on every client |
| A Zero Trust team (`<team>.cloudflareaccess.com`) | | `CF_ACCESS_TEAM_DOMAIN` |
| A remotely managed tunnel, with ingress from the hub's hostname to `http://hub:3850` | | `CLOUDFLARE_TUNNEL_TOKEN` |
| A self-hosted Access application on the hub's hostname | session 24h | its AUD tag is `CF_ACCESS_AUD` |
| Managed OAuth on that application | grant session `8760h`, access token `15m`, dynamic client registration on; allowed redirects `https://claude.ai/api/mcp/auth_callback` plus any localhost and loopback port, for CLI clients | owner sign-in from claude.ai and opencode |
| Policy `hub service tokens` | `non_identity`, including every machine's service token, evaluated first | the machines |
| Policy `owner` | `allow`, including the owner's email | `HUB_OWNER_EMAIL` |
| One Access service token per machine and per surface (a Mac, a peer, the panel, the annotator, the e2e suite) | | each token's client id goes in `HUB_PRINCIPALS`; its secret goes in that machine's hub env file |

Owner login (Managed OAuth, owner email only) maps to a hub principal that may speak as a session on
any machine and as the human; see `HUB_OWNER_EMAIL` in `.env.example` and the trust section of
`docs/agent-messaging.md`. Machine paths (sidecar, panel backend, tests) keep service-token headers.

## Rotating the service tokens

`rotate-service-tokens.mjs` rotates every token through the Cloudflare API and writes each new
secret straight into the file that holds it, locally or over ssh, printing only a digest prefix. It
reads the API token from `deploy/.env` (`CLOUDFLARE_ACCESS_TOKEN`) and the account and token table
from `deploy/service-tokens.json`, which is gitignored; `service-tokens.example.json` shows its shape.
Run it from the repository root. `--check` validates the table and lists it without calling
Cloudflare.
