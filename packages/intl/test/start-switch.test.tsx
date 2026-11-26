import type { ComponentType, ReactNode } from "react";
import { act, Activity, useLayoutEffect, useState, version as REACT_VERSION } from "react";

// @vitest-environment jsdom
import type { AnyRouter } from "@tanstack/react-router";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
  RouterProvider,
} from "@tanstack/react-router";
import { queryObjects } from "node:v8";
import { createRoot, hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SwitchOutcome } from "../src/start";
import { useLocaleSwitch } from "../src/start";
import type { FakeServer } from "./switch-settlement";
import { fakeServer, sweepSettlement } from "./switch-settlement";

// Router updates land outside act() (loaders resolve on their own); this is not an act-only test renderer.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });

// `Activity` is React 19.2's. Below it (the floor, 19.0.0) a visible mount renders its children bare, as a visible
// Activity does, and only the rows that hide one skip. Keyed on React's version, so the catalog's React skips none.
const [REACT_MAJOR = 0, REACT_MINOR = 0] = REACT_VERSION.split(".").map(Number);
const HAS_ACTIVITY = REACT_MAJOR > 19 || (REACT_MAJOR === 19 && REACT_MINOR >= 2);

function Placed({
  activity,
  children,
}: {
  readonly activity: "visible" | "hidden";
  readonly children: ReactNode;
}) {
  if (HAS_ACTIVITY) {
    return <Activity mode={activity}>{children}</Activity>;
  }

  if (activity === "hidden") {
    throw new Error(`a hidden Activity needs React 19.2, not ${REACT_VERSION}`);
  }

  return children;
}

type App = {
  readonly text: () => string | null | undefined;
  readonly switchLocale: (locale: string) => Promise<SwitchOutcome>;
  /** `isPending` as the latest committed render shows it. */
  readonly pending: () => boolean;
  /** `isPending` in each committed render of the switcher mounted now, consecutive repeats collapsed. */
  readonly history: () => ReadonlyArray<boolean>;
  /** Re-render the switcher, and wait for that render to commit: it shows every state update queued before the call. */
  readonly commit: () => Promise<void>;
  /** Unmount the switcher, then mount a new one under the same router. */
  readonly remount: () => void;
  /** Root-loader runs so far; the first is the initial load. */
  readonly loads: () => number;
  /** Hold every later loader run until released. */
  readonly hold: () => () => void;
  readonly unmount: () => void;
};

// What persist does in each render: a new function every render (an inline arrow) when `inline` is given, which waits
// for the locale's gate; the fake server's own persist when `server` is given, whose cookie the loader then reads.
type PersistOptions = {
  readonly inline?: { readonly gate: (locale: string) => Promise<void>; readonly log: Array<string> };
  readonly server?: Pick<FakeServer, "cookie" | "persist">;
};

type Page = {
  readonly router: AnyRouter;
  /** The page's text: the loaded locale, then whatever the child renders. */
  readonly text: () => string | null | undefined;
  readonly container: HTMLElement;
  /** Root-loader runs so far; the first is the initial load. */
  readonly loads: () => number;
  /** Hold every later loader run until released. */
  readonly hold: () => () => void;
  readonly unmount: () => void;
};

// A real router whose root loader reads the cookie, as a Start root loader calling loadIntlConfig would, and renders
// the locale it loaded with `Child` beside it. Loader runs can be held, so the test controls when the new data exists.
async function mountPage(cookie: () => string, Child: ComponentType = () => null): Promise<Page> {
  let loads = 0;
  let gate: Promise<void> | undefined;
  const rootRoute = createRootRoute({
    loader: async () => {
      loads += 1;
      const locale = cookie();
      await gate;

      return { locale };
    },
    component: function Root() {
      // Loader data is untyped here: without a registered router its type refers to this very route.
      const data: unknown = rootRoute.useLoaderData();

      return (
        <>
          <p>{data instanceof Object && "locale" in data ? String(data.locale) : null}</p>
          <Child />
        </>
      );
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
    expect(container.textContent).toBe(cookie());
  });

  return {
    router,
    text: () => container.textContent,
    container,
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
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

// The page with a switcher in its child slot, which the test can remount.
async function mountApp({ inline, server }: PersistOptions = {}): Promise<App> {
  let ownCookie = "en";
  let switchLocale: ((locale: string) => Promise<SwitchOutcome>) | undefined;
  let rerender: (() => void) | undefined;
  let remount: (() => void) | undefined;
  let history: Array<boolean> = [];
  const persist =
    server?.persist ??
    ((locale: string): Promise<void> => {
      ownCookie = locale;

      return Promise.resolve();
    });
  function Switcher() {
    const [renders, setRenders] = useState(0);
    const localeSwitch = useLocaleSwitch(
      inline
        ? async (locale) => {
            inline.log.push(`start ${locale}`);
            await inline.gate(locale);
            ownCookie = locale;
            inline.log.push(`end ${locale}`);
          }
        : persist
    );
    const pending = localeSwitch.isPending;
    switchLocale = localeSwitch.switchLocale;
    rerender = () => {
      setRenders((count) => count + 1);
    };
    // Recorded on commit, so a render React discards never enters the history.
    useLayoutEffect(() => {
      if (history.at(-1) !== pending) {
        history.push(pending);
      }
    }, [pending]);

    return <span data-renders={renders} data-pending={String(pending)} />;
  }
  function Slot() {
    const [generation, setGeneration] = useState(0);
    remount = () => {
      setGeneration((count) => count + 1);
    };

    return <Switcher key={generation} />;
  }
  const page = await mountPage(() => server?.cookie() ?? ownCookie, Slot);
  const span = () => page.container.querySelector("span");

  return {
    text: page.text,
    switchLocale: (locale) => {
      if (!switchLocale) {
        throw new Error("app not rendered");
      }

      return switchLocale(locale);
    },
    pending: () => span()?.dataset.pending === "true",
    history: () => history,
    commit: async () => {
      const before = span()?.dataset.renders;
      rerender?.();
      await vi.waitFor(() => {
        expect(span()?.dataset.renders).not.toBe(before);
      });
    },
    remount: () => {
      switchLocale = undefined;
      history = [];
      act(() => {
        remount?.();
      });
    },
    loads: page.loads,
    hold: page.hold,
    unmount: page.unmount,
  };
}

let app: App | undefined;

afterEach(() => {
  app?.unmount();
  app = undefined;
});

// Unit under test: the Start useLocaleSwitch against a real router. Oracle: the rendered loader data at the moment
// a switch resolves, which must already be the new locale, and isPending, which a settled switch, however it ended,
// no longer holds.
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

  it("returns to idle after a persist that fails", async () => {
    const gate = Promise.withResolvers<void>();
    app = await mountApp({ inline: { gate: () => gate.promise, log: [] } });
    const mounted = app;
    const outcome = app.switchLocale("nb");
    await vi.waitFor(() => {
      expect(mounted.pending()).toBe(true);
    });
    gate.reject(new Error("offline"));
    expect((await outcome)._tag).toBe("PersistFailed");
    await vi.waitFor(() => {
      expect(mounted.pending()).toBe(false);
    });
    expect(app.text()).toBe("en");
  });

  // Oracle: a switch is in flight from A's call until B settles, so isPending never reads false in between, even in a
  // render committed after A settled while B's persist is held.
  it("stays pending across the handoff from one switch to the next", async () => {
    const gates = new Map([
      ["nb", Promise.withResolvers<void>()],
      ["sv", Promise.withResolvers<void>()],
    ]);
    const gate = (locale: string) => {
      const held = gates.get(locale);

      if (!held) {
        throw new Error(`no gate for ${locale}`);
      }

      return held;
    };
    const log: Array<string> = [];
    app = await mountApp({ inline: { gate: (locale) => gate(locale).promise, log } });
    const mounted = app;
    const first = app.switchLocale("nb");
    await vi.waitFor(() => {
      expect(mounted.pending()).toBe(true);
    });
    const second = app.switchLocale("sv");
    gate("nb").resolve();
    expect((await first)._tag).toBe("Superseded");
    await vi.waitFor(() => {
      expect(log).toEqual(["start nb", "end nb", "start sv"]);
    });
    await app.commit();
    expect(app.pending()).toBe(true);
    gate("sv").resolve();
    expect((await second)._tag).toBe("Switched");
    await vi.waitFor(() => {
      expect(mounted.pending()).toBe(false);
    });
    expect([app.history(), app.text()]).toEqual([[false, true, false], "sv"]);
  });

  // Unit under test: the switchLocale the mounted hook returns, through the shared settlement sweep. Oracle: the
  // sweep's invariant (a switch a newer one started before it settled resolves Superseded), which a wrapper the hook
  // adds after the switcher's classification would break.
  it("resolves a switch superseded whenever a newer one starts before it settles", async () => {
    const sawPending = await sweepSettlement(async (server) => {
      const mounted = await mountApp({ inline: { gate: (locale) => server.persist(locale), log: [] } });

      return { switchLocale: mounted.switchLocale, dispose: mounted.unmount };
    });
    expect(sawPending, "no step saw A pending").toBe(true);
  });

  it("runs switches one at a time when persist is a new function every render", async () => {
    const gate = Promise.withResolvers<void>();
    const log: Array<string> = [];
    app = await mountApp({ inline: { gate: () => gate.promise, log } });
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

// Unit under test: the queue every useLocaleSwitch under one router shares. Oracle: the fake server's requests, the
// outcomes in call order, the stored cookie and the rendered loader data, written out per interleaving.
describe("Start useLocaleSwitch across mounts", () => {
  const apps: Array<App> = [];

  afterEach(() => {
    for (const mounted of apps.splice(0)) {
      mounted.unmount();
    }
  });

  // One queue runs the new mount's switch only after the held one ended, so Swedish cannot answer last and take the
  // cookie back.
  it("lets the newest switch win when the switcher remounted while an older one was held", async () => {
    const server = fakeServer();
    const events: Array<string> = [];
    const persist = (locale: string): Promise<void> => {
      events.push(`persist ${locale}`);

      return server.persist(locale);
    };
    const mounted = await mountApp({ server: { cookie: server.cookie, persist } });
    apps.push(mounted);
    const sv = mounted.switchLocale("sv");
    void sv.then(() => {
      events.push("sv settled");
    });
    const svHeld = await server.request(0);
    mounted.remount();
    // The new mount sees the held switch from its first commit.
    expect(mounted.history()).toEqual([true]);
    const fi = mounted.switchLocale("fi");
    svHeld.arrive();
    (await server.request(1)).arrive();
    const outcomes = [(await sv)._tag, (await fi)._tag];
    // One queue holds Finnish until Swedish has ended, so Swedish cannot answer last.
    expect(events).toEqual(["persist sv", "sv settled", "persist fi"]);
    expect(outcomes).toEqual(["Superseded", "Switched"]);
    expect([server.cookie(), mounted.text()]).toEqual(["fi", "fi"]);
  });

  it("keeps separate queues for separate routers", async () => {
    const server = fakeServer();
    const first = await mountApp({ server });
    const second = await mountApp();
    apps.push(first, second);
    const held = first.switchLocale("nb");
    const nbHeld = await server.request(0);
    expect((await second.switchLocale("sv"))._tag).toBe("Switched");
    nbHeld.arrive();
    expect((await held)._tag).toBe("Switched");
    expect([first.text(), second.text()]).toEqual(["nb", "sv"]);
  });
});

// Unit under test: the hook outside a <RouterProvider>, which TanStack warns about rather than rejects. Oracle: the
// behaviour it has always had: persist runs, and the switch reports the refresh it could not make.
describe("Start useLocaleSwitch outside a router", () => {
  it("persists, then reports RefreshFailed", async () => {
    const persisted: Array<string> = [];
    let switchLocale: ((locale: string) => Promise<SwitchOutcome>) | undefined;
    function Switcher() {
      switchLocale = useLocaleSwitch((locale) => {
        persisted.push(locale);
      }).switchLocale;

      return null;
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      act(() => {
        root.render(<Switcher />);
      });
      if (!switchLocale) {
        throw new Error("not rendered");
      }
      expect([(await switchLocale("nb"))._tag, persisted]).toEqual(["RefreshFailed", ["nb"]]);
    } finally {
      act(() => {
        root.unmount();
      });
      warn.mockRestore();
    }
  });
});

// Unit under test: the hook's server render. Oracle: a server render has no switch in flight, so isPending is false.
describe("Start useLocaleSwitch on the server", () => {
  it("renders isPending false", async () => {
    const rootRoute = createRootRoute({
      component: function Root() {
        return <p>{String(useLocaleSwitch(() => undefined).isPending)}</p>;
      },
    });
    const router = createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory({ initialEntries: ["/"] }),
      isServer: true,
    });
    await router.load();
    expect(renderToString(<RouterProvider router={router} />)).toContain("<p>false</p>");
  });
});

type RoutedApp = Page & { readonly server: FakeServer };

// A page whose root loader renders the cookie its own fake server stores, with nothing in its child slot.
async function mountRouter(): Promise<RoutedApp> {
  const server = fakeServer();

  return { ...(await mountPage(server.cookie)), server };
}

type Placement = { readonly label?: string; readonly activity?: "visible" | "hidden" };

// One switcher, mounted apart from any page, that the test moves between routers, persists and visibility.
function mountSwitcher() {
  let switchLocale: ((locale: string) => Promise<SwitchOutcome>) | undefined;
  function Switcher({
    persist,
    label,
  }: {
    readonly persist: (locale: string) => Promise<void>;
    readonly label: string;
  }) {
    switchLocale = useLocaleSwitch(persist).switchLocale;

    return <p>{label}</p>;
  }
  const container = document.createElement("div");
  const root = createRoot(container);

  return {
    render: (
      router: AnyRouter,
      persist: (locale: string) => Promise<void>,
      { label = "switcher", activity = "visible" }: Placement = {}
    ): void => {
      act(() => {
        root.render(
          <RouterContextProvider router={router}>
            <Placed activity={activity}>
              <Switcher persist={persist} label={label} />
            </Placed>
          </RouterContextProvider>
        );
      });
    },
    text: () => container.textContent,
    switchLocale: (locale: string): Promise<SwitchOutcome> => {
      if (!switchLocale) {
        throw new Error("not rendered");
      }

      return switchLocale(locale);
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
    },
  };
}

// What collectGarbage counts: nothing makes one, so the count is only the collection queryObjects runs first.
class Collected {
  readonly payload = "collected";
}

// A full collection: queryObjects collects before it counts, and the task before it lets go of every WeakRef target the
// last job read.
async function collectGarbage(): Promise<void> {
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  queryObjects(Collected, { format: "count" });
}

// Unit under test: what a queued switch runs when its mount moved to another router, or changed persist, while it
// waited. Oracle: each router's fake server and rendered loader data, written out: a switch persists and reloads
// through the router that admitted it, with the persist last committed under that router.
describe("Start useLocaleSwitch when its mount changes while a switch is queued", () => {
  const disposals: Array<() => void> = [];

  afterEach(() => {
    for (const dispose of disposals.splice(0)) {
      dispose();
    }
  });

  // The switches go through the switcher's current handle, and two commits under B leave neither fiber holding
  // what the mount committed under A, so only the queued Finnish switch holds it through the collection.
  it("persists a switch queued under one router through that router", async () => {
    const a = await mountRouter();
    const b = await mountRouter();
    const switcher = mountSwitcher();
    disposals.push(switcher.unmount, a.unmount, b.unmount);
    switcher.render(a.router, a.server.persist);
    const sv = switcher.switchLocale("sv");
    const svHeld = await a.server.request(0);
    const fi = switcher.switchLocale("fi");
    switcher.render(b.router, b.server.persist);
    const de = switcher.switchLocale("de");
    switcher.render(b.router, b.server.persist);
    await collectGarbage();
    (await b.server.request(0)).arrive();
    expect((await de)._tag).toBe("Switched");
    svHeld.arrive();
    await vi.waitFor(() => {
      expect(a.server.requests.length + b.server.requests.length).toBe(3);
    });
    expect([
      a.server.requests.map(({ locale }) => locale),
      b.server.requests.map(({ locale }) => locale),
    ]).toEqual([["sv", "fi"], ["de"]]);
    (await a.server.request(1)).arrive();
    expect([(await sv)._tag, (await fi)._tag]).toEqual(["Superseded", "Switched"]);
    expect([a.text(), b.text()]).toEqual(["fi", "de"]);
  });

  // Inside a hidden Activity, React disconnects layout and passive effects, but the commit still lands: the switch
  // must call the persist the hidden switcher committed (its label shows which), not the one before it was hidden.
  it.for([["visible"], ["hidden"]] as const)(
    "calls the persist committed while the switch waited (%s)",
    async ([activity], { skip }) => {
      skip(activity === "hidden" && !HAS_ACTIVITY, "a hidden Activity needs React 19.2");
      const page = await mountRouter();
      const switcher = mountSwitcher();
      disposals.push(switcher.unmount, page.unmount);
      const called: Array<string> = [];
      const tagged =
        (version: string) =>
        (locale: string): Promise<void> => {
          called.push(`${version} ${locale}`);

          return page.server.persist(locale);
        };
      switcher.render(page.router, tagged("v0"), { label: "v0" });
      const sv = switcher.switchLocale("sv");
      const svHeld = await page.server.request(0);
      const fi = switcher.switchLocale("fi");
      switcher.render(page.router, tagged("v1"), { label: "v1", activity });
      await vi.waitFor(() => {
        expect(switcher.text()).toBe("v1");
      });
      svHeld.arrive();
      (await page.server.request(1)).arrive();
      expect([(await sv)._tag, (await fi)._tag]).toEqual(["Superseded", "Switched"]);
      expect([called, page.text()]).toEqual([["v0 sv", "v1 fi"], "fi"]);
    }
  );

  // A queued switch keeps reading its first router's box while the mount is away, so the persist the mount commits
  // on its return to that router is the one the switch calls.
  it("calls the persist committed on the mount's return to the router that admitted the switch", async () => {
    const a = await mountRouter();
    const b = await mountRouter();
    const switcher = mountSwitcher();
    disposals.push(switcher.unmount, a.unmount, b.unmount);
    const called: Array<string> = [];
    const tagged =
      (version: string) =>
      (locale: string): Promise<void> => {
        called.push(`${version} ${locale}`);

        return a.server.persist(locale);
      };
    switcher.render(a.router, tagged("a0"));
    const sv = switcher.switchLocale("sv");
    const svHeld = await a.server.request(0);
    const fi = switcher.switchLocale("fi");
    switcher.render(b.router, b.server.persist);
    switcher.render(a.router, tagged("a1"));
    svHeld.arrive();
    (await a.server.request(1)).arrive();
    expect([(await sv)._tag, (await fi)._tag]).toEqual(["Superseded", "Switched"]);
    expect([called, a.text(), b.server.requests]).toEqual([["a0 sv", "a1 fi"], "fi", []]);
  });
});

// Unit under test: the hook's hydration. Oracle: a server request has no switch in flight, so its markup reads
// isPending false; a hydration commits that value before the client's, so the markup matches.
describe("Start useLocaleSwitch hydrating", () => {
  it("hydrates idle server markup while another mount holds a switch, then shows it pending", async () => {
    const page = await mountRouter();
    const holder = mountSwitcher();
    holder.render(page.router, page.server.persist);
    const nb = holder.switchLocale("nb");
    const nbHeld = await page.server.request(0);
    const committed: Array<boolean> = [];
    function Switcher() {
      const { isPending } = useLocaleSwitch(() => undefined);
      useLayoutEffect(() => {
        committed.push(isPending);
      }, [isPending]);

      return <p>{String(isPending)}</p>;
    }
    const container = document.createElement("div");
    // The server's markup: a request renders with no switch of its own in flight.
    container.innerHTML = "<p>false</p>";
    const errors: Array<unknown> = [];
    const root = hydrateRoot(
      container,
      <RouterContextProvider router={page.router}>
        <Switcher />
      </RouterContextProvider>,
      {
        onRecoverableError: (error) => {
          errors.push(error);
        },
      }
    );
    try {
      await vi.waitFor(() => {
        expect(committed).toEqual([false, true]);
      });
      expect(errors).toEqual([]);
    } finally {
      act(() => {
        root.unmount();
      });
      nbHeld.arrive();
      await nb;
      holder.unmount();
      page.unmount();
    }
  });
});
