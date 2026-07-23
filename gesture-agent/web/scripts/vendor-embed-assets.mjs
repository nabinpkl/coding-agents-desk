/**
 * Vendor the MediaPipe runtime + models into `embed-public/` so the offline
 * embed bundle ships them (no CDN at runtime). Sources are already on disk:
 *   - WASM: node_modules/@mediapipe/tasks-vision/wasm  (the pinned dependency)
 *   - models: ../data/gesture/models/{hand,face}_landmarker.task
 *
 * `embed-public/` is gitignored and used as the Vite embed publicDir, so its
 * contents land at the bundle root (/mediapipe, /models) — the origin-root
 * paths landmarker.ts requests when embedded.
 *
 * Run via `pnpm build:embed`; standalone: `node scripts/vendor-embed-assets.mjs`.
 */

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(webDir, "..");
const outDir = join(webDir, "embed-public");

const wasmSrc = join(webDir, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const modelsSrc = join(repoRoot, "data", "gesture", "models");
const models = ["hand_landmarker.task", "face_landmarker.task"];

if (!existsSync(wasmSrc)) {
  throw new Error(`missing MediaPipe wasm dir: ${wasmSrc} (run pnpm install)`);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, "mediapipe"), { recursive: true });
mkdirSync(join(outDir, "models"), { recursive: true });

cpSync(wasmSrc, join(outDir, "mediapipe"), { recursive: true });

for (const model of models) {
  const src = join(modelsSrc, model);
  if (!existsSync(src)) {
    throw new Error(`missing model: ${src} (run: just download-model)`);
  }
  cpSync(src, join(outDir, "models", model));
}

console.log(`vendored embed assets -> ${outDir}`);
