import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const distDir = fileURLToPath(new URL("./gesture-webview-dist", import.meta.url));

/**
 * The Vite entry is index.embed.html (so it never collides with the Next app);
 * the WKWebView scheme handler serves index.html. Rename after the bundle is
 * written.
 */
function renameEmbedIndex(): Plugin {
  return {
    name: "rename-embed-index",
    closeBundle() {
      const from = join(distDir, "index.embed.html");
      const to = join(distDir, "index.html");
      if (existsSync(from)) renameSync(from, to);
    },
  };
}

// base: "./" makes built JS/CSS references relative, which the custom scheme
// handler requires. publicDir copies the vendored MediaPipe assets to the
// bundle root (/mediapipe, /models).
export default defineConfig({
  plugins: [react(), tailwindcss(), renameEmbedIndex()],
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
      input: fileURLToPath(new URL("./index.embed.html", import.meta.url)),
    },
  },
});
