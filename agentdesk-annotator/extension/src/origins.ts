/* The two origins the extension talks to, fixed when it is built: extension/build.ts reads them
 * from ANNOTATOR_URL and CF_ACCESS_TEAM_DOMAIN (agentdesk-annotator/.env, see .env.example),
 * defines them here, and lists both in the built manifest's host_permissions. DNR header rules
 * also need host access to act on AUTH_ORIGIN. */
import { apiUrlOn } from "./apiUrl.ts";

declare const __SERVER_ORIGIN__: string;
declare const __AUTH_ORIGIN__: string;

/** The annotator server (behind Cloudflare Access). */
export const SERVER_ORIGIN: string = __SERVER_ORIGIN__;

/** The Access team domain serving the OAuth authorize, token and registration endpoints. */
export const AUTH_ORIGIN: string = __AUTH_ORIGIN__;

/** The URL a path names on the annotator server, refused unless it is the server's API. */
export function apiUrl(path: string): URL {
  return apiUrlOn(SERVER_ORIGIN, path);
}
