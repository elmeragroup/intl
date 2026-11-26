import { describe, expect, it } from "vitest";

import { docsSegments } from "../src/lib/pages";

// Unit under test: docsSegments, which turns each docs page's address into the catch-all its Open Graph image
// prerenders at. Oracle: the route layout itself, `/og/docs/[[...path]]` under `/og` beside `/docs`, so a page at
// `/docs/a/b` has the segments ["a", "b"] and `/docs` none, written out. The e2e specs reach only `/docs`, the one
// page there is; a nested page's image would 404 on an off-by-one here.
describe("docsSegments", () => {
  it.each([
    ["/docs", []],
    ["/docs/guides", ["guides"]],
    ["/docs/guides/next", ["guides", "next"]],
  ] as const)("gives %s the segments %o", (href, segments) => {
    expect(docsSegments(href)).toEqual(segments);
  });
});
