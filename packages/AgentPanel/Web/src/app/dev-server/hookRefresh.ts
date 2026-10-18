/**
 * Puts the panel's hook modules under React Fast Refresh, which Vite leaves them out of twice.
 *
 * Once at the transform: Vite 8 runs the refresh transform only on a module whose name ends in
 * `x` or whose code names `react/jsx-runtime` (`vite/dist/node/chunks/node.js`, the oxc plugin's
 * `transform`), and that test is hard-coded, so plugin-react's `include` cannot widen it. With React
 * Compiler on (`panelReact.ts`) the compiler's transform signs instead, and plugin-react gives it the
 * same test. A hook in a `.ts` file gets no signature at all.
 *
 * And once at the wrapper: a module the transform did sign is given a real `$RefreshSig$` only
 * when it also registers a component. A module of hooks alone -- `useCardResize.tsx` as much as any
 * `.ts` -- calls the page's global one instead, which plugin-react's preamble defines as a no-op
 * (`window.$RefreshSig$ = () => (type) => type`). So its signatures are thrown away, and React's
 * runtime skips an unsigned hook on the assumption that it "won't change during this session"
 * (`@vitejs/plugin-react/dist/refresh-runtime.js`).
 *
 * Ours do change. A save that adds or removes a `useState` inside one keeps every caller's old
 * state, the hook list no longer lines up with it, and the card fails with "Should have a queue".
 * So:
 *
 * - before Vite's transform, a `.ts` module that exports a hook gets the words Vite looks for, as
 *   a comment at its end, so its hooks are signed;
 * - after the wrapper, a module that calls `$RefreshSig$` without having been given one gets its
 *   own, from React's refresh runtime, the same one a component module is given.
 *
 * A change to a hook then changes the signature of every component calling it, and React remounts
 * those components instead of failing them. Both halves append and move nothing, so the source map
 * stands as it was (`map: null`). This leans on Vite's internals, which is why
 * `hookRefresh.test.ts` runs the real transform: a Vite that changes either rule fails that test
 * rather than bringing the error back quietly.
 */

import type { Plugin } from "vite";

/** What Vite's transform looks for; written as a comment so nothing is imported. */
export const HOOK_REFRESH_MARK = "\n// react/jsx-runtime: a hook module, under Fast Refresh (hookRefresh.ts)\n";

/** The module plugin-react serves React's refresh runtime from, the one its wrapper imports. */
const REFRESH_RUNTIME = "/@react-refresh";

/** A module-local `$RefreshSig$`; a function declaration, so the transform's top-level calls reach it. */
export const HOOK_REFRESH_SIGNATURE = `
import * as __hookRefreshRuntime from "${REFRESH_RUNTIME}";
function $RefreshSig$() { return __hookRefreshRuntime.createSignatureFunctionForTransform(); }
`;

const HOOK_EXPORT = /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function\s*\*?\s*|const\s+|let\s+)use[A-Z0-9]/;

function pathOf(id: string): string {
  return id.split("?", 1)[0]!;
}

/** Whether a module is a `.ts` file of ours that exports a hook, and so needs marking. */
export function needsHookRefresh(id: string, code: string): boolean {
  const path = pathOf(id);
  if (!path.endsWith(".ts") || path.endsWith(".d.ts")) return false;
  if (path.includes("/node_modules/")) return false;
  return HOOK_EXPORT.test(code);
}

/** Whether a transformed module signs hooks with the page's no-op, having been given nothing better. */
export function needsSignature(id: string, code: string): boolean {
  if (pathOf(id).includes("/node_modules/")) return false;
  return code.includes("$RefreshSig$()") && !/function \$RefreshSig\$\(/.test(code);
}

/** The dev server's half; a build has no Fast Refresh to put anything under. */
export function hookRefresh(): Plugin[] {
  return [
    {
      name: "agent-panel:hook-refresh-mark",
      apply: "serve",
      enforce: "pre",
      transform(code, id) {
        if (!needsHookRefresh(id, code)) return null;
        return { code: code + HOOK_REFRESH_MARK, map: null };
      },
    },
    {
      name: "agent-panel:hook-refresh-signature",
      apply: "serve",
      enforce: "post",
      transform(code, id) {
        if (!needsSignature(id, code)) return null;
        return { code: code + HOOK_REFRESH_SIGNATURE, map: null };
      },
    },
  ];
}
