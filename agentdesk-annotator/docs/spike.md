# Cloudflare Access Managed OAuth spike (2026-09-24)

Goal: prove Cloudflare Access can act as the OAuth server for `https://annotator.example.com/mcp` before building on it. The run used a throwaway echo origin behind the `annotator-oracle` tunnel. All probes ran with curl from oracle, with no browser.

| Check | Result |
|---|---|
| Unauthenticated `POST /mcp` | `401`, `WWW-Authenticate: Bearer realm="OAuth", error="invalid_token", resource_metadata="https://annotator.example.com/.well-known/cloudflare-access-protected-resource/mcp"` |
| `/.well-known/oauth-authorization-server` | issuer `https://team.cloudflareaccess.com`; `registration_endpoint` present; `code_challenge_methods_supported: ["S256"]`; `token_endpoint_auth_methods_supported` includes `none`; grants `authorization_code`, `refresh_token` |
| `/.well-known/oauth-protected-resource[/mcp]` | `resource` = `https://annotator.example.com[/mcp]`; `authorization_servers` = `["https://team.cloudflareaccess.com"]` |
| DCR with `https://<32 chars>.chromiumapp.org/` | accepted (public client, auth method `none`) |
| DCR with a foreign redirect | rejected: `invalid_client_metadata`, "redirect_uri is not allowed by the account configuration" |
| Service token through the edge | origin receives `Cf-Access-Jwt-Assertion`, RS256, `kid` matches the JWKS |
| Service-token policy alongside Managed OAuth | coexist on one app |

Claims the origin receives for a service-token request:

```json
{ "type": "app", "iss": "https://team.cloudflareaccess.com", "sub": "",
  "aud": "<app AUD tag>", "common_name": "<service token client id>", "iat": 0, "exp": 0 }
```

- The JWKS is at `https://team.cloudflareaccess.com/cdn-cgi/access/certs`, with two RS256 keys at the time of the spike.
- The origin also sees a `CF_Authorization` cookie. The origin ignores it and trusts only the header.

Not provable without a browser, so it is checked during the owner sign-in step:
- the claims on OAuth-token (human) requests, where an `email` claim is expected;
- whether the edge forwards or strips `Authorization`. The origin does not read it either way.

Side effect: DCR client `annotator-spike-dcr` (id `00000000-0000-4000-8000-000000000020`) was registered by the probe and is unused.
