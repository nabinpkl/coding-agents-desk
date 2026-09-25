/* The two origins the extension talks to. manifest.json host_permissions must
 * list both (extension/build.ts checks): Chrome sends no Origin header on
 * requests to hosts the extension has access to, and Cloudflare Access
 * rejects OAuth registration and token requests that carry a
 * chrome-extension:// Origin. */

/** The annotator server (behind Cloudflare Access). */
export const SERVER_ORIGIN = "https://annotator.example.com";

/** The Access team domain serving the OAuth authorize, token and registration endpoints. */
export const AUTH_ORIGIN = "https://team.cloudflareaccess.com";
