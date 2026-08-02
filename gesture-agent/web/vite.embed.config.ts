import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const distDir = fileURLToPath(new URL("./gesture-webview-dist", import.meta.url));

/**
 * The Vite entries use an `.embed.html` suffix so they never collide with the
 * Next app. The WKWebView scheme handler serves the stable index.html and
 * dictation.html names after bundling.
 */
function renameEmbedEntries(): Plugin {
  return {
    name: "rename-embed-entries",
    closeBundle() {
      for (const [source, target] of [
        ["index.embed.html", "index.html"],
        ["dictation.embed.html", "dictation.html"],
      ]) {
        const from = join(distDir, source);
        const to = join(distDir, target);
        if (existsSync(from)) renameSync(from, to);
      }
    },
  };
}

// base: "./" makes built JS/CSS references relative, which the custom scheme
// handler requires. publicDir copies the vendored MediaPipe assets to the
// bundle root (/mediapipe, /models).
export default defineConfig({
  plugins: [react(), tailwindcss(), renameEmbedEntries()],
  base: "./",
  publicDir: "embed-public",
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    outDir: "gesture-webview-dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        interaction: fileURLToPath(new URL("./index.embed.html", import.meta.url)),
        dictation: fileURLToPath(new URL("./dictation.embed.html", import.meta.url)),
      },
    },
  },
});
