"use client";

// The panel's one syntax highlighter, and the only one it should have.
//
// Shiki, on its pure-JS regex engine and its fine-grained core build. The alternative checked into
// this repository is CodeMirror, under `packages/WorkspaceIDE/Web`, and that package is the IDE
// this panel replaced: nothing live imports it. Reach for this one.
//
// Four constraints drive the shape:
//   1. file:// safety. The phone webview loads under a custom WKURLSchemeHandler where fetching
//      the oniguruma .wasm is unreliable, so the engine is `createJavaScriptRegexEngine`. No wasm,
//      no network, nothing fetched from anywhere but this origin.
//   2. Height stability. Highlighting only recolours tokens; it never changes line count or
//      wrapping. So a block renders as plain text synchronously, at the correct height on first
//      paint, and upgrades in place once a grammar arrives. That is what keeps the virtualized
//      feed from mis-measuring rows.
//   3. Bundle weight. The core and the first grammars are dynamically imported, so they split out
//      of the first-paint chunk and load when the first block appears.
//   4. Arbitrary files. The feed sees the handful of languages agents write in; the workspace IDE
//      opens whatever is in fifteen projects. So the eager set below is the common case, and
//      anything else shiki ships is fetched when a file asks for it -- one chunk per grammar,
//      never more than once, and never for a reader who does not open that language.

import type { HighlighterCore } from "shiki/core";
import { useCallback, useSyncExternalStore } from "react";

// Emitted by codeToHtml as `--shiki-light` / `--shiki-dark` CSS variables on each token;
// markdown.css selects between them from the system theme.
export const SHIKI_THEMES = { light: "github-light", dark: "github-dark" } as const;

/** Shiki's name for no grammar at all. It needs no loading and always works. */
const PLAIN = "text";

/**
 * Names shiki does not know, and what they are.
 *
 * Deliberately short. Shiki's own registry carries 332 ids and aliases -- `ts`, `yml`, `rb`,
 * `dockerfile` and the rest all resolve there -- so a table of those here would be a second
 * spelling of something that already has one, and would go stale the moment shiki adds a
 * language. What is left is the genuinely unknown: two fence names editors emit, one file
 * extension Apple invented, and the files whose name IS their type.
 */
const NAMES_SHIKI_LACKS: Record<string, string> = {
  typescriptreact: "tsx",
  javascriptreact: "jsx",
  golang: "go",
  htm: "html",
  // Apple property lists and entitlements are XML, and SVG is too.
  plist: "xml",
  entitlements: "xml",
  svg: "xml",
  // No extension: the name is the type.
  justfile: "just",
  makefile: "make",
  gnumakefile: "make",
  dockerfile: "docker",
  env: "dotenv",
  zshrc: "bash",
  bashrc: "bash",
  zprofile: "bash",
  profile: "bash",
};

let instance: HighlighterCore | null = null;
let pending: Promise<HighlighterCore> | null = null;
let loaded = new Set<string>();
/** Asked for and not yet here, so a second block in the same language does not fetch it twice. */
const asking = new Set<string>();
/** Asked for and refused: shiki has no such grammar, or it would not load. Never asked again. */
const refused = new Set<string>();
const listeners = new Set<() => void>();
/**
 * What a reader renders from, replaced whole on every announcement.
 *
 * The value itself rather than a counter beside the variables above: React Compiler caches a
 * hook's result on what it reads through React, and takes a module variable read in render to
 * never change, so a counter that moved while `instance` was read directly left every block on the
 * `null` highlighter it first saw.
 */
let snapshot: { highlighter: HighlighterCore | null; loaded: ReadonlySet<string> } = {
  highlighter: null,
  loaded,
};

function announce(): void {
  snapshot = { highlighter: instance, loaded };
  for (const listener of listeners) listener();
}

function readSnapshot(): typeof snapshot {
  return snapshot;
}

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
      const created = await core.createHighlighterCore({
        themes: [light.default, dark.default],
        langs: langs.map((module) => module.default),
        engine: engine.createJavaScriptRegexEngine(),
      });
      instance = created;
      loaded = new Set(created.getLoadedLanguages());
      announce();
      return created;
    })();
  }
  return pending;
}

/**
 * Fetches one grammar the eager set does not carry.
 *
 * A grammar that is not there leaves the file plain, which is this module's whole failure mode and
 * is why the refusal is remembered rather than retried: the alternative is a fetch per render for
 * a language that will never resolve. It is logged once so a missing grammar is discoverable
 * rather than silent.
 */
async function ensureLanguage(id: string): Promise<void> {
  if (id === PLAIN || loaded.has(id) || asking.has(id) || refused.has(id)) return;
  asking.add(id);
  try {
    const highlighter = await ensureHighlighter();
    // The registry rather than a path built from `id`: every entry is a thunk the bundler can see,
    // so each grammar is its own chunk, and an id shiki does not have is absent rather than a 404.
    const { bundledLanguages } = await import("shiki/langs");
    const grammar = bundledLanguages[id as keyof typeof bundledLanguages];
    if (!grammar) {
      refused.add(id);
      return;
    }
    await highlighter.loadLanguage(grammar);
    loaded = new Set(highlighter.getLoadedLanguages());
    announce();
  } catch (error) {
    refused.add(id);
    console.error(`shiki could not load the ${id} grammar; showing it as plain text`, error);
  } finally {
    asking.delete(id);
  }
}

/**
 * What grammar a fence language or a file name is asking for, before anyone has checked.
 *
 * One function for both because they are the same string arriving from two places: a fence says
 * `ts`, a file says `useWorkspaceIde.ts`, and shiki spells the answer the same way. Longest
 * meaning first -- the whole name, then its extension, then the body of a dotfile -- so `Justfile`
 * is matched as a name and `main.tsx` as an extension, and `.env.local` reaches `env`.
 */
export function grammarWanted(nameOrLang: string): string {
  const raw = nameOrLang.trim().toLowerCase();
  if (!raw) return PLAIN;
  const base = raw.slice(raw.lastIndexOf("/") + 1);
  const tries = [base];
  const dot = base.lastIndexOf(".");
  if (dot > 0) tries.push(base.slice(dot + 1));
  if (base.startsWith(".")) tries.push(base.slice(1).split(".")[0]!);
  for (const attempt of tries) {
    const known = NAMES_SHIKI_LACKS[attempt];
    if (known) return known;
  }
  return tries.at(-1) || PLAIN;
}

/**
 * The highlighter, and the grammar to actually render with right now.
 *
 * `lang` is `text` until the grammar for `nameOrLang` is in hand, so a caller can hand both
 * straight to `codeToHtml` and never be the one that asks for a language the highlighter does not
 * have -- which throws. Every consumer goes through this rather than reading the two apart,
 * because getting that pairing wrong is invisible until the one file that needs a rare grammar.
 */
export function useCodeHighlighting(nameOrLang: string): { highlighter: HighlighterCore | null; lang: string } {
  const wanted = grammarWanted(nameOrLang);
  // Subscribing is also what asks for the grammar, so a block that wants a new one asks once.
  const subscribe = useCallback(
    (onChange: () => void) => {
      listeners.add(onChange);
      void ensureHighlighter().then(() => ensureLanguage(wanted));
      return () => {
        listeners.delete(onChange);
      };
    },
    [wanted],
  );
  const current = useSyncExternalStore(subscribe, readSnapshot, readSnapshot);
  return { highlighter: current.highlighter, lang: current.loaded.has(wanted) ? wanted : PLAIN };
}
