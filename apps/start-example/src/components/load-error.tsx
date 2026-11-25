import { useRouter } from "@tanstack/react-router";

import { Alert } from "@elmeragroup/fuse/alert";
import { Button } from "@elmeragroup/fuse/button";
import { T } from "@elmeragroup/intl/react";

/**
 * Shown in the shell's page slot in place of a route whose loader failed on a reload, such as the one after a locale
 * switch saved the choice: the page says so and offers to load again. The router's default error component rather than
 * the root's own, so every page route's loader gets it too (a route without an `errorComponent` falls back to the
 * router's default, not its parent's). The root's shell keeps the intl config it last loaded, so the message is in the
 * language the page shows. Fuse's inset is the document's `<main>`, so this is a region inside it.
 *
 * @returns The error and a control that re-runs the loaders.
 */
export function LoadError() {
  const router = useRouter();

  return (
    <div className="md:px-6 flex flex-col items-start gap-3 px-4 pt-6">
      <Alert.Root variant="destructive" id="load-error" role="alert">
        {/* The shell's page slot holds no heading while the page is missing: the error is the slot's heading. */}
        <Alert.Title level={2}>
          <T>This page could not be loaded.</T>
        </Alert.Title>
      </Alert.Root>
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          // Re-runs every loader and resets the error boundary once they succeed.
          void router.invalidate();
        }}>
        <T>Try again</T>
      </Button>
    </div>
  );
}
