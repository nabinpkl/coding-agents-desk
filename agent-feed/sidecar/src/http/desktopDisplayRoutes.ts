// `GET /api/desktop/display` gives the first-party desktop viewer only the active display's
// geometry. It deliberately does not enumerate windows or compute a park plan: the viewer is a
// desktop surface, not another entrance into Desktop Park.

import type { DesktopDisplayResponse } from "@agentdesk/agent-feed-wire";
import { activeSpace, displays } from "../park/yabai.ts";
import { jsonResponse } from "./httpResponses.ts";
import type { RouteHandler } from "./route.ts";

const DISPLAY_ROUTE = "/api/desktop/display";

export interface DesktopDisplaySource {
  activeSpace: typeof activeSpace;
  displays: typeof displays;
}

const liveSource: DesktopDisplaySource = { activeSpace, displays };

async function displayResponse(source: DesktopDisplaySource): Promise<Response> {
  const [space, screens] = await Promise.all([source.activeSpace(), source.displays()]);
  const display = screens.find((candidate) => candidate.index === space.display) ?? screens[0];
  if (!display) throw new Error("yabai reported no displays");
  const payload: DesktopDisplayResponse = { display };
  return jsonResponse(payload);
}

function unavailable(error: unknown): Response {
  return jsonResponse(
    {
      code: "desktop-display-unavailable",
      message: error instanceof Error ? error.message : String(error),
    },
    503,
  );
}

export function createDesktopDisplayRoutes(source: DesktopDisplaySource = liveSource): RouteHandler {
  return (request, url) => {
    if (request.method !== "GET" || url.pathname !== DISPLAY_ROUTE) return undefined;
    return displayResponse(source).catch(unavailable);
  };
}
