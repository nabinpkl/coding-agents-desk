# Cloudflare resources

What the annotator server needs from Cloudflare, and where each value goes. Nothing here is
specific to one deployment: keep your own account, zone, tunnel, application and token ids in
`cloudflare.private.md` beside this file, which is gitignored. Secrets live only in `deploy/.env` on
the host (mode 0600) and in the e2e env file on the machine that runs `just e2e`, never in either
file. The identity provider can be anything Access supports; One-time PIN is enough.

| Resource | Settings | Feeds |
|---|---|---|
| A hostname for the server in a zone you control (say `annotator.example.com`) | proxied CNAME to the tunnel | the extension's server origin and the MCP URL |
| A remotely managed tunnel | ingress from that hostname to `http://server:3847`, catch-all `http_status:404` | `CLOUDFLARE_TUNNEL_TOKEN` |
| A self-hosted Access application on that hostname | session 24h | its AUD tag is `CF_ACCESS_AUD`; the team domain is `CF_ACCESS_TEAM_DOMAIN` |
| Managed OAuth on that application | grant session `8760h`, access token `15m`, dynamic client registration on; allowed redirects `https://claude.ai/api/mcp/auth_callback`, `https://<extension id>.chromiumapp.org/` for your build of the extension (the id `chrome://extensions` shows; `ANNOTATOR_EXTENSION_KEY_FILE` in `.env.example` keeps it fixed, and the build then prints it), and any localhost and loopback port for CLI clients | sign-in from claude.ai, the extension and CLI clients |
| Policy `annotator-e2e service token` | `non_identity`, including the `annotator-e2e` service token, evaluated first | the edge e2e suite |
| Policy `owner` | `allow`, including the owner's email | `ANNOTATOR_ALLOWED_EMAILS` |
| Service token `annotator-e2e` | duration 8760h | its client id goes in `ANNOTATOR_ALLOWED_SERVICE_TOKENS` and `E2E_CF_ACCESS_CLIENT_ID` |

Rotating the tunnel token or the service token: create a new one in the Access dashboard (or
through the API), update `deploy/.env` on the host and the e2e env file, then run
`docker compose up -d` in `deploy/`.

## What Send needs from the hub's side

Send talks to the agent hub, which is a separate Access application in the same team (see
`agent-feed/hub/deploy/cloudflare.md`). Two things have to exist there before the annotator server
will start, and neither is created from this repository:

1. **An Access service token on the hub's application**, added to that application's policy as an
   include. Its client id goes in `HUB_ACCESS_CLIENT_ID` and its secret in `HUB_ACCESS_CLIENT_SECRET`
   in `deploy/.env` on the host. Both are sent as headers on every hub request
   (`cf-access-client-id`, `cf-access-client-secret`) and the edge does the exchange, so there is
   nothing to mint or refresh and no second URL to configure.
2. **A principal entry in the hub's `HUB_PRINCIPALS`** naming that client id, with the `human` flag
   and no machine: `<client id>=annotator::human`. Without the flag the hub refuses everything this
   server sends, and the 502 in the log says exactly that.

The hub knows nothing about annotations. This side sends one request with a Markdown brief and a ref
per annotation; the agent answers through the annotator's MCP tools as it already does.
