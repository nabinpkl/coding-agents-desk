/* /api/v1: the extension's REST surface. Every call acts as "user". Inputs are
 * validated with the shared zod schemas; errors map in app.ts. */
import { Hono } from "hono";
import * as z from "zod";
import { NewAnnotation, ReplyInput, ScreenshotUpload, Status } from "../../../shared/annotation.ts";
import { SendQuery, SendRequest } from "../../../shared/send.ts";
import type { AnnotationService } from "../service/annotations.ts";
import type { AppEnv } from "./app.ts";

const IdParam = z.coerce.number().int().positive();
const ListQuery = z.object({ url: z.string().optional(), status: Status.optional() });
const ClearQuery = z.object({ url: z.string().min(1) });

export function restRoutes(service: AnnotationService): Hono<AppEnv> {
  const api = new Hono<AppEnv>();

  api.get("/annotations", (c) => {
    const q = ListQuery.parse(c.req.query());
    return c.json(service.list({ url: q.url || undefined, status: q.status }));
  });

  api.post("/annotations", async (c) => {
    const input = NewAnnotation.parse(await c.req.json());
    return c.json(service.add(input), 201);
  });

  api.delete("/annotations", (c) => {
    const q = ClearQuery.parse(c.req.query());
    return c.json({ removed: service.clearByUrl(q.url) });
  });

  api.delete("/annotations/:id", (c) => {
    service.remove(IdParam.parse(c.req.param("id")));
    return c.body(null, 204);
  });

  api.post("/annotations/:id/resolve", (c) => c.json(service.resolve(IdParam.parse(c.req.param("id")), "user")));

  api.post("/annotations/:id/reopen", (c) => c.json(service.reopen(IdParam.parse(c.req.param("id")), "user")));

  api.post("/annotations/:id/replies", async (c) => {
    const { text } = ReplyInput.parse(await c.req.json());
    return c.json(service.reply(IdParam.parse(c.req.param("id")), "user", text), 201);
  });

  api.put("/annotations/:id/screenshot", async (c) => {
    const id = IdParam.parse(c.req.param("id"));
    const up = ScreenshotUpload.parse(await c.req.json());
    const bytes = new Uint8Array(Buffer.from(up.dataBase64, "base64"));
    return c.json(service.attachScreenshot(id, { mime: up.mime, bytes, coverage: up.coverage }));
  });

  api.get("/annotations/:id/screenshot", (c) => {
    const shot = service.getScreenshot(IdParam.parse(c.req.param("id")));
    return c.body(new Uint8Array(shot.bytes), 200, { "content-type": shot.mime, "cache-control": "private, max-age=300" });
  });

  // ----- Send -----

  api.get("/recipients", async (c) => c.json(await service.recipients()));

  api.post("/send", async (c) => {
    const { ids, to } = SendRequest.parse(await c.req.json());
    return c.json(await service.send(ids, to), 201);
  });

  api.get("/sends", async (c) => {
    const { ids } = SendQuery.parse(c.req.query());
    return c.json(await service.sends(ids));
  });

  return api;
}
