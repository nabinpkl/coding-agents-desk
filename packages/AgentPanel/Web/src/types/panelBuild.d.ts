// Two things the panel reads from its own bundler, neither of which the DOM lib knows about.
//
// `vite/client` is deliberately not pulled in for these: it declares the whole `import.meta.env`
// surface and every asset-import module, and this tree uses exactly the two members below.

/**
 * Which commit the panel's Vite config was loaded at, substituted at transform time.
 * `panelBuild.ts` is the only reader and carries what it means in each mode.
 */
declare const __PANEL_BUILD__: string;

interface ImportMeta {
  /** Present only when a dev server is serving this page. Undefined in a bundled build. */
  readonly hot?: {
    on(event: string, listener: () => void): void;
    off(event: string, listener: () => void): void;
  };
}
