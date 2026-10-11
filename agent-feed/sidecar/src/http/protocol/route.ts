import type { Server } from "bun";

export type RouteHandler = (
  request: Request,
  url: URL,
  server: Server<undefined>,
) => Response | Promise<Response> | undefined;
