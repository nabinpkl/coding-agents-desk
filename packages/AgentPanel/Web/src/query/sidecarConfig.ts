// The sidecar's process-global facts -- whether summaries are on, how a machine opens a shell,
// whether the desktop park exists -- read once per data source and shared by every surface that
// asks, instead of each asking on its own.

import type { SidecarConfig } from "@agentdesk/agent-feed-wire";
import { sourceKey, usePanelQuery } from "@/query/panelQuery";

export function useSidecarConfig(feed: { fetchConfig(): Promise<SidecarConfig> }) {
  return usePanelQuery({
    queryKey: ["sidecar-config", sourceKey(feed)],
    // Asked again by each surface that mounts, as each did on its own before, since a restarted
    // sidecar can answer differently; what was read last shows meanwhile.
    queryFn: () => feed.fetchConfig(),
  });
}
