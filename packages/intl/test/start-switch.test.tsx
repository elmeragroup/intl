import { act } from "react";

// @vitest-environment jsdom
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SwitchOutcome } from "../src/start";
import { useLocaleSwitch } from "../src/start";

// Router updates land outside act() (loaders resolve on their own); this is not an act-only test renderer.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });

type App = {
  readonly text: () => string | null | undefined;
  readonly switchLocale: (locale: string) => Promise<SwitchOutcome>;
  /** Root-loader runs so far; the first is the initial load. */
  readonly loads: () => number;
  /** Hold every later loader run until released. */
  readonly hold: () => () => void;
  readonly unmount: () => void;
};

// What persist does in each render: a new function every render (an inline arrow) when `inline` is given.
type PersistOptions = { readonly inline?: { readonly gate: Promise<void>; readonly log: Array<string> } };

// A real router whose root loader reads the "cookie" persist writes, as a Start root loader calling
// loadIntlConfig would. Loader runs can be held, so the test controls when the new data exists.
async function mountApp({ inline }: PersistOptions = {}): Promise<App> {
  let cookie = "en";
  let loads = 0;
  let gate: Promise<void> | undefined;
  let switchLocale: ((locale: string) => Promise<SwitchOutcome>) | undefined;
  const persist = (locale: string): Promise<void> => {
    cookie = locale;

    return Promise.resolve();
  };
  const rootRoute = createRootRoute({
    loader: async () => {
      loads += 1;
      const locale = cookie;
      await gate;

      return { locale };
    },
    component: function Root() {
      // Loader data is untyped here: without a registered router its type refers to this very route.
      const data: unknown = rootRoute.useLoaderData();
      switchLocale = useLocaleSwitch(
        inline
          ? async (locale) => {
              inline.log.push(`start ${locale}`);
              await inline.gate;
              cookie = locale;
              inline.log.push(`end ${locale}`);
            }
          : persist
      ).switchLocale;

      return <p>{data instanceof Object && "locale" in data ? String(data.locale) : null}</p>;
    },
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
    isServer: false,
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await router.load();
  act(() => {
    root.render(<RouterProvider router={router} />);
  });
  await vi.waitFor(() => {
    expect(container.textContent).toBe("en");
  });

  return {
    text: () => container.textContent,
    switchLocale: (locale) => {
      if (!switchLocale) {
        throw new Error("app not rendered");
      }

      return switchLocale(locale);
    },
    loads: () => loads,
    hold: () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      gate = promise;

      return () => {
        gate = undefined;
        resolve();
      };
    },
    unmount: () => {
      root.unmount();
      container.remove();
    },
  };
}

let app: App | undefined;

afterEach(() => {
  app?.unmount();
  app = undefined;
});

// Unit under test: the Start useLocaleSwitch against a real router. Oracle: the rendered loader data at the moment
// a switch resolves, which must already be the new locale.
describe("Start useLocaleSwitch", () => {
  it("resolves Switched only after the reloaded loader data rendered", async () => {
    app = await mountApp();
    const release = app.hold();
    const seenAtResolve: Array<readonly [string, string | null | undefined]> = [];
    const mounted = app;
    const outcome = app.switchLocale("nb").then((result) => {
      seenAtResolve.push([result._tag, mounted.text()]);

      return result;
    });
    await vi.waitFor(() => {
      expect(mounted.loads()).toBe(2);
    });
    release();
    await outcome;
    expect(seenAtResolve).toEqual([["Switched", "nb"]]);
  });

  it("ends in the latest of two back-to-back switches", async () => {
    app = await mountApp();
    const release = app.hold();
    const mounted = app;
    const first = app.switchLocale("nb");
    const second = app.switchLocale("sv");
    await vi.waitFor(() => {
      expect(mounted.loads()).toBe(2);
    });
    release();
    expect([(await first)._tag, (await second)._tag]).toEqual(["Superseded", "Switched"]);
    expect(app.text()).toBe("sv");
  });

  it("runs switches one at a time when persist is a new function every render", async () => {
    const gate = Promise.withResolvers<void>();
    const log: Array<string> = [];
    app = await mountApp({ inline: { gate: gate.promise, log } });
    const first = app.switchLocale("nb");
    await vi.waitFor(() => {
      expect(log).toEqual(["start nb"]);
    });
    // The pending state re-rendered the component, and with it persist, before the second switch.
    const second = app.switchLocale("sv");
    gate.resolve();
    expect([(await first)._tag, (await second)._tag]).toEqual(["Superseded", "Switched"]);
    expect(log).toEqual(["start nb", "end nb", "start sv", "end sv"]);
  });
});
