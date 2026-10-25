// Group's entry point, the one place its program is run (group-effect skill, "Two lifetimes").
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as Layer from "effect/Layer";
import * as GroupConfig from "@/config/GroupConfig";
import * as GroupHttp from "@/http/GroupHttp";

GroupHttp.layer.pipe(
  Layer.provide(BunHttpServer.layerConfig(GroupConfig.serverOptions)),
  Layer.launch,
  BunRuntime.runMain,
);
