/* The agent-facing MCP surface: seven tools over the annotation service.
 * Agents act as "agent"; the extension's REST calls act as "user". */
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { Status } from "../../../shared/annotation.ts";
import { NotFound, type AnnotationService } from "../service/annotations.ts";

export const SERVER_NAME = "agentdesk-annotator";
export const SERVER_VERSION = "1.0.0";
const P = SERVER_NAME;

const Id = z.number().int().positive().describe(`Annotation id from ${P}_list.`);
const UrlFilter = z.string().optional().describe("Substring filter on the recorded page URL.");

type ToolResult = { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; isError?: boolean };

function json(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/** A missing id is an expected agent mistake: answer with a tool error, not a protocol error. */
function guard(fn: () => ToolResult): ToolResult {
  try {
    return fn();
  } catch (e) {
    if (e instanceof NotFound) return { content: [{ type: "text", text: e.message }], isError: true };
    throw e;
  }
}

export function buildMcpServer(service: AnnotationService): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    `${P}_list`,
    {
      description:
        "List annotations, most recently updated first. Pass url (substring of the page URL) to scope to one site, and status open or resolved. Each record carries createdAt, updatedAt, and resolvedBy (agent versus user) so you can tell who marked it done.",
      inputSchema: z.object({ url: UrlFilter, status: Status.optional() }),
    },
    async ({ url, status }) => json(service.list({ url, status })),
  );

  server.registerTool(
    `${P}_get`,
    {
      description: "Full detail of one annotation: comment, selector, DOM path, styles, bounding box, replies.",
      inputSchema: z.object({ id: Id }),
    },
    async ({ id }) => guard(() => json(service.get(id))),
  );

  server.registerTool(
    `${P}_brief`,
    {
      description: "Markdown brief of open annotations for a URL, ready to work from. Omit url for everything open.",
      inputSchema: z.object({ url: UrlFilter }),
    },
    async ({ url }) => ({ content: [{ type: "text", text: service.brief(url) }] }),
  );

  server.registerTool(
    `${P}_screenshot`,
    {
      description: "Element screenshot plus a text summary of covered DOM nodes. Returns image content the agent sees directly.",
      inputSchema: z.object({ id: Id }),
    },
    async ({ id }) =>
      guard(() => {
        const shot = service.getScreenshot(id);
        return {
          content: [
            { type: "image", data: Buffer.from(shot.bytes).toString("base64"), mimeType: shot.mime },
            {
              type: "text",
              text: `Element screenshot for annotation ${id}. ${shot.coverage.items.length} of ${shot.coverage.scanned} covered nodes stored. Use ${P}_elements to filter the dump.`,
            },
          ],
        };
      }),
  );

  server.registerTool(
    `${P}_elements`,
    {
      description: "Bounded, filterable dump of DOM nodes covered by the element screenshot. Filter by substring or tag, cap with limit.",
      inputSchema: z.object({
        id: Id,
        contains: z.string().optional().describe("Substring matched against selector, tag, and text."),
        tag: z.string().optional().describe("Exact tag name, e.g. BUTTON."),
        limit: z.number().int().optional().describe("Max nodes returned, default 40, max 200."),
      }),
    },
    async ({ id, contains, tag, limit }) => guard(() => json(service.elements(id, { contains, tag, limit }))),
  );

  server.registerTool(
    `${P}_resolve`,
    {
      description:
        "Mark an annotation fixed after applying the change. Records resolvedBy as agent, distinct from a user resolution. The panel shows who resolved it. Optional message is stored as an agent reply shown in the panel.",
      inputSchema: z.object({ id: Id, message: z.string().optional().describe("Optional reply shown in the panel, e.g. what was fixed.") }),
    },
    async ({ id, message }) => guard(() => json(service.resolve(id, "agent", message || undefined))),
  );

  server.registerTool(
    `${P}_reopen`,
    {
      description:
        "Acknowledged but unresolved: optional why message stays on the item while it remains open. Use when confused or blocked instead of resolving.",
      inputSchema: z.object({ id: Id, message: z.string().optional().describe("Why it is unresolved, shown in the panel.") }),
    },
    async ({ id, message }) => guard(() => json(service.reopen(id, "agent", message || undefined))),
  );

  return server;
}
