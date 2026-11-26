import { describe, expect, it } from "vitest";

import { parseSiteOrigin } from "../src/lib/site-origin";

// Unit under test: parseSiteOrigin, which every absolute og:image URL resolves against. Oracle: the origins the
// WHATWG URL standard gives for each input, written out, and the rule the module states: unset falls back to localhost
// on the port parsePort reads from PORT (test/port.test.ts holds that reading), whose refusal it passes on, and
// anything but a bare http(s) origin is refused with its reason.
describe("parseSiteOrigin", () => {
  it.each([
    [{}, "http://localhost:3033/"],
    [{ DOCS_ORIGIN: "" }, "http://localhost:3033/"],
    [{ PORT: "3042" }, "http://localhost:3042/"],
    [{ DOCS_ORIGIN: "https://docs.example.com", PORT: "3042" }, "https://docs.example.com/"],
    [{ DOCS_ORIGIN: "https://docs.example.com/" }, "https://docs.example.com/"],
    [{ DOCS_ORIGIN: "http://localhost:3999" }, "http://localhost:3999/"],
    // The URL parser lowercases the host and drops a scheme's default port.
    [{ DOCS_ORIGIN: "HTTPS://Docs.Example.com:443" }, "https://docs.example.com/"],
  ])("takes %o as %s", (env, origin) => {
    const result = parseSiteOrigin(env);

    expect(result._tag === "ok" ? result.value.href : result.error.message).toBe(origin);
  });

  it("refuses the localhost fallback on a PORT that is not a port", () => {
    const result = parseSiteOrigin({ PORT: "eighty" });

    expect(result._tag === "err" ? result.error._tag : result.value.href).toBe("InvalidPort");
  });

  // A set origin does not read PORT.
  it("takes DOCS_ORIGIN whatever PORT holds", () => {
    const result = parseSiteOrigin({ DOCS_ORIGIN: "https://docs.example.com", PORT: "eighty" });

    expect(result._tag === "ok" ? result.value.href : result.error.message).toBe("https://docs.example.com/");
  });

  it.each([
    ["docs.example.com", "unparsable"],
    ["ftp://docs.example.com", "protocol"],
    ["https://docs.example.com/docs", "not-an-origin"],
    ["https://docs.example.com/?preview=1", "not-an-origin"],
    ["https://docs.example.com/#top", "not-an-origin"],
    ["https://user:secret@docs.example.com", "not-an-origin"],
  ])("refuses %s as %s", (input, reason) => {
    const result = parseSiteOrigin({ DOCS_ORIGIN: input });

    expect(
      result._tag === "err" && result.error._tag === "InvalidSiteOrigin"
        ? [result.error.input, result.error.reason]
        : result._tag
    ).toEqual([input, reason]);
  });
});
