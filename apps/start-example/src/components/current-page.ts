// The page on screen, by the route the router matched rather than the path as typed: the router matches paths without
// regard to case, so `/SETTINGS` shows Settings, and the shell names, marks and keys it as Settings too.
import { useMatches } from "@tanstack/react-router";

import { pageForRoute } from "./app-config";
import type { AppPage } from "./app-config";

/**
 * The page the router rendered: the deepest matched route's page, or none on a 404. A path no route owns matches the
 * root alone; a missing one below a page's route (`/invoices/missing`) matches that route, flagged not found
 * (`_notFound`, which the router's own types declare on a match), and shows its 404 there.
 *
 * @returns The current page, or `undefined` on a 404.
 */
export function useCurrentPage(): AppPage | undefined {
  return useMatches({
    select: (matches) =>
      matches.some((match) => match.status === "notFound" || match._notFound === true)
        ? undefined
        : pageForRoute(matches.at(-1)?.routeId ?? ""),
  });
}
