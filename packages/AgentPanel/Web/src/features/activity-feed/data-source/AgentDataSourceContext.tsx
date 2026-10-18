"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { AgentDataSource } from "@/features/activity-feed/data-source/AgentDataSource";

const DataSourceContext = createContext<AgentDataSource | null>(null);

export function DataSourceProvider({ children, source }: { children: ReactNode; source: AgentDataSource }) {
  return <DataSourceContext.Provider value={source}>{children}</DataSourceContext.Provider>;
}

export function useDataSource(): AgentDataSource {
  const ctx = useContext(DataSourceContext);
  if (ctx === null) {
    throw new Error("useDataSource must be used within DataSourceProvider");
  }
  return ctx;
}
