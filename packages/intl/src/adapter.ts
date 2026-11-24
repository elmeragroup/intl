// The framework adapter contract and the framework-free locale switch every adapter shares.
import type { Catalog, Formats, IntlConfig } from "./intl";

/** The part of a request locale resolution reads: a `Request`, or the request Next's `createRequestConfig` builds. */
export type RequestLike = {
  readonly headers: { get(name: string): string | null };
};

/** Server half of an app's adapter: how a request picks its locale and catalog. */
export type ServerAdapter = {
  /** The request's locale, e.g. from a cookie. Returns a locale the app has a catalog for. */
  resolveLocale(request: RequestLike): string | Promise<string>;
  /** The locale's compiled catalog: a `*.po` import (`./intl/no.po`, or `./intl/no.po?source` for `en`). */
  loadCatalog(locale: string): Promise<Catalog>;
  /** The request's IANA zone, which every date and time formats in (per request: one process may serve brands in several zones). */
  resolveTimeZone(request: RequestLike): string | Promise<string>;
  /** Named styles messages refer to (`{d, date, short}`), the same for every request, like next-intl's `formats`. */
  readonly formats?: Formats;
};

/** How a host reads the current request's `IntlConfig`, per call (Next: `createRequestConfig(adapter)`). */
export type RequestConfig = () => Promise<IntlConfig>;

/**
 * Resolve a request's `IntlConfig` through the app's adapter: the value both the server translator and the client
 * provider are built from.
 *
 * @param adapter - The app's server adapter.
 * @param request - The incoming request, or its headers.
 * @returns Locale, catalog, time zone and formats for the request.
 */
export async function resolveIntlConfig(adapter: ServerAdapter, request: RequestLike): Promise<IntlConfig> {
  const [locale, timeZone] = await Promise.all([
    adapter.resolveLocale(request),
    adapter.resolveTimeZone(request),
  ]);
  const catalog = await adapter.loadCatalog(locale);

  return { locale, catalog, timeZone, formats: adapter.formats };
}

/** How a `switchLocale` call ended. */
export type SwitchOutcome =
  | { readonly _tag: "Switched"; readonly locale: string }
  /** A later switch started before this one ended; the later one decides the locale. */
  | { readonly _tag: "Superseded"; readonly locale: string }
  | { readonly _tag: "PersistFailed"; readonly locale: string; readonly cause: unknown }
  /** Persisted, but the framework refresh failed; the next navigation shows the new locale. */
  | { readonly _tag: "RefreshFailed"; readonly locale: string; readonly cause: unknown };

type RefreshResult = { readonly _tag: "Refreshed" } | { readonly _tag: "Failed"; readonly cause: unknown };

/** What a locale switch needs from the app and the framework. */
export type LocaleSwitchPort = {
  /** Store the choice where `resolveLocale` reads it (a cookie set by a server action or server function). */
  persist(locale: string): void | Promise<void>;
  /** Re-render server data so the provider receives the new `{ locale, catalog }` (Next `router.refresh`, Start `router.invalidate({ sync: true })`). */
  refreshServer(): void | Promise<void>;
};

/**
 * Make a framework-free locale switch: each switch persists, then refreshes the server so the provider gets the new
 * locale and catalog in the same commit as the rest of the server data.
 *
 * Latest switch wins: switches run one at a time in call order (persist, then refresh), so the stored locale ends
 * as the last one asked for even when requests would reach the server out of order, and a switch superseded before
 * its persist or refresh skips it. A switch resolves `Superseded` when a later switch started before it ended,
 * whichever way it ended; only the latest switch reports `Switched`, `PersistFailed` or `RefreshFailed`, and outcomes
 * resolve in call order. A caller that starts switches from user events can show every outcome that is not
 * `Superseded` as it arrives; one that starts a switch from a promise callback can see an older switch's outcome
 * delivered after the newer one started, and needs its own latest-attempt check if its status must reflect the latest
 * choice at display time. When `refreshServer` resolves
 * after the refreshed render lands (Start's `router.invalidate({ sync: true })`), an older refresh also lands before a
 * newer one starts; a fire-and-forget refresh (Next's `router.refresh()`) leaves render order to the framework's router.
 * Each call makes its own queue: `useLocaleSwitch` shares one queue per router instead, across every mount under it.
 *
 * @param port - The app's persist and the framework's refresh, each called on `port`.
 * @returns `switchLocale(locale)`, resolving to how that switch ended; it never rejects.
 */
export function createLocaleSwitcher(port: LocaleSwitchPort): (locale: string) => Promise<SwitchOutcome> {
  const queue = createSwitchQueue();
  const queued: QueuedSwitch = { port, rendersOnPersist: false };

  return (locale) => queue.switch(locale, () => queued);
}

/** What one switch persists and refreshes through, and how its new render arrives: read together, once, when it starts. */
export type QueuedSwitch = {
  /** The persist and refresh, each called on `port`. */
  readonly port: LocaleSwitchPort;
  /**
   * The persist's own response carries the re-rendered page (a Next Server Action), so no refresh follows it. Kept
   * apart from the port, so a public port's own properties change nothing.
   */
  readonly rendersOnPersist: boolean;
};

/** One latest-switch-wins queue, shared by every switch made through it, and whether any of them is in flight. */
export type SwitchQueue = {
  /**
   * Switch to `locale` through the port and mode `start` returns, which may differ per call (each mount's own persist
   * and refresh). `start` runs once, synchronously, when the switch's turn comes and no newer switch has started, so
   * a switch queued behind another uses what its caller committed by then; a switch superseded before its turn never
   * calls it.
   *
   * @param locale - The locale to switch to.
   * @param start - The port (each method called on it) and mode this switch runs with.
   * @returns How the switch ended; it never rejects.
   */
  readonly switch: (locale: string, start: () => QueuedSwitch) => Promise<SwitchOutcome>;
  /**
   * Listen for `isPending` changing.
   *
   * @param listener - Called each time `isPending()` flips.
   * @returns Stops listening.
   */
  readonly subscribe: (listener: () => void) => () => void;
  /**
   * Whether a switch is in flight.
   *
   * @returns True from a switch's call until it settles.
   */
  readonly isPending: () => boolean;
};

/**
 * Make a switch queue: the latest-switch-wins logic `createLocaleSwitcher` documents, with the in-flight state every
 * mount under one router reads.
 *
 * @returns The queue.
 */
export function createSwitchQueue(): SwitchQueue {
  let latest = 0;
  let queue: Promise<void> = Promise.resolve();
  let inFlight = 0;
  const listeners = new Set<() => void>();
  // Whether the server stores a locale the page has not rendered: set by a persist that renders nothing itself,
  // cleared by a refresh that succeeds or a persist that renders.
  let storedUnrendered = false;
  const notify = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };
  const decrement = (): void => {
    inFlight -= 1;
    if (inFlight === 0) {
      notify();
    }
  };
  // Every port under one router refreshes that router, so the latest switch's own refresh is a real one in every mode.
  const refresh = async (port: LocaleSwitchPort): Promise<RefreshResult> => {
    try {
      await port.refreshServer();
      storedUnrendered = false;

      return { _tag: "Refreshed" };
    } catch (cause) {
      return { _tag: "Failed", cause };
    }
  };

  const switchLocale = (locale: string, start: () => QueuedSwitch): Promise<SwitchOutcome> => {
    latest += 1;
    const id = latest;
    // How the switch ended by its own steps; `classified` below decides what the caller hears.
    const raw = queue.then(async (): Promise<SwitchOutcome> => {
      if (id !== latest) {
        return { _tag: "Superseded", locale };
      }
      const { port, rendersOnPersist } = start();

      try {
        await port.persist(locale);
        storedUnrendered = !rendersOnPersist;
      } catch (cause) {
        // The latest switch failed to store its own locale, so the page shows the one the server now resolves.
        if (id === latest && storedUnrendered) {
          await refresh(port);
        }

        return { _tag: "PersistFailed", locale, cause };
      }

      if (id !== latest) {
        return { _tag: "Superseded", locale };
      }

      if (rendersOnPersist) {
        return { _tag: "Switched", locale };
      }

      const refreshed = await refresh(port);

      return refreshed._tag === "Failed"
        ? { _tag: "RefreshFailed", locale, cause: refreshed.cause }
        : { _tag: "Switched", locale };
    });
    // Classified in the same step the returned promise settles, so a switch started any time before then supersedes
    // it.
    const classified: Promise<SwitchOutcome> = raw.then((outcome): SwitchOutcome =>
      id === latest || outcome._tag === "Superseded" ? outcome : { _tag: "Superseded", locale }
    );
    // The next switch starts a step after this one's settlement, so a handler attached to the returned promise before
    // it settles (the caller's, the in-flight decrement) runs before the next switch's persist; a handler attached
    // from inside one of those handlers can run after it. A listener hears of the switch (`notify()` below) before
    // this returns the promise, when the two handlers attached to it are the queue tail and the in-flight decrement;
    // the caller gets `classified` itself, so the decrement adds no settlement step.
    queue = classified.then(() => undefined);
    void classified.then(decrement, decrement);
    inFlight += 1;
    if (inFlight === 1) {
      notify();
    }

    return classified;
  };

  return {
    switch: switchLocale,
    subscribe: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    isPending: () => inFlight > 0,
  };
}
