// Which surface a browser tab opens on and which machine it was last pointed at: what the address bar
// and storage remember for `BrowserSurfaces`, kept apart from the component.
//
// Apart because React's live refresh only takes a module that exports nothing but components. These
// lived in `BrowserSurfaces.tsx` beside it, so every edit to that file went past refresh to
// `main.tsx`, which accepts nothing, and reloaded every open panel instead of updating it.

export type BrowserSurface = "desktop" | "feed" | "screen" | "terminals" | "ide" | "arena";

export const SURFACES: { readonly name: BrowserSurface; readonly label: string }[] = [
  { name: "desktop", label: "Desktop" },
  { name: "feed", label: "Feed" },
  { name: "screen", label: "Screen" },
  { name: "terminals", label: "Terminals" },
  { name: "ide", label: "IDE" },
  { name: "arena", label: "Arena" },
];

const NAMED = new Set<string>(SURFACES.map((surface) => surface.name));

/**
 * Which surface a plain browser opens on.
 *
 * The desktop viewer is the default, which is the opposite of every native container: a shell opens
 * the webview it wants, so the feed is reachable from anywhere, while the desktop was reachable from
 * nowhere but inside the iOS app. `?entry=` asks for another, and the value is the same vocabulary
 * `panelEntry` reads, so one parameter means one thing everywhere.
 */
export function initialSurface(search: string = window.location.search): BrowserSurface {
  const asked = new URLSearchParams(search).get("entry") ?? "";
  return NAMED.has(asked) ? (asked as BrowserSurface) : "desktop";
}

const SESSION_STORAGE_KEY = "agentdesk.panel.session";
/** Matches the ids the server will route; a hand-edited value must not reshape a path. */
const SESSION_ID = /^[a-z0-9-]+$/i;

/**
 * The session this panel was last showing, restored optimistically.
 *
 * Optimistic because the live list arrives over the stream a moment later, and waiting for it would
 * open every reload on the default session and then jump. If the remembered session turns out not
 * to be running, `BrowserSurfaces` drops back to the default once the list says so.
 */
export function rememberedSession(): string | undefined {
  try {
    const stored = localStorage.getItem(SESSION_STORAGE_KEY);
    return stored && SESSION_ID.test(stored) ? stored : undefined;
  } catch {
    return undefined;
  }
}


/** Remember which machine this panel is pointed at, or forget it for the default. */
export function storeSession(id: string | undefined): void {
  try {
    if (id) localStorage.setItem(SESSION_STORAGE_KEY, id);
    else localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // a private window still gets the choice for this session
  }
}

/** Keeps the address bar honest, so a reload returns to the surface you were on. */
export function rememberSurface(surface: BrowserSurface): void {
  const url = new URL(window.location.href);
  url.searchParams.set("entry", surface);
  window.history.replaceState(null, "", url);
}
