// The system group's handlers: what tells a caller this process is up.
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as GroupApi from "@/api/GroupApi";

export const layer = HttpApiBuilder.group(GroupApi.GroupApi, "system", (handlers) =>
  handlers.handle("health", () => Effect.succeed({ status: "ok" as const })),
);
