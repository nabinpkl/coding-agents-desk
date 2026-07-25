"use client";

// Singleton Shiki highlighter for the activity feed.
//
// Three design constraints drive this module:
//   1. file:// safety. The phone webview loads under a custom WKURLSchemeHandler
//      where fetching the oniguruma .wasm is unreliable, so we use Shiki's
//      pure-JS regex engine (createJavaScriptRegexEngine) and the fine-grained
//      core build with explicit langs/themes. No wasm, no network.
//   2. Height stability. Highlighting only recolors tokens; it never changes
//      line count or wrapping. So a code block renders as a plain <pre>
//      synchronously (correct height on first paint) and upgrades to the
//      highlighted markup once this async-loaded highlighter is ready, with no
//      change in measured height. That is what keeps the virtualized feed from
//      mis-measuring rows (the bug this whole renderer swap fixes).
//   3. Bundle weight. Shiki core + 16 grammars are a few hundred KB. They are
//      dynamically imported inside ensureHighlighter so they split out of the
//      first-paint chunk and load only when the first code block appears.

import type { HighlighterCore } from "shiki/core";
import { useEffect, useState } from "react";

// Emitted by codeToHtml as `--shiki-light` / `--shiki-dark` CSS variables on
// each token; markdown.css selects between them from the system theme.
export const SHIKI_THEMES = { light: "github-light", dark: "github-dark" } as const;

// Common fence aliases the engine doesn't know by their short name.
const ALIASES: Record<string, string> = {
  ts: "typescript", typescriptreact: "tsx",
  js: "javascript", javascriptreact: "jsx", mjs: "javascript", cjs: "javascript",
  sh: "bash", shell: "bash", zsh: "bash", shellscript: "bash", console: "bash",
  py: "python", rs: "rust", golang: "go", yml: "yaml", md: "markdown", htm: "html",
};

let instance: HighlighterCore | null = null;
let pending: Promise<HighlighterCore> | null = null;
let loaded = new Set<string>();
const listeners = new Set<() => void>();

function ensureHighlighter(): Promise<HighlighterCore> {
  if (instance) return Promise.resolve(instance);
  if (!pending) {
    pending = (async () => {
      const [core, engine, light, dark, ...langs] = await Promise.all([
        import("shiki/core"),
        import("shiki/engine/javascript"),
        import("shiki/themes/github-light.mjs"),
        import("shiki/themes/github-dark.mjs"),
        import("shiki/langs/typescript.mjs"),
        import("shiki/langs/tsx.mjs"),
        import("shiki/langs/javascript.mjs"),
        import("shiki/langs/jsx.mjs"),
        import("shiki/langs/json.mjs"),
        import("shiki/langs/bash.mjs"),
        import("shiki/langs/python.mjs"),
        import("shiki/langs/swift.mjs"),
        import("shiki/langs/rust.mjs"),
        import("shiki/langs/go.mjs"),
        import("shiki/langs/css.mjs"),
        import("shiki/langs/html.mjs"),
        import("shiki/langs/markdown.mjs"),
        import("shiki/langs/diff.mjs"),
        import("shiki/langs/yaml.mjs"),
        import("shiki/langs/sql.mjs"),
      ]);
      const h = await core.createHighlighterCore({
        themes: [light.default, dark.default],
        langs: langs.map((m) => m.default),
        engine: engine.createJavaScriptRegexEngine(),
      });
      instance = h;
      loaded = new Set(h.getLoadedLanguages());
      listeners.forEach((l) => l());
      return h;
    })();
  }
  return pending;
}

/** Map a fence language onto a loaded grammar, falling back to plaintext. */
export function resolveLang(lang: string): string {
  const l = (lang || "").toLowerCase().trim();
  const mapped = ALIASES[l] ?? l;
  return loaded.has(mapped) ? mapped : "text";
}

/**
 * Subscribe to the singleton highlighter. Returns null until it has loaded,
 * then re-renders the caller once with the ready instance. Kicking off the
 * load is idempotent across every code block on the page.
 */
export function useHighlighter(): HighlighterCore | null {
  const [, force] = useState(0);
  useEffect(() => {
    if (instance) return;
    const listener = () => force((x) => x + 1);
    listeners.add(listener);
    void ensureHighlighter();
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return instance;
}
