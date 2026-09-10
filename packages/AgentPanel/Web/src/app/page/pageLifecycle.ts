interface PageLifecycleBridge {
  endActiveTerminalContext(): void;
  destroy(): void;
}

export function installPagehideLifecycle(bridge: PageLifecycleBridge): {
  remove(): void;
} {
  const onPagehide = () => {
    bridge.endActiveTerminalContext();
    bridge.destroy();
  };
  window.addEventListener("pagehide", onPagehide);
  return {
    remove: () => window.removeEventListener("pagehide", onPagehide),
  };
}
