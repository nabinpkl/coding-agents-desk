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

import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(webDir, "..");
const workspaceRoot = join(webDir, "..", "..");
const outDir = join(webDir, "embed-public");

const wasmSrc = join(webDir, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const modelsSrc = join(repoRoot, "data", "gesture", "models");
const models = ["hand_landmarker.task", "face_landmarker.task"];
const dictationMicSourceDirectory = join(
  workspaceRoot,
  "host",
  "AgentDeskHost",
  "Assets.xcassets",
  "DictationMic.imageset",
);
// The asset catalog's default is the dark mic for the light panel, while its
// dark-appearance variant is the light mic for dark panels. Preserve that
// established artwork mapping when the webview ships it as ordinary files.
const dictationMicAssets = [
  ["dictation_mic_dark_96.png", "dictation-mic.png"],
  ["dictation_mic_96.png", "dictation-mic-dark.png"],
];

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

for (const [sourceName, targetName] of dictationMicAssets) {
  const src = join(dictationMicSourceDirectory, sourceName);
  if (!existsSync(src)) {
    throw new Error(`missing DictationMic artwork: ${src}`);
  }
  copyFileSync(src, join(outDir, targetName));
}

console.log(`vendored embed assets -> ${outDir}`);
