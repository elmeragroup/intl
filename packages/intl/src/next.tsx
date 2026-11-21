"use client";
import { useMemo, useState, useTransition } from "react";

// Next.js client adapter: switch locale in place (persist, then refresh the server tree).
import { useRouter } from "next/navigation";

import type { SwitchOutcome } from "./adapter";
import { countPending, createLocaleSwitcher } from "./adapter";
import { useLatestRef } from "./latest-ref";

export type { SwitchOutcome } from "./adapter";

/** What `useLocaleSwitch` returns. */
export type LocaleSwitch = {
  /** Persist `locale`, then refresh; resolves to how the switch ended (latest switch wins). */
  readonly switchLocale: (locale: string) => Promise<SwitchOutcome>;
  /** True while a switch's persist or refreshed server render is on its way. */
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

/**
 * Switch the locale without a navigation: form state and scroll survive. `persist` stores the choice where the
 * server adapter's `resolveLocale` reads it, typically a Server Action setting a cookie. Then the server tree
 * re-renders (in the Server Action's response, or through `router.refresh()`), whose layout passes the new
 * `{ locale, catalog }` to `<IntlProvider>`, so the provider and the server content change in one commit.
 *
 * @param persist - Stores the locale. A new function each render is fine: switches call the latest committed one,
 * and the switch queue lives as long as the router and the refresh mode.
 * @param options - How the re-rendered server tree arrives.
 * @returns The switch function and its pending state.
 */
export function useLocaleSwitch(
  persist: (locale: string) => void | Promise<void>,
  options: LocaleSwitchOptions = {}
): LocaleSwitch {
  const router = useRouter();
  const [isRefreshing, startTransition] = useTransition();
  const [outstanding, setOutstanding] = useState(0);
  const refresh = options.refresh ?? "router-refresh";
  const latestPersist = useLatestRef(persist);
  // router.refresh() returns nothing, so "Switched" resolves when the refresh is dispatched, not rendered: pending is
  // the outstanding switches (persist included) or the refresh transition, whichever lasts longer. A Server Action
  // persist runs inside the transition, so the transition spans its roundtrip and the render it carries.
  const switchLocale = useMemo(() => {
    const run = createLocaleSwitcher(
      refresh === "server-action"
        ? {
            persist: (locale) =>
              new Promise<void>((resolve, reject) => {
                startTransition(async () => {
                  try {
                    await latestPersist.current(locale);
                    resolve();
                  } catch (cause) {
                    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- persist's own rejection passes through unchanged, as awaiting it directly would
                    reject(cause);
                  }
                });
              }),
            refreshServer: () => undefined,
          }
        : {
            persist: (locale) => latestPersist.current(locale),
            refreshServer: () => {
              startTransition(() => {
                router.refresh();
              });
            },
          }
    );

    return countPending(run, setOutstanding);
  }, [latestPersist, refresh, router]);

  return { switchLocale, isPending: outstanding > 0 || isRefreshing };
}
