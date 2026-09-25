/* The two origins the extension talks to. manifest.json host_permissions must
 * list both (extension/build.ts checks); DNR header rules also need host
 * access to act on AUTH_ORIGIN. */

/** The annotator server (behind Cloudflare Access). */
export const SERVER_ORIGIN = "https://annotator.example.com";

/** The Access team domain serving the OAuth authorize, token and registration endpoints. */
export const AUTH_ORIGIN = "https://team.cloudflareaccess.com";
