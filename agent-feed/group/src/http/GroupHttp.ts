// Group's routes and the HTTP server that serves them, apart from which server that is: the entry
// point provides Bun's, and a test provides one on an ephemeral port.
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import * as GroupApi from "@/api/GroupApi";
import * as SystemHandlers from "@/http/SystemHandlers";

/** Every endpoint of the contract, and the OpenAPI document generated from it. */
export const routes = HttpApiBuilder.layer(GroupApi.GroupApi, { openapiPath: GroupApi.openApiPath }).pipe(
  Layer.provide(SystemHandlers.layer),
);

/** The routes served on whatever `HttpServer` the caller provides. */
export const layer = HttpRouter.serve(routes);
