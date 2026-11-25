import { useSyncExternalStore } from "react";

const subscribe = () => () => undefined;

/**
 * Whether React has hydrated this tree: `false` in the server render and during hydration, `true` after. Controls stay
 * disabled until then, since a click before hydration would do nothing.
 *
 * @returns `true` once the component runs in the browser.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  );
}
