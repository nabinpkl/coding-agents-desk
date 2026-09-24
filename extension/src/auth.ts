/* OAuth 2.1 public client for the annotator server, run in the background
 * service worker. The server sits behind Cloudflare Access with Managed
 * OAuth: discovery and dynamic client registration happen at the edge, the
 * user signs in through chrome.identity.launchWebAuthFlow (PKCE S256), and
 * tokens live in chrome.storage.local, never in page context. */

export const DEFAULT_SERVER_URL = "https://annotator.example.com";

interface AsMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
}

interface AuthState {
  clientId: string;
  redirectUri: string;
  metadata: AsMetadata;
  accessToken?: string;
  refreshToken?: string;
  /** Epoch ms; absent when the server did not say. */
  expiresAt?: number;
}

export class OAuthError extends Error {
  code: string;
  constructor(code: string, description?: string) {
    super(description ? `${code}: ${description}` : code);
    this.name = "OAuthError";
    this.code = code;
  }
}

/** The server could not be reached at all (as opposed to refusing us). */
export class Offline extends Error {
  constructor(cause: unknown) {
    super(`server unreachable: ${String(cause)}`);
    this.name = "Offline";
  }
}

export async function serverOrigin(): Promise<string> {
  const { serverUrl } = await chrome.storage.local.get("serverUrl");
  return new URL(typeof serverUrl === "string" && serverUrl ? serverUrl : DEFAULT_SERVER_URL).origin;
}

export async function setServerOrigin(url: string): Promise<string> {
  const origin = new URL(url).origin;
  await chrome.storage.local.set({ serverUrl: origin });
  return origin;
}

const stateKey = (origin: string) => `auth:${origin}`;

async function load(origin: string): Promise<AuthState | undefined> {
  const got = await chrome.storage.local.get(stateKey(origin));
  return got[stateKey(origin)] as AuthState | undefined;
}

async function save(origin: string, st: AuthState): Promise<void> {
  await chrome.storage.local.set({ [stateKey(origin)]: st });
}

async function netFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    throw new Offline(e);
  }
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(n: number): string {
  return b64url(crypto.getRandomValues(new Uint8Array(n)));
}

async function s256(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

async function discover(origin: string): Promise<AsMetadata> {
  const res = await netFetch(`${origin}/.well-known/oauth-authorization-server`);
  if (!res.ok) throw new Error(`authorization server metadata: HTTP ${res.status}`);
  const m = (await res.json()) as AsMetadata;
  if (!m.authorization_endpoint || !m.token_endpoint) throw new Error("authorization server metadata is incomplete");
  return m;
}

async function register(meta: AsMetadata, redirectUri: string): Promise<string> {
  if (!meta.registration_endpoint) throw new Error("authorization server does not support dynamic client registration");
  const res = await netFetch(meta.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "AgentDesk Annotator (Chrome extension)",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { client_id?: string; error?: string; error_description?: string };
  if (!res.ok || !body.client_id) throw new OAuthError(body.error ?? `registration HTTP ${res.status}`, body.error_description);
  return body.client_id;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

async function tokenRequest(meta: AsMetadata, params: Record<string, string>): Promise<TokenResponse> {
  const res = await netFetch(meta.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(params).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & { error?: string; error_description?: string };
  if (!res.ok || !body.access_token) throw new OAuthError(body.error ?? `token HTTP ${res.status}`, body.error_description);
  return body as TokenResponse;
}

function withTokens(st: AuthState, t: TokenResponse): AuthState {
  return {
    ...st,
    accessToken: t.access_token,
    // Refresh tokens rotate: keep the old one only if the server did not issue a new one.
    refreshToken: t.refresh_token ?? st.refreshToken,
    expiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : undefined,
  };
}

/** Interactive sign-in. Registers a client for this extension on first use. */
export async function signIn(): Promise<void> {
  const origin = await serverOrigin();
  const redirectUri = chrome.identity.getRedirectURL();
  let st = await load(origin);
  if (!st || st.redirectUri !== redirectUri) {
    const metadata = await discover(origin);
    st = { clientId: await register(metadata, redirectUri), redirectUri, metadata };
    await save(origin, st);
  }
  const verifier = randomToken(48);
  const state = randomToken(16);
  const url = new URL(st.metadata.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: st.clientId,
    redirect_uri: redirectUri,
    code_challenge: await s256(verifier),
    code_challenge_method: "S256",
    state,
    resource: origin,
  }).toString();

  const redirected = await chrome.identity.launchWebAuthFlow({ url: url.toString(), interactive: true });
  if (!redirected) throw new Error("sign-in was cancelled");
  const back = new URL(redirected);
  const err = back.searchParams.get("error");
  if (err) throw new OAuthError(err, back.searchParams.get("error_description") ?? undefined);
  if (back.searchParams.get("state") !== state) throw new Error("sign-in state mismatch");
  const code = back.searchParams.get("code");
  if (!code) throw new Error("sign-in returned no authorization code");

  try {
    const tokens = await tokenRequest(st.metadata, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: st.clientId,
      code_verifier: verifier,
      resource: origin,
    });
    await save(origin, withTokens(st, tokens));
  } catch (e) {
    // A client the server no longer knows: forget it so the next attempt re-registers.
    if (e instanceof OAuthError && e.code === "invalid_client") await chrome.storage.local.remove(stateKey(origin));
    throw e;
  }
}

export async function signOut(): Promise<void> {
  const origin = await serverOrigin();
  const st = await load(origin);
  if (st) await save(origin, { clientId: st.clientId, redirectUri: st.redirectUri, metadata: st.metadata });
}

let refreshing: Promise<string | null> | null = null;

async function refresh(origin: string, st: AuthState): Promise<string | null> {
  if (!st.refreshToken) {
    await signOut();
    return null;
  }
  try {
    const t = await tokenRequest(st.metadata, { grant_type: "refresh_token", refresh_token: st.refreshToken, client_id: st.clientId, resource: origin });
    const next = withTokens(st, t);
    await save(origin, next);
    return next.accessToken ?? null;
  } catch (e) {
    if (e instanceof OAuthError) {
      await signOut();
      return null;
    }
    throw e;
  }
}

/**
 * A usable access token, refreshing when it is about to expire (or when
 * force is set after a 401). null means the user must sign in again.
 * Throws Offline when the token endpoint cannot be reached.
 */
export async function accessToken(force = false): Promise<string | null> {
  const origin = await serverOrigin();
  const st = await load(origin);
  if (!st?.accessToken) return null;
  const fresh = st.expiresAt === undefined || Date.now() < st.expiresAt - 60_000;
  if (fresh && !force) return st.accessToken;
  refreshing ??= refresh(origin, st).finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export async function isSignedIn(): Promise<boolean> {
  const st = await load(await serverOrigin());
  return Boolean(st?.accessToken);
}
