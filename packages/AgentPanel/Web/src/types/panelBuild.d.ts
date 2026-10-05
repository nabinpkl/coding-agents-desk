// Three things the panel reads from its own bundler, none of which the DOM lib knows about.
//
// `vite/client` is deliberately not pulled in for these: it declares the whole `import.meta.env`
// surface and every asset-import module, and this tree uses exactly the three members below.

/**
 * Which commit the panel's Vite config was loaded at, substituted at transform time.
 * `panelBuild.ts` is the only reader and carries what it means in each mode.
 */
declare const __PANEL_BUILD__: string;

interface ImportMeta {
  /** Present only when a dev server is serving this page. Undefined in a bundled build. */
  readonly hot?: {
    /** Vite's own events carry nothing this panel reads; a custom one carries its payload. */
    on(event: string, listener: (data?: unknown) => void): void;
    off(event: string, listener: (data?: unknown) => void): void;
  };
}

/**
 * A file's address rather than its contents, which Vite emits as an asset beside the bundle. The
 * PDF preview hands pdf.js its worker this way, because a worker is loaded by URL.
 */
declare module "*?url" {
  const url: string;
  export default url;
}
