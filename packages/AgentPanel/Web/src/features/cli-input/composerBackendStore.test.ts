import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_COMPOSER_BACKEND,
  loadComposerBackend,
  resolveComposerBackend,
  storeComposerBackend,
} from "./composerBackendStore";

describe("the remembered preference", () => {
  beforeEach(() => localStorage.clear());

  it("opens on the terminal, because it is the backend that degrades honestly", () => {
    // The window band needs a window AND a helper. Where either is missing it used to offer a dead
    // field reading "helper-unavailable", which is the case the terminal backend was built for.
    expect(DEFAULT_COMPOSER_BACKEND).toBe("terminal");
    expect(loadComposerBackend()).toBe("terminal");
  });

  it("remembers a choice across visits", () => {
    storeComposerBackend("window");
    expect(loadComposerBackend()).toBe("window");
    storeComposerBackend("terminal");
    expect(loadComposerBackend()).toBe("terminal");
  });

  it("falls back rather than selecting a band that does not exist", () => {
    localStorage.setItem("agent-panel.composer.backend", "carrier-pigeon");
    expect(loadComposerBackend()).toBe("terminal");
  });
});

describe("what actually renders", () => {
  it("honours the terminal preference when the session has a pane", () => {
    expect(resolveComposerBackend("terminal", { tmuxSession: "keyboard" })).toBe("terminal");
  });

  it("falls back to the window band when there is no pane to attach to", () => {
    expect(resolveComposerBackend("terminal", { tmuxSession: null })).toBe("window");
  });

  it("never overrides an explicit window preference", () => {
    expect(resolveComposerBackend("window", { tmuxSession: "keyboard" })).toBe("window");
  });

  it("leaves the stored preference alone when it falls back", () => {
    // The fallback is per session, not a rewrite: someone who prefers the terminal and opens one
    // session without a pane must still get the terminal for the next session that has one.
    localStorage.clear();
    storeComposerBackend("terminal");
    expect(resolveComposerBackend(loadComposerBackend(), { tmuxSession: null })).toBe("window");
    expect(loadComposerBackend()).toBe("terminal");
  });
});
