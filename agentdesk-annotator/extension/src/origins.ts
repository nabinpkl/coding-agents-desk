/* The two origins the extension talks to. manifest.json host_permissions must
 * list both (extension/build.ts checks); DNR header rules also need host
 * access to act on AUTH_ORIGIN. */

/** The annotator server (behind Cloudflare Access). */
export const SERVER_ORIGIN = "https://annotator.example.com";

/** The Access team domain serving the OAuth authorize, token and registration endpoints. */
export const AUTH_ORIGIN = "https://team.cloudflareaccess.com";

/**
 * The URL a path names, refused unless it is this server's API.
 *
 * The path arrives from a content script, which runs inside every page and is the part of this
 * extension a hostile page is closest to. Concatenating it onto the origin trusted it: a path like
 * `@evil.test/x` turns `https://annotator.example.com@evil.test/x` into a request to another host,
 * carrying the bearer token. Parsing and comparing the origin is what actually pins it.
 */
export function apiUrl(path: string): URL {
  if (!path.startsWith("/api/v1/")) throw new Error(`refusing a request outside /api/v1/: ${path}`);
  const url = new URL(path, SERVER_ORIGIN);
  if (url.origin !== SERVER_ORIGIN || !url.pathname.startsWith("/api/v1/")) {
    throw new Error(`refusing a request that leaves ${SERVER_ORIGIN}/api/v1/: ${path}`);
  }
  return url;
}
