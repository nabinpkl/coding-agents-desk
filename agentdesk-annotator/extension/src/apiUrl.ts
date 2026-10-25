/* The one way a request to the annotator server is addressed. Apart from origins.ts, which holds
 * the server's origin, so the check can be tested without a build. */

/**
 * The URL a path names on `server`, refused unless it is that server's API.
 *
 * The path arrives from a content script, which runs inside every page and is the part of this
 * extension a hostile page is closest to. Concatenating it onto the origin trusted it: a path like
 * `@evil.test/x` turns `https://annotator.example.com@evil.test/x` into a request to another host,
 * carrying the bearer token. Parsing and comparing the origin is what actually pins it.
 */
export function apiUrlOn(server: string, path: string): URL {
  if (!path.startsWith("/api/v1/")) throw new Error(`refusing a request outside /api/v1/: ${path}`);
  const url = new URL(path, server);
  if (url.origin !== server || !url.pathname.startsWith("/api/v1/")) {
    throw new Error(`refusing a request that leaves ${server}/api/v1/: ${path}`);
  }
  return url;
}
