/**
 * The public origin the docs site serves, which every absolute URL in page metadata resolves against. Open Graph and X
 * cards need absolute image URLs, and the root layout's `metadataBase` turns the site-relative `/og/...` paths into
 * them.
 *
 * The origin comes from `DOCS_ORIGIN`. Every page prerenders during `next build`, so the build bakes the value into the
 * HTML: the Dockerfile takes it as a build argument and refuses an empty one, and the preview workflow reads a
 * preview's URL from the Container Apps environment first (`.github/scripts/docs-container-app.sh origin-preview`).
 *
 * Unset, the origin falls back to `http://localhost:<port>` on the port `pnpm start` serves (port.ts), so a local build
 * and dev server need no setup. A malformed `DOCS_ORIGIN`, or with the fallback a malformed `PORT`, fails the build
 * rather than publishing broken cards.
 */

import { parsePort } from "./port";
import type { InvalidPort } from "./port";

/** Why `DOCS_ORIGIN` is not a usable origin. */
export class InvalidSiteOrigin extends Error {
  /** The error's tag. */
  readonly _tag = "InvalidSiteOrigin" as const;

  /**
   * @param input - The value `DOCS_ORIGIN` held.
   * @param reason - What is wrong with it: not a URL, not http(s), or a URL with more than an origin.
   */
  constructor(
    readonly input: string,
    readonly reason: "unparsable" | "protocol" | "not-an-origin"
  ) {
    super(
      `DOCS_ORIGIN must be an http(s) origin such as https://docs.example.com, got "${input}" (${reason})`
    );
  }
}

/** A parsed site origin, or why the input is not one. */
export type SiteOriginResult =
  | { readonly _tag: "ok"; readonly value: URL }
  | { readonly _tag: "err"; readonly error: InvalidSiteOrigin | InvalidPort };

/** The environment variables the origin reads. */
export type SiteOriginEnv = {
  /** The public origin, such as `https://docs.example.com`. */
  readonly DOCS_ORIGIN?: string | undefined;
  /** The port the localhost fallback names. */
  readonly PORT?: string | undefined;
};

/**
 * Parse the site origin from the environment.
 *
 * @param env - The variables to read, normally `process.env`.
 * @returns The origin as a `URL` with path `/`, `InvalidSiteOrigin` when `DOCS_ORIGIN` is set but is not a bare
 *   http(s) origin, or `InvalidPort` when the localhost fallback's `PORT` is not a port.
 */
export function parseSiteOrigin(env: SiteOriginEnv): SiteOriginResult {
  const input = env.DOCS_ORIGIN;

  if (input === undefined || input === "") {
    const port = parsePort(env.PORT);

    return port._tag === "ok"
      ? { _tag: "ok", value: new URL(`http://localhost:${String(port.value)}`) }
      : port;
  }

  const url = URL.parse(input);

  if (url === null) {
    return { _tag: "err", error: new InvalidSiteOrigin(input, "unparsable") };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { _tag: "err", error: new InvalidSiteOrigin(input, "protocol") };
  }

  if (
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return { _tag: "err", error: new InvalidSiteOrigin(input, "not-an-origin") };
  }

  return { _tag: "ok", value: url };
}

/**
 * The site origin from `process.env`, for the root layout's `metadataBase`.
 *
 * @returns The parsed origin.
 * @throws {InvalidSiteOrigin | InvalidPort} When `DOCS_ORIGIN`, or the fallback's `PORT`, is malformed. Layout metadata is the composition root here, and a throw
 *   is how it fails `next build` with the message.
 */
export function siteOrigin(): URL {
  const result = parseSiteOrigin({ DOCS_ORIGIN: process.env.DOCS_ORIGIN, PORT: process.env.PORT });

  if (result._tag === "err") {
    throw result.error;
  }

  return result.value;
}
