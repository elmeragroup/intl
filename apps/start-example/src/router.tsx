import { createRouter } from "@tanstack/react-router";

import { LoadError } from "./components/load-error";
import { routeTree } from "./routeTree.gen";

/**
 * Create the router, once per server request and once in the browser.
 *
 * @returns The app's router.
 */
export function getRouter() {
  return createRouter({ routeTree, scrollRestoration: true, defaultErrorComponent: LoadError });
}

declare module "@tanstack/react-router" {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- module augmentation needs interface merging
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
