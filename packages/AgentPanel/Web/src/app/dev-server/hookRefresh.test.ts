/**
 * @vitest-environment node
 *
 * Whether the panel's `.ts` hook modules come out of the dev server signed for Fast Refresh.
 *
 * Run through a real Vite, because the plugin leans on a test inside Vite's own transform: a Vite
 * that changes that test has to fail here, not bring "Should have a queue" back to the live panel.
 * The unmarked case is checked beside it, so a Vite that starts signing `.ts` hooks by itself says
 * so too, and this plugin can be deleted.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import react from "@vitejs/plugin-react";
import { createServer, type Plugin } from "vite";
import { hookRefresh, needsHookRefresh, needsSignature } from "@/app/dev-server/hookRefresh";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
/** Real hook modules of the panel's: one in a `.ts` file, and one in a `.tsx` that has no component. */
const TS_HOOKS = "/src/hooks/useLatestRef.ts";
const TSX_HOOKS = "/src/features/bots/cards/useCardResize.tsx";
/** What the refresh transform writes when it signs a hook. */
const SIGNED = /_s\(use[A-Za-z]+,/;
/** A module-local `$RefreshSig$` from React's runtime, rather than the page's no-op one. */
const REAL_SIGNATURE = /function \$RefreshSig\$\(\) \{ return \w+\.createSignatureFunctionForTransform\(\); \}/;

async function served(plugins: Plugin[], module: string): Promise<string> {
  const server = await createServer({
    configFile: false,
    root: ROOT,
    logLevel: "silent",
    appType: "custom",
    // The module under test imports through the panel's alias, and import analysis resolves it.
    resolve: { alias: { "@/": `${ROOT}src/` } },
    plugins: [...plugins, react()],
    server: { middlewareMode: true, ws: false, watch: null },
  });
  try {
    const result = await server.transformRequest(module);
    if (!result) throw new Error(`Vite returned nothing for ${module}`);
    return result.code;
  } finally {
    await server.close();
  }
}

describe("hook modules under Fast Refresh", () => {
  it("signs the hooks of a .ts module, against React's runtime", async () => {
    const code = await served(hookRefresh(), TS_HOOKS);
    expect(code).toMatch(SIGNED);
    expect(code).toMatch(REAL_SIGNATURE);
  }, 30_000);

  it("gives a .tsx module of hooks alone a real signature too", async () => {
    expect(await served(hookRefresh(), TSX_HOOKS)).toMatch(REAL_SIGNATURE);
  }, 30_000);

  it("finds both gaps without it, which is what the plugin exists for", async () => {
    // A Vite that closes either one fails here, and the half that answered it can go.
    expect(await served([], TS_HOOKS)).not.toMatch(SIGNED);
    const tsx = await served([], TSX_HOOKS);
    expect(tsx).toMatch(SIGNED);
    expect(tsx).not.toMatch(REAL_SIGNATURE);
  }, 30_000);
});

describe("which modules it marks", () => {
  it("marks a .ts module exporting a hook, however it is declared", () => {
    expect(needsHookRefresh("/web/src/useA.ts", "export function useThing() {}")).toBe(true);
    expect(needsHookRefresh("/web/src/a.ts?v=1", "export const useThing = () => 1;")).toBe(true);
    expect(needsHookRefresh("/web/src/a.ts", "export async function useLoad() {}")).toBe(true);
  });

  it("leaves components, plain modules, declarations and dependencies alone", () => {
    expect(needsHookRefresh("/web/src/A.tsx", "export function useThing() {}")).toBe(false);
    expect(needsHookRefresh("/web/src/a.ts", "export function user() {}\nconst useLocal = 1;")).toBe(false);
    expect(needsHookRefresh("/web/src/a.d.ts", "export function useThing(): void;")).toBe(false);
    expect(needsHookRefresh("/web/node_modules/x/a.ts", "export function useThing() {}")).toBe(false);
  });

  it("gives a signature only to a module that calls one and was not given one", () => {
    expect(needsSignature("/web/src/a.ts", "var _s = $RefreshSig$();")).toBe(true);
    expect(needsSignature("/web/src/A.tsx", "var _s = $RefreshSig$();\nfunction $RefreshSig$() {}")).toBe(false);
    expect(needsSignature("/web/src/a.ts", "export const x = 1;")).toBe(false);
    expect(needsSignature("/web/node_modules/x/a.js", "var _s = $RefreshSig$();")).toBe(false);
  });
});
