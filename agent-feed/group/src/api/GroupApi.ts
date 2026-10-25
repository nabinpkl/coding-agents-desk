// Group's HTTP contract, the one definition the server, a typed client and the tests share
// (group-api-design skill). Endpoints are added here first; handlers implement what this declares.
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as OpenApi from "effect/http-api/OpenApi";
import * as Schema from "effect/Schema";

/** Every route is under this prefix; the panel routes it to this process. */
export const basePath = "/api/group";

/** Where the generated OpenAPI document is served. */
export const openApiPath = `${basePath}/openapi.json`;

export const Health = Schema.Struct({ status: Schema.Literal("ok") });

export class SystemGroup extends HttpApiGroup.make("system")
  .add(HttpApiEndpoint.get("health", "/health", { success: Health }))
  .prefix(basePath) {}

export class GroupApi extends HttpApi.make("group")
  .add(SystemGroup)
  .annotateMerge(OpenApi.annotations({ title: "Group", description: "The group chat tab's server process." })) {}
