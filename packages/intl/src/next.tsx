"use client";
import type { TransitionStartFunction } from "react";
import { useTransition } from "react";

// Next.js client adapter: switch locale in place (persist, then refresh the server tree).
import { useRouter } from "next/navigation";

import type { SwitchOutcome } from "./adapter";
import type { PrepareSwitch } from "./router-switch";
import { useRouterSwitch } from "./router-switch";

export type { SwitchOutcome } from "./adapter";

/** What `useLocaleSwitch` returns. */
export type LocaleSwitch = {
  /** Persist `locale`, then refresh; resolves to how the switch ended (latest switch wins). */
  readonly switchLocale: (locale: string) => Promise<SwitchOutcome>;
  /**
   * True while any switch under the router is in flight, from whichever mount it started, or while this mount's own
   * refresh or Server Action render is on its way.
   */
  readonly isPending: boolean;
};

/** Options of `useLocaleSwitch`. */
export type LocaleSwitchOptions = {
  /**
   * How the new server tree arrives. `"router-refresh"` (default): persist, then `router.refresh()`.
   * `"server-action"`: `persist` is a Server Action that sets the cookie (or calls `revalidatePath`), whose single
   * response already carries the re-rendered page and layouts, so a refresh would be a second, redundant roundtrip.
   */
  readonly refresh?: "router-refresh" | "server-action";
};

type Router = ReturnType<typeof useRouter>;

// What a switch runs with, from one render's persist and refresh mode, which it reads together. router.refresh()
// returns nothing, so "Switched" resolves when the refresh is dispatched, not rendered: pending is the switches in
// flight (persist included) or this mount's refresh transition, whichever lasts longer. A Server Action persist runs
// inside the transition, so the transition spans its roundtrip and the render it carries. The transition is this
// mount's: React still runs it after the mount unmounted.
function prepareSwitch(
  persist: (locale: string) => void | Promise<void>,
  refresh: NonNullable<LocaleSwitchOptions["refresh"]>,
  startTransition: TransitionStartFunction
): PrepareSwitch<Router> {
  return (router) => {
    // startTransition turns a throw inside its callback into an error of this mount's next render, so a throw from
    // router.refresh() is caught here and reported to the queue as a failed refresh.
    const refreshServer = (): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        startTransition(() => {
          try {
            router.refresh();
            resolve();
          } catch (cause) {
            // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- router.refresh()'s own throw passes through unchanged, as calling it directly would
            reject(cause);
          }
        });
      });

    if (refresh === "router-refresh") {
      return { port: { persist: (locale) => persist(locale), refreshServer }, rendersOnPersist: false };
    }

    return {
      port: {
        persist: (locale) =>
          new Promise<void>((resolve, reject) => {
            startTransition(async () => {
              try {
                await persist(locale);
                resolve();
              } catch (cause) {
                // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- persist's own rejection passes through unchanged, as awaiting it directly would
                reject(cause);
              }
            });
          }),
        // Only a failed persist's recovery refreshes: a Server Action's response already renders.
        refreshServer,
      },
      rendersOnPersist: true,
    };
  };
}

/**
 * Switch the locale without a navigation: form state and scroll survive. `persist` stores the choice where the
 * server adapter's `resolveLocale` reads it, typically a Server Action setting a cookie. Then the server tree
 * re-renders (in the Server Action's response, or through `router.refresh()`), whose layout passes the new
 * `{ locale, catalog }` to `<IntlProvider>`, so the provider and the server content change in one commit. Latest switch
 * wins: a switch resolves `Superseded` when a later switch started before it ended, so only the latest switch reports
 * `Switched`, `PersistFailed` or `RefreshFailed`, and outcomes resolve in call order.
 *
 * Every mount under the page's App Router shares one switch queue (keyed on `router.refresh`, Next's own navigator),
 * so any number of switchers may mount, and a switch held in one that unmounted still yields to a newer one from the
 * next. `isPending` is router-wide for switches: a client-rendered switcher mounted while another's switch is held
 * shows it from its first commit (a hydrating one, from the commit after). A switch counts until it settles: in
 * `"router-refresh"` mode that is when its refresh is dispatched, and the render after it shows only in the dispatching mount's `isPending`; in `"server-action"` mode the action's
 * render shows in the dispatching mount's transition. So after a remount, no switcher shows the old mount's render
 * landing. Mounts with different refresh modes share the queue.
 *
 * @param persist - Stores the locale. A new function each render is fine: a switch, queued or held, calls the one its
 * mount last committed under the App Router that admitted it, when the switch starts, even after that mount unmounted
 * or moved to another router; that router refreshes it.
 * @param options - How the re-rendered server tree arrives. A switch reads it together with `persist`, from the same
 * commit, when it starts.
 * @returns The switch function and its pending state.
 */
export function useLocaleSwitch(
  persist: (locale: string) => void | Promise<void>,
  options: LocaleSwitchOptions = {}
): LocaleSwitch {
  const router = useRouter();
  const [isRefreshing, startTransition] = useTransition();
  // One queue per `router.refresh`: `useRouter()` returns a new object per mount, but every one of them carries Next's
  // own navigator's `refresh`, so every App Router in a page shares this key. `router` is the one a switch admitted
  // here refreshes, even if the context changes while it is held.
  const { switchLocale, isPending } = useRouterSwitch(
    // oxlint-disable-next-line typescript/unbound-method -- the queue's identity, compared and never called; the refresh goes through `router.refresh()`
    router.refresh,
    router,
    prepareSwitch(persist, options.refresh ?? "router-refresh", startTransition)
  );

  return { switchLocale, isPending: isPending || isRefreshing };
}
