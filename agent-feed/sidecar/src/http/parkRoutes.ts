// `GET  /api/park/state`   -- what the Desktops currently hold.
// `GET  /api/park/plan`    -- where a park would put everything, and whether that plan holds up.
// `POST /api/park`         -- gather, re-read the order, lay the ladder.
// `POST /api/park/restore` -- put everything back where the manifest says it came from.
// `POST /api/park/grid`    -- spread windows across one display as a board.
//
// Not under `/api/sessions/`: a Desktop is a fact about the machine, not about a
// thread, which is the same reason `/api/usage` sits at the top level.
//
// The two GETs are read-only. The two POSTs move windows, so they require an
// explicit `{"confirm": true}` body: parking is a durable rearrangement of
// someone's entire workspace, and a request that reaches this endpoint by
// accident must do nothing. `{"app": "..."}` narrows it to one application,
// which is how this gets tried on two windows before it is tried on twenty.
//
// The interesting property of this file is how little it is: every fact below
// comes from one `yabai` subprocess, and the geometry is pure TypeScript. No
// native code is reached until something wants pixels.

import type {
  ParkMove,
  ParkPlanResponse,
  ParkStateResponse,
} from "@agentdesk/agent-feed-wire";
import { config } from "@/config/config";
import { packFromTopLeft, usableArea } from "@/park/grid";
import { plan as planLadder } from "@/park/ladder";
import { park, restore } from "@/park/park";
import {
  activeSpace,
  displays,
  moveTo,
  moveToSpace,
  parkable,
  resizeTo,
  spaces,
  windows,
  YabaiUnavailable,
} from "@/park/yabai";
import { jsonResponse } from "@/http/protocol/httpResponses";
import type { RouteHandler } from "@/http/protocol/route";

const STATE_ROUTE = "/api/park/state";
const PLAN_ROUTE = "/api/park/plan";
const PARK_ROUTE = "/api/park";
const RESTORE_ROUTE = "/api/park/restore";
const GRID_ROUTE = "/api/park/grid";

// macOS refuses to place a window under the menu bar, so a grid computed
// against the raw display frame has its whole top row clamped downward into the
// second. Measured on this desk: a window pushed to y=0 lands at y=39.
const MENU_BAR_INSET = 40;
// Wide enough to read as deliberate separation on a desk measured in thousands
// of points, narrow enough not to waste a column.
const SLOT_GAP = 24;
// What a window is allowed to be on the board, whatever size it happens to remember.
//
// A remembered size is the wrong input here: a window that was once dragged huge, or that this
// endpoint itself once stretched, arrives claiming thousands of points and pushes everything else
// off the desk. This is Claude's own default and five of them fit across a 7680pt desk with the
// gaps. A window smaller than this keeps its size; only the oversized are brought back.
const DEFAULT_MAX_WIDTH = 1200;
const DEFAULT_MAX_HEIGHT = 800;

interface ParkRequestBody {
  confirm?: unknown;
  app?: unknown;
  dryRun?: unknown;
  /** Grid only: which display, which windows, and how far apart. */
  display?: unknown;
  ids?: unknown;
  count?: unknown;
  gap?: unknown;
}

async function body(request: Request): Promise<ParkRequestBody> {
  try {
    const parsed = await request.json();
    return parsed && typeof parsed === "object" ? (parsed as ParkRequestBody) : {};
  } catch {
    return {};
  }
}

function unconfirmed(): Response {
  return jsonResponse(
    {
      code: "park-unconfirmed",
      message: 'this endpoint moves windows; send {"confirm": true} to proceed',
    },
    400,
  );
}

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
  const payload: ParkStateResponse = {
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
  };
  return jsonResponse(payload);
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
  const payload: ParkPlanResponse = {
    activeSpace: space,
    display: screen,
    options: { strip: config.parkStrip, step: config.parkStep, topMargin: config.parkTopMargin },
    // A plan is sound when nothing is starved. `starved` being non-empty means
    // the arithmetic produced a window that would stop rendering, which is a bug
    // in the plan rather than a cost to accept.
    sound: laid.starved.length === 0,
    overflow: laid.overflow,
    starved: laid.starved.map((p) => p.id),
    moves: laid.placements.map((p): ParkMove => {
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
  };
  return jsonResponse(payload);
}

async function parkResponse(request: Request): Promise<Response> {
  const input = await body(request);
  const dryRun = input.dryRun === true;
  // A dry run touches nothing, so it does not need the confirmation that a real
  // park does.
  if (!dryRun && input.confirm !== true) return unconfirmed();
  const app = typeof input.app === "string" && input.app.trim() !== "" ? input.app.trim() : undefined;
  return jsonResponse(await park({ app, dryRun }));
}

async function restoreResponse(request: Request): Promise<Response> {
  const input = await body(request);
  if (input.confirm !== true) return unconfirmed();
  return jsonResponse(await restore());
}

/**
 * Spread windows across one display as a board.
 *
 * The ladder's counterpart, and the reason `moveTo` and `resizeTo` both verify:
 * a window with a minimum size of its own answers a slot-sized request with its
 * own floor while yabai still exits 0, so "placed" has to mean observed, not
 * requested.
 */
async function gridResponse(request: Request): Promise<Response> {
  const input = await body(request);
  if (input.confirm !== true) return unconfirmed();

  const [all, screens, allSpaces] = await Promise.all([windows(), displays(), spaces()]);
  const candidates = parkable(all);

  // Defaults to the largest display rather than to an index, because the desk
  // this exists for is a big panel beside a small one and an index moves when a
  // display is unplugged.
  const requested = typeof input.display === "number" ? input.display : null;
  const screen = requested !== null
    ? screens.find((d) => d.index === requested)
    : [...screens].sort((a, b) => b.frame.w * b.frame.h - a.frame.w * a.frame.h)[0];
  if (!screen) {
    return jsonResponse(
      { code: "park-no-such-display", message: `no display ${requested}`, displays: screens },
      400,
    );
  }

  const target = allSpaces.find((s) => s.display === screen.index);
  if (!target) {
    return jsonResponse(
      { code: "park-no-space", message: `display ${screen.index} has no Space to move windows to` },
      400,
    );
  }

  const ids = Array.isArray(input.ids) ? input.ids.filter((id) => typeof id === "number") : [];
  const limit = typeof input.count === "number" ? input.count : candidates.length;
  const chosen = ids.length > 0
    ? ids.flatMap((id) => candidates.filter((w) => w.id === id))
    : candidates.slice(0, limit);
  if (chosen.length === 0) {
    return jsonResponse(
      {
        code: "park-nothing-to-place",
        message: "no windows matched",
        tracked: all.length,
        parkable: candidates.length,
      },
      400,
    );
  }

  const gap = typeof input.gap === "number" ? input.gap : SLOT_GAP;
  const area = usableArea(screen.frame, MENU_BAR_INSET);
  // Reading order of where the windows already are, not the stacking order yabai returns.
  // Stacking changes every time something is clicked, so packing by it would rearrange the whole
  // board on a focus change; position is stable, and re-packing then preserves the order already
  // on screen instead of shuffling it.
  chosen.sort((a, b) => a.frame.y - b.frame.y || a.frame.x - b.frame.x);
  let slots;
  try {
    // Packed at the windows' own sizes, so the space between two of them is the
    // gap. Dividing the display evenly instead put an 860pt terminal at the
    // top-left of a 2528pt cell and left 1600pt of desk between neighbours.
    slots = packFromTopLeft(area, chosen.map((w) => ({
      w: Math.min(w.frame.w, DEFAULT_MAX_WIDTH),
      h: Math.min(w.frame.h, DEFAULT_MAX_HEIGHT),
    })), gap);
  } catch (error) {
    return jsonResponse(
      { code: "park-grid-impossible", message: (error as Error).message },
      400,
    );
  }

  // Serially, because every step re-queries the window to see where it actually
  // landed; overlapping that with other moves would verify against a desk that
  // is still changing underneath the read.
  const placements = [];
  for (const [index, window] of chosen.entries()) {
    const slot = slots[index]!;
    // The packer already sized the slot to the window, shrinking it only if it
    // was too big for the desk, so the slot is the placement.
    const { x, y, w: width, h: height } = slot;
    const shrinks = width !== window.frame.w || height !== window.frame.h;

    const steps = [];
    if (window.space !== target.index) steps.push(await moveToSpace(window.id, target.index));
    steps.push(await moveTo(window.id, x, y));
    if (shrinks) {
      // Measured on this desk: a window resized while it still stands on the
      // display it came from is clamped to that display (2104pt asked, 754pt
      // given), so the move above has to land first. A resize is anchored at
      // the origin, so the move is repeated after it.
      steps.push(await resizeTo(window.id, width, height));
      steps.push(await moveTo(window.id, x, y));
    }
    const final = steps[steps.length - 1]!;
    placements.push({
      id: window.id,
      app: window.app,
      title: window.title,
      slot,
      requested: { x, y, w: width, h: height },
      observed: final.observed?.frame ?? null,
      ok: steps.every((step) => step.ok),
      reasons: steps.flatMap((step) => (step.reason ? [step.reason] : [])),
    });
  }

  return jsonResponse({
    display: screen.index,
    space: target.index,
    area,
    gap,
    placed: placements.filter((placement) => placement.ok).length,
    placements,
  });
}

export function createParkRoutes(): RouteHandler {
  // Deliberately not an async function: the "not my route" answer is `undefined`
  // and must be returned synchronously, so only the matched paths become a
  // promise.
  return (request, url) => {
    const isGet = request.method === "GET"
      && (url.pathname === STATE_ROUTE || url.pathname === PLAN_ROUTE);
    const isPost = request.method === "POST"
      && (url.pathname === PARK_ROUTE || url.pathname === RESTORE_ROUTE
        || url.pathname === GRID_ROUTE);
    if (!isGet && !isPost) return undefined;
    if (!config.yabaiPath) {
      return unavailable(new YabaiUnavailable("no yabai binary found on this machine"));
    }
    let work: Promise<Response>;
    if (url.pathname === STATE_ROUTE) work = state();
    else if (url.pathname === PLAN_ROUTE) work = planResponse(url);
    else if (url.pathname === PARK_ROUTE) work = parkResponse(request);
    else if (url.pathname === GRID_ROUTE) work = gridResponse(request);
    else work = restoreResponse(request);
    return work.catch(unavailable);
  };
}
