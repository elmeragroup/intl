import type { ReactNode } from "react";
import { useEffect, useState } from "react";

// TanStack Start adapter: switch locale in place (persist, then a blocking router.invalidate), and reload the catalog
// when a PO is saved in dev.
import { useRouter } from "@tanstack/react-router";

import type { RequestLike, ServerAdapter, SwitchOutcome } from "./adapter";
import { resolveIntlConfig } from "./adapter";
import { CATALOG_UPDATE_EVENT } from "./catalog";
import type { IntlConfig } from "./intl";
import type { PrepareSwitch } from "./router-switch";
import { useRouterSwitch } from "./router-switch";

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
  /** True from a switch's call, from any mount under the router, until the newest switch has settled. */
  readonly isPending: boolean;
};

type Router = ReturnType<typeof useRouter>;

// What a mount outside a <RouterProvider> keys its queue on: an object of its own, so no null key reaches the queues.
type OutsideRouter = { readonly _tag: "OutsideRouter" };

const outsideRouter = (): OutsideRouter => ({ _tag: "OutsideRouter" });

// What a switch runs with, from one render's persist.
function prepareSwitch(persist: (locale: string) => void | Promise<void>): PrepareSwitch<Router | null> {
  return (router) => ({
    port: {
      persist: (locale) => persist(locale),
      // Without `sync`, a loader with data already shown reloads in the background and invalidate() resolves at once,
      // so a switch would report Switched (and clear pending) while the old locale is still rendered.
      refreshServer: () =>
        router === null
          ? Promise.reject(
              new Error("useLocaleSwitch has no router to invalidate: render it inside <RouterProvider>.")
            )
          : router.invalidate({ sync: true }),
    },
    rendersOnPersist: false,
  });
}

/**
 * Switch the locale without a navigation. `persist` stores the choice where the server adapter's `resolveLocale`
 * reads it (a server function setting a cookie). Then `router.invalidate({ sync: true })` re-runs the loaders and resolves once their data rendered; the root route's
 * loader returns the new `{ locale, catalog }` (from a server function calling `loadIntlConfig`) and passes it to
 * `<IntlProvider>`, so the provider and the route data change in one commit. Latest switch wins: a switch resolves
 * `Superseded` when a later switch started before it ended, so only the latest switch reports `Switched`,
 * `PersistFailed` or `RefreshFailed`, and outcomes resolve in call order.
 *
 * Every mount under one router object shares one switch queue, so any number of switchers may mount, and a switch
 * held in one that unmounted still yields to a newer one from the next. `isPending` is router-wide: a client-rendered
 * switcher mounted while another's switch is held shows it from its first commit (a hydrating one, from the commit
 * after), and it stays true until the newest switch's reloaded data rendered.
 *
 * @param persist - Stores the locale. A new function each render is fine: a switch, queued or held, calls the one its
 * mount last committed under the router that admitted it, when the switch starts, even after that mount unmounted or
 * moved to another router; that router reloads it.
 * @returns The switch function and its pending state.
 */
export function useLocaleSwitch(persist: (locale: string) => void | Promise<void>): LocaleSwitch {
  // SAFETY: TanStack's useRouter is typed non-null, but outside a <RouterProvider> it warns and returns the context's
  // null default; the nullable type makes the switch handle that.
  const router = useRouter() as Router | null;
  const [ownKey] = useState(outsideRouter);
  // One queue per router object.
  return useRouterSwitch(router ?? ownKey, router, prepareSwitch(persist));
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
