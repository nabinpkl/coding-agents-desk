import assert from "node:assert/strict";
import { test } from "node:test";
import { apiUrlOn } from "../../extension/src/apiUrl.ts";

const SERVER = "https://annotator.example.com";
const apiUrl = (path: string) => apiUrlOn(SERVER, path);

test("an API path resolves on the annotator server", () => {
  assert.equal(apiUrl("/api/v1/annotations?url=https%3A%2F%2Fa.test").href, `${SERVER}/api/v1/annotations?url=https%3A%2F%2Fa.test`);
  assert.equal(apiUrl("/api/v1/annotations/7/screenshot").pathname, "/api/v1/annotations/7/screenshot");
});

test("a path that would carry the token anywhere else is refused", () => {
  for (const path of [
    "@evil.test/api/v1/x", // userinfo: https://annotator.example.com@evil.test/...
    "//evil.test/api/v1/x", // protocol-relative
    "https://evil.test/api/v1/x",
    "/api/v1/../../x", // climbs out of the API
    "/api/v1/annotations/../../../send",
    "/mcp",
    "",
  ]) {
    assert.throws(() => apiUrl(path), /refusing/, path);
  }
});
