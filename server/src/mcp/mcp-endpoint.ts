/* Streamable HTTP endpoint for /mcp. A fresh McpServer is built per request
 * (stateless); createMcpHandler serves the current protocol revision and
 * falls back to stateless serving for 2025-era clients from the same tools. */
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { AnnotationService } from "../service/annotations.ts";
import { buildMcpServer } from "./tools.ts";

export type McpEndpoint = ReturnType<typeof createMcpHandler>;

export function createMcpEndpoint(service: AnnotationService, onerror: (e: Error) => void): McpEndpoint {
  return createMcpHandler(() => buildMcpServer(service), { onerror });
}
