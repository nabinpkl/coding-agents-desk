import { defineConfig } from 'vite'

/// Both documents are loaded by a WKWebView over the custom `app://` scheme, which shapes two
/// settings that would otherwise be defaults:
///
///  - `base: './'` so emitted asset URLs resolve against `app://app/`. An absolute `/assets/...`
///    would ask for `app://assets/...`, a host the scheme handler does not serve.
///  - crossorigin is stripped from the tags Vite emits. It puts the request in CORS mode, and the
///    scheme handler answers with no `Access-Control-Allow-Origin`, so the fetch would fail. The
///    assets are same-origin by construction; there is nothing for CORS to decide.
const appSchemeAssets = {
  name: 'agentdesk-app-scheme-assets',
  enforce: 'post',
  transformIndexHtml: (html) => html.replace(/\s+crossorigin(=("[^"]*"|'[^']*'))?/g, ''),
}

export default defineConfig({
  base: './',
  plugins: [appSchemeAssets],
  build: {
    target: 'safari17',
    // The Swift resource trees are committed, so a stable layout keeps diffs readable: one
    // `assets/` directory, content-hashed names, no inlining that would bloat the HTML.
    assetsInlineLimit: 0,
    rollupOptions: { output: { assetFileNames: 'assets/[name]-[hash][extname]' } },
  },
  server: { port: 5183, strictPort: true },
})
