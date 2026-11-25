import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";
import { afterAll, describe, expect, it } from "vitest";

import { varyBy } from "../src/http-vary.ts";
import { Catalogs } from "../src/intl/catalogs.ts";
import { ApiRoutes } from "../src/server.ts";

// The field names a `Vary` value lists, lowercased, as a sorted multiset: field names compare case-insensitively
// (RFC 9110 §5.1), and a list's order carries no meaning for `Vary`, but a name listed twice counts twice.
function fieldNames(vary: string | null): ReadonlyArray<string> {
  return (vary ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== "")
    .toSorted();
}

// Unit under test: varyBy, which the intl middleware runs on every response's `Vary`. Oracle: RFC 9110 §12.5.5, `Vary`
// is `*` or a list of field names, and §5.1, field names compare case-insensitively; stated per row as the names the
// result lists, each as many times as it may appear.
describe("varyBy", () => {
  it.each([
    { existing: undefined, names: ["accept-language"], why: "no Vary yet: the one name" },
    { existing: "", names: ["accept-language"], why: "an empty Vary: the one name" },
    { existing: "Origin", names: ["accept-language", "origin"], why: "another name: both" },
    {
      existing: "Origin,Accept-Encoding",
      names: ["accept-encoding", "accept-language", "origin"],
      why: "two names: all three",
    },
    {
      existing: "accept-language",
      names: ["accept-language"],
      why: "the name in another case: no second copy",
    },
    {
      existing: "Origin, ACCEPT-LANGUAGE",
      names: ["accept-language", "origin"],
      why: "the name among others: no second copy",
    },
    { existing: "*", names: ["*"], why: "`*` varies by everything already" },
  ])("$why: $existing → $names", ({ existing, names }) => {
    expect(fieldNames(varyBy(existing, "Accept-Language"))).toEqual(names);
  });
});

// Unit under test: the intl middleware's `Vary` on a response another layer already varies: the API's routes with
// effect's CORS middleware for one allowed origin, which sends `Vary: Origin` (the Fetch standard's "CORS protocol and
// HTTP caches" asks it of a response whose Access-Control-Allow-Origin depends on the request's Origin), run in
// process.
// Oracle: RFC 9110 §12.5.5, a response that varies by both headers names both.
describe("a response that already varies", () => {
  const app = HttpRouter.toWebHandler(
    Layer.mergeAll(ApiRoutes, HttpRouter.cors({ allowedOrigins: ["https://portal.example"] })).pipe(
      Layer.provide(Catalogs.layer),
      Layer.provide(HttpServer.layerServices)
    ),
    { disableLogger: true }
  );

  afterAll(() => app.dispose());

  it("keeps Origin and adds Accept-Language", async () => {
    const response = await app.handler(
      new Request("http://localhost/greeting?name=Ingrid", {
        headers: { origin: "https://portal.example", "accept-language": "sv" },
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://portal.example");
    expect(fieldNames(response.headers.get("vary"))).toEqual(["accept-language", "origin"]);
  });
});
