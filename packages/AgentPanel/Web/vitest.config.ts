import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const xtermPackage = fileURLToPath(
  new URL("../../../terminal/vendor/xterm/package", import.meta.url),
);
const agentFeedWire = fileURLToPath(
  new URL("../../../agent-feed/wire/index.ts", import.meta.url),
);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@agentdesk/agent-feed-wire": agentFeedWire,
      "@xterm/xterm": xtermPackage,
    },
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    globals: true,
    setupFiles: ["src/app/testSetup.ts"],
  },
});
