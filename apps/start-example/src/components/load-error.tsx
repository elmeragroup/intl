import { useRouter } from "@tanstack/react-router";

import { T } from "@elmeragroup/intl/react";

/**
 * Shown in place of a route whose loader failed on a reload, such as the one after a locale switch saved the choice:
 * the page says so and offers to load again. The router's default error component rather than the root's own, so the
 * index route's loader gets it too (a route without an `errorComponent` falls back to the router's default, not its
 * parent's). The root's shell keeps the intl config it last loaded, so the message is in the language the page shows.
 *
 * @returns The error and a control that re-runs the loaders.
 */
export function LoadError() {
  const router = useRouter();

  return (
    <main>
      <p id="load-error" role="alert">
        <T>This page could not be loaded.</T>
      </p>
      <button
        type="button"
        onClick={() => {
          // Re-runs every loader and resets the error boundary once they succeed.
          void router.invalidate();
        }}>
        <T>Try again</T>
      </button>
    </main>
  );
}
