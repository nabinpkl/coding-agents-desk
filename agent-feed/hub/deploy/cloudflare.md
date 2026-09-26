# Cloudflare resources

Account `00000000000000000000000000000000`, zone `example.com`, Zero Trust team `team.cloudflareaccess.com`. Created 2026-09-25. Secrets are not stored here. They live only in `deploy/.env` on oracle (mode 0600).

| Resource | Id | Settings |
|---|---|---|
| Access app `agent-hub` (self-hosted) | `00000000-0000-4000-8000-000000000003` | domain `relay.example.com`, session 24h, AUD `0000000000000000000000000000000000000000000000000000000000000000` |
| Managed OAuth on `agent-hub` (enabled 2026-09-26 via API, mirroring annotator) | | grant session `8760h`, access token `15m`, DCR on, allowed redirects `https://claude.ai/api/mcp/auth_callback`, any localhost and loopback port for CLI clients |
| Policy `hub service tokens` | `00000000-0000-4000-8000-000000000009` | `non_identity`, include the four machine service tokens (evaluated first) |
| Policy `owner` | `00000000-0000-4000-8000-000000000007` | `allow`, include email `owner@example.com` |

Owner login (Managed OAuth, owner email only) maps to a hub principal that may speak as a session on any machine plus as human; see `HUB_OWNER_EMAIL` in `.env.example` and the trust section of `docs/agent-messaging.md`. Machine paths (sidecar, panel backend, tests) keep service-token headers.
