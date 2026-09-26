/* HTTP composition: request log, health, Access JWT on every other route,
 * /mcp for agents, /api/v1 for the extension, and one error mapping. No CORS
 * headers: the only browser caller is the extension's service worker, which
 * relies on host_permissions instead. */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as z from "zod";
import { Unauthorized, type AccessVerifier, type Identity } from "../auth/access-jwt.ts";
import { HubRefused, HubUnreachable } from "../hub.ts";
import type { McpEndpoint } from "../mcp/mcp-endpoint.ts";
import { Conflict, InvalidInput, NotFound, type AnnotationService } from "../service/annotations.ts";
import { restRoutes } from "./rest.ts";

export type AppEnv = { Variables: { identity: Identity } };

export interface AppDeps {
  service: AnnotationService;
  verify: AccessVerifier;
  mcp: McpEndpoint;
  mcpAllowedOrigins: string[];
  log: (line: Record<string, unknown>) => void;
}

const MCP_BODY_LIMIT = 1024 * 1024;
const API_BODY_LIMIT = 12 * 1024 * 1024; // base64 screenshot up to 8 MB plus coverage

function tooLarge(): Response {
  return Response.json({ error: "request body too large" }, { status: 413 });
}

function describe(who: Identity | undefined): string | undefined {
  if (!who) return undefined;
  return who.kind === "user" ? who.email : `service:${who.clientId}`;
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const start = performance.now();
    await next();
    deps.log({ method: c.req.method, path: c.req.path, status: c.res.status, ms: Math.round(performance.now() - start), who: describe(c.get("identity")) });
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.use("*", async (c, next) => {
    c.set("identity", await deps.verify(c.req.header("cf-access-jwt-assertion")));
    await next();
  });

  app.all("/mcp", bodyLimit({ maxSize: MCP_BODY_LIMIT, onError: () => tooLarge() }), async (c): Promise<Response> => {
    const origin = c.req.header("origin");
    if (origin && !deps.mcpAllowedOrigins.includes(origin)) return Response.json({ error: "origin not allowed" }, { status: 403 });
    return deps.mcp.fetch(c.req.raw);
  });

  app.use("/api/v1/*", bodyLimit({ maxSize: API_BODY_LIMIT, onError: () => tooLarge() }));
  app.route("/api/v1", restRoutes(deps.service));

  app.notFound((c) => c.json({ error: "not found" }, 404));

  app.onError((err, c) => {
    if (err instanceof Unauthorized) return c.json({ error: err.message }, 401);
    if (err instanceof NotFound) return c.json({ error: err.message }, 404);
    if (err instanceof Conflict) return c.json({ error: err.message }, 409);
    if (err instanceof z.ZodError) return c.json({ error: "invalid request", issues: err.issues }, 400);
    if (err instanceof SyntaxError) return c.json({ error: "invalid JSON body" }, 400);
    if (err instanceof InvalidInput) return c.json({ error: err.message }, 400);
    // The hub said no, in words meant for the reader, so those words go back verbatim: a stale
    // recipient pick is theirs to fix, not a server fault to report as one.
    if (err instanceof HubRefused) return c.json({ error: err.message }, 400);
    // The hub is unreachable or our own token is wrong. 502 says the fault is upstream, and the
    // message names which credential, so the log is enough to act on.
    if (err instanceof HubUnreachable) {
      deps.log({ level: "error", path: c.req.path, hub: err.message });
      return c.json({ error: err.message }, 502);
    }
    deps.log({ level: "error", path: c.req.path, error: err.stack ?? String(err) });
    return c.json({ error: "internal error" }, 500);
  });

  return app;
}
