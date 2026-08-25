// `GET /api/park/state` -- what the Desktops currently hold.
// `GET /api/park/plan`  -- where a park would put everything, and whether that plan holds up.
//
// Not under `/api/sessions/`: a Desktop is a fact about the machine, not about a
// thread, which is the same reason `/api/usage` sits at the top level.
//
// Both are READ-ONLY. Nothing here moves a window. Parking is a durable
// rearrangement of someone's entire workspace and it needs the manifest landed
// first, so the mutation lives behind its own route and its own confirmation.
//
// The interesting property of this file is how little it is: every fact below
// comes from one `yabai` subprocess, and the geometry is pure TypeScript. No
// native code is reached until something wants pixels.

import { config } from "../config.ts";
import { plan as planLadder } from "../park/ladder.ts";
import { activeSpace, displays, parkable, windows, YabaiUnavailable } from "../park/yabai.ts";
import { jsonResponse } from "./httpResponses.ts";
import type { RouteHandler } from "./route.ts";

const STATE_ROUTE = "/api/park/state";
const PLAN_ROUTE = "/api/park/plan";

function unavailable(error: unknown): Response {
  return jsonResponse(
    {
      code: "park-unavailable",
      message: error instanceof Error ? error.message : String(error),
      yabaiPath: config.yabaiPath,
    },
    503,
  );
}

async function state(): Promise<Response> {
  const [all, space, screens] = await Promise.all([windows(), activeSpace(), displays()]);
  const candidates = parkable(all);
  return jsonResponse({
    yabaiPath: config.yabaiPath,
    activeSpace: space,
    displays: screens,
    // Ordering is preserved from yabai, which returns front-to-back. The ladder
    // depends on that, so it travels rather than being re-derived downstream.
    stackingOrder: candidates.map((w) => w.id),
    counts: {
      tracked: all.length,
      parkable: candidates.length,
      alreadyHere: candidates.filter((w) => w.space === space.index).length,
      elsewhere: candidates.filter((w) => w.space !== space.index).length,
    },
    windows: candidates.map((w) => ({
      id: w.id,
      app: w.app,
      title: w.title,
      pid: w.pid,
      space: w.space,
      display: w.display,
      frame: w.frame,
      onActiveSpace: w.space === space.index,
      isVisible: w.isVisible,
    })),
  });
}

async function planResponse(url: URL): Promise<Response> {
  const [all, space, screens] = await Promise.all([windows(), activeSpace(), displays()]);
  const screen = screens.find((d) => d.index === space.display) ?? screens[0];
  if (!screen) return unavailable(new Error("yabai reported no displays"));

  // `?app=` narrows the park to one application, which is how this gets tried on
  // two codex windows before it is tried on a whole workspace.
  const appFilter = url.searchParams.get("app")?.toLowerCase() ?? null;
  const candidates = parkable(all).filter(
    (w) => !appFilter || w.app.toLowerCase().includes(appFilter),
  );

  const laid = planLadder(
    candidates.map((w) => ({ id: w.id, frame: w.frame })),
    {
      display: screen.frame,
      strip: config.parkStrip,
      step: config.parkStep,
      topMargin: config.parkTopMargin,
    },
  );

  const byId = new Map(candidates.map((w) => [w.id, w]));
  return jsonResponse({
    activeSpace: space,
    display: screen,
    options: { strip: config.parkStrip, step: config.parkStep, topMargin: config.parkTopMargin },
    // A plan is sound when nothing is starved. `starved` being non-empty means
    // the arithmetic produced a window that would stop rendering, which is a bug
    // in the plan rather than a cost to accept.
    sound: laid.starved.length === 0,
    overflow: laid.overflow,
    starved: laid.starved.map((p) => p.id),
    moves: laid.placements.map((p) => {
      const w = byId.get(p.id)!;
      return {
        id: p.id,
        app: w.app,
        title: w.title,
        side: p.side,
        depth: p.depth,
        rung: p.rung,
        from: { space: w.space, x: w.frame.x, y: w.frame.y },
        to: { space: space.index, x: p.x, y: p.y },
        exposedPt2: p.exposed,
        // Nothing to do when it is already there. Worth surfacing, because the
        // cheapest park is the one that moves the fewest windows.
        noop: w.space === space.index && w.frame.x === p.x && w.frame.y === p.y,
      };
    }),
  });
}

export function createParkRoutes(): RouteHandler {
  // Deliberately not an async function: the "not my route" answer is `undefined`
  // and must be returned synchronously, so only the matched paths become a
  // promise.
  return (request, url) => {
    if (request.method !== "GET") return undefined;
    if (url.pathname !== STATE_ROUTE && url.pathname !== PLAN_ROUTE) return undefined;
    if (!config.yabaiPath) {
      return unavailable(new YabaiUnavailable("no yabai binary found on this machine"));
    }
    return (url.pathname === STATE_ROUTE ? state() : planResponse(url)).catch(unavailable);
  };
}
