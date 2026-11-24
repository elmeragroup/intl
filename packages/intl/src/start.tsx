import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";

// TanStack Start adapter: switch locale in place (persist, then a blocking router.invalidate), and reload the catalog
// when a PO is saved in dev.
import { useRouter } from "@tanstack/react-router";

import type { RequestLike, ServerAdapter, SwitchOutcome } from "./adapter";
import { countPending, createLocaleSwitcher, resolveIntlConfig } from "./adapter";
import { CATALOG_UPDATE_EVENT } from "./catalog";
import type { IntlConfig } from "./intl";
import { useLatestRef } from "./latest-ref";

export type { RequestLike, ServerAdapter, SwitchOutcome } from "./adapter";

/**
 * Resolve a request's provider config through the app's adapter, for the root loader's server function.
 *
 * @param adapter - The app's server adapter.
 * @param request - The incoming request.
 * @returns Locale, catalog, time zone and formats for `<IntlProvider>`.
 */
export function loadIntlConfig(adapter: ServerAdapter, request: RequestLike): Promise<IntlConfig> {
  return resolveIntlConfig(adapter, request);
}

/** What `useLocaleSwitch` returns. */
export type LocaleSwitch = {
  /** Persist `locale`, then invalidate; resolves to how the switch ended (latest switch wins). */
  readonly switchLocale: (locale: string) => Promise<SwitchOutcome>;
  /** True from the call until the newest switch has settled. */
  readonly isPending: boolean;
};

/**
 * Switch the locale without a navigation. `persist` stores the choice where the server adapter's `resolveLocale`
 * reads it (a server function setting a cookie). Then `router.invalidate({ sync: true })` re-runs the loaders and resolves once their data rendered; the root route's
 * loader returns the new `{ locale, catalog }` (from a server function calling `loadIntlConfig`) and passes it to
 * `<IntlProvider>`, so the provider and the route data change in one commit. Latest switch wins: a switch resolves
 * `Superseded` when a later switch started before it ended, so only the latest switch reports `Switched`,
 * `PersistFailed` or `RefreshFailed`, and outcomes resolve in call order.
 *
 * @param persist - Stores the locale. A new function each render is fine: switches call the latest committed one,
 * and the switch queue lives as long as the router.
 * @returns The switch function and its pending state.
 */
export function useLocaleSwitch(persist: (locale: string) => void | Promise<void>): LocaleSwitch {
  const router = useRouter();
  const [pending, setPending] = useState(0);
  const latestPersist = useLatestRef(persist);
  const switchLocale = useMemo(() => {
    // Without `sync`, a loader with data already shown reloads in the background and invalidate() resolves at once,
    // so a switch would report Switched (and clear pending) while the old locale is still rendered.
    const run = createLocaleSwitcher({
      persist: (locale) => latestPersist.current(locale),
      refreshServer: () => router.invalidate({ sync: true }),
    });

    return countPending(run, setPending);
  }, [latestPersist, router]);

  return { switchLocale, isPending: pending > 0 };
}

/** The part of Vite's `import.meta.hot` the catalog reload uses. */
export type CatalogHot = {
  on(event: typeof CATALOG_UPDATE_EVENT, listener: () => void): void;
};

/**
 * In dev, re-run the loaders when a `.po` changes, so an open tab shows the recompiled catalog: the Vite plugin
 * recompiles the PO on save and sends an event the returned component turns into `router.invalidate()`. Call it at
 * the root route module's top level with that module's `import.meta.hot` (a listener registered later, from an effect,
 * never fired), and render the component once inside the router. In a production build `hot` is undefined and the
 * component renders nothing.
 *
 * @param hot - The calling module's `import.meta.hot`.
 * @returns A component to render once in the root route.
 */
export function createCatalogReload(hot: CatalogHot | undefined): () => ReactNode {
  let invalidate: (() => void) | undefined;
  hot?.on(CATALOG_UPDATE_EVENT, () => {
    invalidate?.();
  });

  return function CatalogReload() {
    const router = useRouter();

    useEffect(() => {
      invalidate = () => {
        void router.invalidate();
      };

      return () => {
        invalidate = undefined;
      };
    }, [router]);

    return null;
  };
}
