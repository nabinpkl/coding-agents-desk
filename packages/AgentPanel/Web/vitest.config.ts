import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { panelReact } from "./src/app/dev-server/panelReact";

const xtermPackage = fileURLToPath(
  new URL("../../../terminal/vendor/xterm/package", import.meta.url),
);
const agentFeedWire = fileURLToPath(
  new URL("../../../agent-feed/wire/index.ts", import.meta.url),
);
const panelSource = fileURLToPath(new URL("./src/", import.meta.url));
const repositoryRootDir = fileURLToPath(new URL("../../../", import.meta.url));

export default defineConfig({
  plugins: [panelReact(), tailwindcss()],
  resolve: {
    alias: {
      // Keyed with the trailing slash on purpose: a bare "@" would also match
      // "@agentdesk/agent-feed-wire" and swallow the wire contract.
      "@/": panelSource,
      "@repo/": repositoryRootDir,
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
