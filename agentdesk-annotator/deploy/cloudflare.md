# Cloudflare resources

Account `00000000000000000000000000000000`, zone `example.com` (`00000000000000000000000000000000`), Zero Trust team `team.cloudflareaccess.com` (identity provider: One-time PIN). Created 2026-09-24. Secrets are not stored here. They live only in `deploy/.env` on oracle (mode 0600) and `~/.config/agentdesk-annotator/e2e.env` on the mac.

| Resource | Id | Settings |
|---|---|---|
| Tunnel `annotator-oracle` (remotely managed) | `00000000-0000-4000-8000-000000000018` | ingress `annotator.example.com` → `http://server:3847`, catch-all `http_status:404` |
| DNS CNAME `annotator.example.com` (proxied) | `00000000000000000000000000000000` | → `7e55bb28-….cfargotunnel.com` |
| Access app `annotator` (self-hosted) | `00000000-0000-4000-8000-000000000004` | domain `annotator.example.com`, session 24h, AUD `0000000000000000000000000000000000000000000000000000000000000000` |
| Managed OAuth on `annotator` | | grant session `8760h`, access token `15m`, DCR on, allowed redirects `https://claude.ai/api/mcp/auth_callback` and `https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.chromiumapp.org/` (this extension only; its id is pinned by the manifest `key`), any localhost and loopback port for CLI clients |
| Policy `annotator-e2e service token` | `00000000-0000-4000-8000-000000000010` | `non_identity`, include service token `annotator-e2e` (evaluated first) |
| Policy `owner` | `00000000-0000-4000-8000-000000000008` | `allow`, include email `owner@example.com` |
| Service token `annotator-e2e` | `00000000-0000-4000-8000-000000000013` | client id `00000000000000000000000000000000.access`, duration 8760h |

Rotating the tunnel token or service token: create a new one in the Access dashboard (or through the API), update `deploy/.env` on oracle and `e2e.env` on the mac, then run `docker compose up -d` in `deploy/`.

## What Send needs from the hub's side

Send talks to the agent hub at `relay.example.com`, which is a separate Access app in the same team. Two things have to exist there before the annotator server will start, and neither is created from this repo:

1. **An Access service token on the hub's app**, added to that app's policy as an include. Its client id goes in `HUB_ACCESS_CLIENT_ID` and its secret in `HUB_ACCESS_CLIENT_SECRET` in `deploy/.env` on oracle. Both are sent as headers on every hub request (`cf-access-client-id`, `cf-access-client-secret`) and the edge does the exchange, so there is nothing to mint or refresh and no second URL to configure.
2. **A principal entry in the hub's `HUB_PRINCIPALS`** naming that client id, with the `human` flag and no machine: `annotator=<client id>=annotator::human`. Without the flag the hub refuses everything this server sends, and the 502 in the log says exactly that.

Created 2026-09-25: service token `hub-annotator` (id `00000000-0000-4000-8000-000000000015`, client id `00000000000000000000000000000000.access`), added to the existing `hub service tokens` policy on the `agent-hub` app alongside `hub-mac`, `hub-oracle` and `hub-panel`.

The hub knows nothing about annotations. This side sends one request with a Markdown brief and a ref per annotation; the agent answers through the `agentdesk-annotator_*` tools as it already does.
