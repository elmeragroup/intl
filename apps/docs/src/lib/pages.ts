/**
 * The docs pages: one entry per `page.mdx` under `src/app/(docs)/docs`, in nav order. The side nav, each page's
 * metadata and its Open Graph image read this one list, so the three cannot describe a page differently, and the image
 * route prerenders exactly these pages.
 *
 * A new docs page is an `.mdx` route file and an entry here.
 */

/** A docs page's address: `/docs` itself or a path below it. */
export type DocsHref = "/docs" | `/docs/${string}`;

/** One docs page. */
export type DocsPage = {
  /** The page's address, which its route file's directory under `src/app/(docs)` spells. */
  readonly href: DocsHref;
  /** Its title: the nav label, the `<title>` and the subtitle on its Open Graph image. */
  readonly title: string;
};

/** The docs' first page, which the site header links to. */
export const DOCS_HOME = { href: "/docs", title: "Overview" } as const satisfies DocsPage;

/** Every docs page, in nav order. */
export const DOCS_PAGES: ReadonlyArray<DocsPage> = [DOCS_HOME];

/**
 * The docs page at an address.
 *
 * @param href - The address, such as a route's pathname.
 * @returns The page, or `undefined` when no docs page lives there.
 */
export function findDocsPage(href: string): DocsPage | undefined {
  return DOCS_PAGES.find((page) => page.href === href);
}

/**
 * The docs page a route file names itself by: its MDX resolves its record once, and takes its heading and metadata
 * from it.
 *
 * @param href - The route's own address.
 * @returns The page.
 * @throws {Error} When the list has no such page: a route file without an entry is a defect, and the throw fails
 *   `next build`.
 */
export function requireDocsPage(href: DocsHref): DocsPage {
  const page = findDocsPage(href);

  if (page === undefined) {
    throw new Error(`${href} has a route file but no entry in src/lib/pages.ts`);
  }

  return page;
}

/**
 * The path segments below `/docs` of a page's address: none for `/docs` itself. They are the catch-all of the page's
 * Open Graph route, `/og/docs/[[...path]]`.
 *
 * @param href - The page's address.
 * @returns The segments after `/docs`.
 */
export function docsSegments(href: DocsHref): ReadonlyArray<string> {
  return href === "/docs" ? [] : href.slice("/docs/".length).split("/");
}

/**
 * The docs page whose address is `/docs` followed by these segments, the inverse of {@link docsSegments}.
 *
 * @param segments - The segments after `/docs`, as a catch-all route receives them.
 * @returns The page, or `undefined` when no docs page lives there.
 */
export function docsPageAt(segments: ReadonlyArray<string>): DocsPage | undefined {
  return findDocsPage(["/docs", ...segments].join("/"));
}
