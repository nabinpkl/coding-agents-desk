import { expect } from "bun:test";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as Effect from "effect/Effect";
import * as HttpApiTest from "effect/http-api/HttpApiTest";
import * as OpenApi from "effect/http-api/OpenApi";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";
import * as GroupApi from "@/api/GroupApi";
import * as GroupHttp from "@/http/GroupHttp";
import * as SystemHandlers from "@/http/SystemHandlers";
import { it } from "@/testing/effectTest";

const handlers = Layer.mergeAll(SystemHandlers.layer, HttpServer.layerServices);

it.effect("the health endpoint answers ok", () =>
  Effect.gen(function* () {
    const client = yield* HttpApiTest.groups(GroupApi.GroupApi, ["system"]).pipe(Effect.provide(handlers));
    expect(yield* client.system.health()).toEqual({ status: "ok" });
  }),
);

it.effect("the OpenAPI document is generated from the contract", () =>
  Effect.sync(() => {
    const document = OpenApi.fromApi(GroupApi.GroupApi);
    expect(document.info.title).toBe("Group");
    expect(Object.keys(document.paths)).toContain("/api/group/health");
  }),
);

const served = GroupHttp.layer.pipe(Layer.provideMerge(BunHttpServer.layerTest));

it.live("Bun serves the health endpoint and the OpenAPI document under /api/group", () =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const health = yield* client.get("/api/group/health");
    expect(health.status).toBe(200);
    expect(yield* health.json).toEqual({ status: "ok" });
    const openApi = yield* client.get(GroupApi.openApiPath);
    expect(openApi.status).toBe(200);
    expect(yield* openApi.json).toMatchObject({ info: { title: "Group" } });
  }).pipe(Effect.provide(served)),
);

it.live("a path outside the contract is 404", () =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get("/api/group/nothing-here");
    expect(response.status).toBe(404);
  }).pipe(Effect.provide(served)),
);
