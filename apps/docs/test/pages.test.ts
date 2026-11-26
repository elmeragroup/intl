import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { DOCS_PAGES, docsSegments } from "../src/lib/pages";

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

// Unit under test: the page list in src/lib/pages.ts, which the side nav, each page's metadata and the Open Graph
// routes read. Oracle: the docs route group on disk, where each `page.mdx` is a page at its directory's path, route
// groups (`(name)`) left out, as Next's App Router maps it. A route renamed without its entry, or an entry whose route
// is gone, fails here rather than as a nav link to a 404 or a page with no card.
describe("the docs page list", () => {
  const DOCS_ROUTES = fileURLToPath(new URL("../src/app/(docs)", import.meta.url));

  it("names exactly the page.mdx routes under src/app/(docs)", () => {
    const routes = readdirSync(DOCS_ROUTES, { recursive: true, encoding: "utf8" })
      .filter((path) => path === "page.mdx" || path.endsWith("/page.mdx"))
      .map(
        (path) =>
          `/${path
            .split("/")
            .slice(0, -1)
            .filter((segment) => !/^\(.*\)$/u.test(segment))
            .join("/")}`
      );

    expect(DOCS_PAGES.map((page) => page.href).toSorted()).toEqual(routes.toSorted());
  });
});
