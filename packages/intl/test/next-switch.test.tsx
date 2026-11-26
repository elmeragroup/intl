import type { ReactNode } from "react";
import {
  act,
  Activity,
  Component,
  startTransition,
  Suspense,
  use,
  useLayoutEffect,
  useState,
  version as REACT_VERSION,
} from "react";

// @vitest-environment jsdom
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import { createRoot, hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LocaleSwitchOptions, SwitchOutcome } from "../src/next";
import { useLocaleSwitch } from "../src/next";
import { fakeServer, sweepSettlement } from "./switch-settlement";

// Persist resolves on its own schedule (a held fake server), outside act().
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

type Mounted = {
  readonly pending: () => string | null | undefined;
  /** isPending in each committed render, consecutive repeats collapsed. */
  readonly history: () => ReadonlyArray<string>;
  /** Re-render, and wait for that render to commit: it shows every state update queued before the call. */
  readonly commit: () => Promise<void>;
  readonly switchLocale: (locale: string) => Promise<SwitchOutcome>;
  readonly persisting: () => number;
  readonly unmount: () => void;
};

type RouterMethods = {
  readonly refresh?: (this: AppRouterInstance) => void;
  readonly back?: () => void;
};

// The App Router instance a test's provider holds: its own, so its switches share a queue only with the mounts
// under this same value, as each test's page has its own router.
function testRouter({
  refresh = () => undefined,
  back = () => undefined,
}: RouterMethods = {}): AppRouterInstance {
  return {
    back,
    forward: () => undefined,
    refresh,
    push: () => undefined,
    replace: () => undefined,
    prefetch: () => undefined,
    bfcacheId: "test",
  };
}

// A client component under the App Router context useRouter reads; persist is a request the test releases, per
// locale through `release`.
function mount(
  options: LocaleSwitchOptions,
  release: (locale: string) => Promise<void>,
  log: Array<string> = [],
  router: AppRouterInstance = testRouter()
): Mounted {
  let persisting = 0;
  let switchLocale: ((locale: string) => Promise<SwitchOutcome>) | undefined;
  let rerender: (() => void) | undefined;
  const history: Array<string> = [];
  const persist = async (locale: string): Promise<void> => {
    persisting += 1;
    await release(locale);
  };
  function Switcher() {
    const [renders, setRenders] = useState(0);
    // A new persist every render (an inline arrow), which must not reset the switch queue.
    const localeSwitch = useLocaleSwitch(async (locale) => {
      log.push(`start ${locale}`);
      await persist(locale);
      log.push(`end ${locale}`);
    }, options);
    const state = localeSwitch.isPending ? "pending" : "idle";
    switchLocale = localeSwitch.switchLocale;
    rerender = () => {
      setRenders((count) => count + 1);
    };
    // Recorded on commit, so a render React discards never enters the history.
    useLayoutEffect(() => {
      if (history.at(-1) !== state) {
        history.push(state);
      }
    }, [state]);

    return <p data-renders={renders}>{state}</p>;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <AppRouterContext.Provider value={router}>
        <Switcher />
      </AppRouterContext.Provider>
    );
  });

  return {
    pending: () => container.textContent,
    history: () => history,
    commit: async () => {
      const before = container.querySelector("p")?.dataset.renders;
      rerender?.();
      await vi.waitFor(() => {
        expect(container.querySelector("p")?.dataset.renders).not.toBe(before);
      });
    },
    switchLocale: (locale) => {
      if (!switchLocale) {
        throw new Error("not rendered");
      }

      return switchLocale(locale);
    },
    persisting: () => persisting,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

let mounted: Mounted | undefined;

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

// Unit under test: the Next useLocaleSwitch's isPending. Oracle: a switch whose persist has not settled is pending,
// and a settled one, however it ended, is not.
describe("Next useLocaleSwitch", () => {
  it.each([["router-refresh"], ["server-action"]] as const)(
    "is pending while persist is outstanding (%s)",
    async (refresh) => {
      const held = Promise.withResolvers<void>();
      const app = mount({ refresh }, () => held.promise);
      mounted = app;
      const outcome = app.switchLocale("nb");
      await vi.waitFor(() => {
        expect(app.persisting()).toBe(1);
      });
      await vi.waitFor(() => {
        expect(app.pending()).toBe("pending");
      });
      held.resolve();
      expect((await outcome)._tag).toBe("Switched");
      await vi.waitFor(() => {
        expect(app.pending()).toBe("idle");
      });
    }
  );

  it.each([["router-refresh"], ["server-action"]] as const)(
    "returns to idle after a persist that fails (%s)",
    async (refresh) => {
      const held = Promise.withResolvers<void>();
      const app = mount({ refresh }, () => held.promise);
      mounted = app;
      const outcome = app.switchLocale("nb");
      await vi.waitFor(() => {
        expect(app.pending()).toBe("pending");
      });
      held.reject(new Error("offline"));
      expect((await outcome)._tag).toBe("PersistFailed");
      await vi.waitFor(() => {
        expect(app.pending()).toBe("idle");
      });
    }
  );

  // Oracle: a switch is in flight from A's call until B settles, so isPending never reads idle in between, even in a
  // render committed after A settled while B's persist is held.
  it.each([["router-refresh"], ["server-action"]] as const)(
    "stays pending across the handoff from one switch to the next (%s)",
    async (refresh) => {
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
      const app = mount({ refresh }, (locale) => gate(locale).promise);
      mounted = app;
      const first = app.switchLocale("nb");
      await vi.waitFor(() => {
        expect(app.pending()).toBe("pending");
      });
      const second = app.switchLocale("sv");
      gate("nb").resolve();
      expect((await first)._tag).toBe("Superseded");
      await vi.waitFor(() => {
        expect(app.persisting()).toBe(2);
      });
      await app.commit();
      expect(app.pending()).toBe("pending");
      gate("sv").resolve();
      expect((await second)._tag).toBe("Switched");
      await vi.waitFor(() => {
        expect(app.pending()).toBe("idle");
      });
      expect(app.history()).toEqual(["idle", "pending", "idle"]);
    }
  );

  // Unit under test: the switchLocale the mounted hook returns, through the shared settlement sweep. Oracle: the
  // sweep's invariant (a switch a newer one started before it settled resolves Superseded), which a wrapper the hook
  // adds after the switcher's classification would break.
  it.each([["router-refresh"], ["server-action"]] as const)(
    "resolves a switch superseded whenever a newer one starts before it settles (%s)",
    async (refresh) => {
      const sawPending = await sweepSettlement((server) => {
        const app = mount({ refresh }, (locale) => server.persist(locale));

        return { switchLocale: app.switchLocale, dispose: app.unmount };
      });
      expect(sawPending, "no step saw A pending").toBe(true);
    }
  );

  it.each([["router-refresh"], ["server-action"]] as const)(
    "runs switches one at a time when persist is a new function every render (%s)",
    async (refresh) => {
      const held = Promise.withResolvers<void>();
      const log: Array<string> = [];
      const app = mount({ refresh }, () => held.promise, log);
      mounted = app;
      const first = app.switchLocale("nb");
      await vi.waitFor(() => {
        expect(app.pending()).toBe("pending");
      });
      const second = app.switchLocale("sv");
      held.resolve();
      expect([(await first)._tag, (await second)._tag]).toEqual(["Superseded", "Switched"]);
      expect(log).toEqual(["start nb", "end nb", "start sv", "end sv"]);
    }
  );
});

// The page's one App Router, shared by every mount under it, refreshing against a fake server: its refresh renders
// what the server's cookie says. A Server Action persist renders in its own response, so in that mode persist renders
// once its request arrives.
function routedServer(refresh: LocaleSwitchOptions["refresh"]) {
  const server = fakeServer();
  const router = testRouter({
    refresh: () => {
      void server.refreshServer();
    },
  });
  const persist = async (locale: string): Promise<void> => {
    await server.persist(locale);
    if (refresh === "server-action") {
      server.rendered.push(server.cookie());
    }
  };

  return { server, router, persist };
}

// The Next example has no browser spec for this: its own navigation (the sidebar link) waits for a held Server Action
// to answer, so the visitor cannot remount its switcher while a switch is held there. The mounts below share one App
// Router context without that navigation, which is what any other unmount (a conditional render, a dialog) does.
// Unit under test: the queue every useLocaleSwitch under one App Router shares. Oracle: the outcomes in call order and
// the fake server's stored cookie and rendered list, written out per interleaving: one queue lets the newest switch
// decide, so an older switch held in a mount that unmounted cannot land after a newer one from the next mount.
describe("Next useLocaleSwitch across mounts", () => {
  const mounts: Array<Mounted> = [];
  const track = (app: Mounted): Mounted => {
    mounts.push(app);

    return app;
  };

  afterEach(() => {
    for (const app of mounts.splice(0)) {
      app.unmount();
    }
  });

  // A Server Action's own response renders what it stored, so in that mode the older switch's render lands first.
  it.each([
    ["router-refresh", ["fi"]],
    ["server-action", ["sv", "fi"]],
  ] as const)(
    "lets the newest switch win when the switcher remounted while an older one was held (%s)",
    async (refresh, rendered) => {
      const { server, router, persist } = routedServer(refresh);
      const events: Array<string> = [];
      const logged = (locale: string): Promise<void> => {
        events.push(`persist ${locale}`);

        return persist(locale);
      };
      const a = mount({ refresh }, logged, [], router);
      const sv = a.switchLocale("sv");
      void sv.then(() => {
        events.push("sv settled");
      });
      const held = await server.request(0);
      a.unmount();
      const b = track(mount({ refresh }, logged, [], router));
      const fi = b.switchLocale("fi");
      held.arrive();
      (await server.request(1)).arrive();
      const outcomes = [(await sv)._tag, (await fi)._tag];
      // One queue holds Finnish until Swedish has ended, so Swedish cannot answer last.
      expect(events).toEqual(["persist sv", "sv settled", "persist fi"]);
      expect(outcomes).toEqual(["Superseded", "Switched"]);
      expect([server.cookie(), server.rendered]).toEqual(["fi", rendered]);
    }
  );

  it("shows a switch held in one mount as pending in another, from that mount's first commit", async () => {
    const held = Promise.withResolvers<void>();
    const router = testRouter();
    const a = track(mount({}, () => held.promise, [], router));
    const outcome = a.switchLocale("nb");
    await vi.waitFor(() => {
      expect(a.persisting()).toBe(1);
    });
    const b = track(mount({}, () => Promise.resolve(), [], router));
    held.resolve();
    expect((await outcome)._tag).toBe("Switched");
    await vi.waitFor(() => {
      expect(b.pending()).toBe("idle");
    });
    expect(b.history()).toEqual(["pending", "idle"]);
  });

  it("keeps separate queues for separate routers", async () => {
    const held = Promise.withResolvers<void>();
    const a = track(mount({}, () => held.promise));
    const b = track(mount({}, () => Promise.resolve()));
    const first = a.switchLocale("nb");
    await vi.waitFor(() => {
      expect(a.persisting()).toBe(1);
    });
    // B's router has its own queue, so its switch started after A's neither supersedes it nor waits for it.
    const second = b.switchLocale("sv");
    held.resolve();
    expect([(await first)._tag, (await second)._tag]).toEqual(["Switched", "Switched"]);
  });

  // A router-refresh switch stores sv and is superseded before it refreshes; the Server Action switch queued behind it
  // then fails to store fi. The page must show what the server stores (sv), through the failing switch's own refresh
  // on its own mount's router, a real router refresh in either mode, also when its mount unmounted while its persist
  // was held.
  it.each([["mounted"], ["unmounted"]] as const)(
    "re-renders the stored locale when a Server Action switch fails after a router-refresh one stored (%s)",
    async (when) => {
      const server = fakeServer();
      // Two mounts' App Router values sharing Next's one navigator `refresh` (so one queue), which reports the router
      // it was called on through that router's own `back`.
      const refreshedBy: Array<string> = [];
      const refresh = function (this: AppRouterInstance): void {
        this.back();
        void server.refreshServer();
      };
      const routerA = testRouter({
        refresh,
        back: () => {
          refreshedBy.push("a");
        },
      });
      const routerB = testRouter({
        refresh,
        back: () => {
          refreshedBy.push("b");
        },
      });
      const a = track(mount({ refresh: "router-refresh" }, server.persist, [], routerA));
      const b = mount({ refresh: "server-action" }, server.persist, [], routerB);
      const sv = a.switchLocale("sv");
      const svHeld = await server.request(0);
      const fi = b.switchLocale("fi");
      svHeld.arrive();
      const fiHeld = await server.request(1);
      if (when === "unmounted") {
        b.unmount();
      } else {
        track(b);
      }
      fiHeld.drop();
      expect([(await sv)._tag, (await fi)._tag]).toEqual(["Superseded", "PersistFailed"]);
      await vi.waitFor(() => {
        expect([server.cookie(), server.rendered, refreshedBy]).toEqual(["sv", ["sv"], ["b"]]);
      });
    }
  );
});

// Unit under test: which persist a queued switch calls. Oracle: the mount's latest committed persist, even when the
// switch ahead of it is released from a layout effect of the very commit that changed it, before passive effects run.
describe("Next useLocaleSwitch's persist", () => {
  it("calls the persist committed while the switch waited", async () => {
    const log: Array<string> = [];
    const gate = Promise.withResolvers<void>();
    let switchLocale: ((locale: string) => Promise<SwitchOutcome>) | undefined;
    function Switcher({ version }: { readonly version: number }) {
      const localeSwitch = useLocaleSwitch(async (locale) => {
        log.push(`v${version} ${locale}`);
        if (locale === "nb") {
          await gate.promise;
        }
      });
      switchLocale = localeSwitch.switchLocale;
      useLayoutEffect(() => {
        if (version === 1) {
          gate.resolve();
        }
      }, [version]);

      return null;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    const app = (version: number) => (
      <AppRouterContext.Provider value={ROUTER}>
        <Switcher version={version} />
      </AppRouterContext.Provider>
    );
    act(() => {
      root.render(app(0));
    });
    try {
      const run = (locale: string) => {
        if (!switchLocale) {
          throw new Error("not rendered");
        }

        return switchLocale(locale);
      };
      const first = run("nb");
      await vi.waitFor(() => {
        expect(log).toEqual(["v0 nb"]);
      });
      const second = run("sv");
      // Not in act(): the commit's passive effects run in a later task, after the released switch has started.
      root.render(app(1));
      expect([(await first)._tag, (await second)._tag]).toEqual(["Superseded", "Switched"]);
      expect(log).toEqual(["v0 nb", "v1 sv"]);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  // A transition renders a new persist and suspends, so the old UI stays: that render never committed, so the switch
  // released meanwhile calls the persist that did.
  it("calls the last committed persist while a newer render is suspended", async () => {
    const log: Array<string> = [];
    const rendered: Array<number> = [];
    const gate = Promise.withResolvers<void>();
    const never = Promise.withResolvers<never>().promise;
    let switchLocale: ((locale: string) => Promise<SwitchOutcome>) | undefined;
    function Switcher({ version }: { readonly version: number }) {
      rendered.push(version);
      const localeSwitch = useLocaleSwitch(async (locale) => {
        log.push(`v${version} ${locale}`);
        if (locale === "nb") {
          await gate.promise;
        }
      });
      switchLocale ??= localeSwitch.switchLocale;
      if (version === 2) {
        use(never);
      }

      return <p>v{version}</p>;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    const app = (version: number) => (
      <AppRouterContext.Provider value={ROUTER}>
        <Suspense fallback="loading">
          <Switcher version={version} />
        </Suspense>
      </AppRouterContext.Provider>
    );
    act(() => {
      root.render(app(0));
    });
    try {
      const run = (locale: string) => {
        if (!switchLocale) {
          throw new Error("not rendered");
        }

        return switchLocale(locale);
      };
      const first = run("nb");
      await vi.waitFor(() => {
        expect(log).toEqual(["v0 nb"]);
      });
      const second = run("sv");
      act(() => {
        root.render(app(1));
      });
      startTransition(() => {
        root.render(app(2));
      });
      await vi.waitFor(() => {
        expect(rendered).toContain(2);
      });
      expect(container.textContent).toBe("v1");
      gate.resolve();
      expect([(await first)._tag, (await second)._tag]).toEqual(["Superseded", "Switched"]);
      expect([log, container.textContent]).toEqual([["v0 nb", "v1 sv"], "v1"]);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });
});

const ROUTER = testRouter();

type SwitcherProps = {
  readonly router: AppRouterInstance;
  readonly persist: (locale: string) => Promise<void>;
  readonly options?: LocaleSwitchOptions;
  /** What the switcher renders, so a test sees which render committed. */
  readonly label?: string;
  /** The mode of the Activity around the switcher. */
  readonly activity?: "visible" | "hidden";
};

// Shows nothing once a render threw, so a switch's error in render leaves the switcher's label off the page.
type BoundaryState = { readonly failed: boolean };

class Boundary extends Component<{ readonly children: ReactNode }, BoundaryState> {
  override state = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

// One switcher that stays mounted while the test changes its App Router context, persist, options and visibility.
function mountSwitcher(initial: SwitcherProps) {
  let switchLocale: ((locale: string) => Promise<SwitchOutcome>) | undefined;
  function Switcher({
    persist,
    options,
    label,
  }: Required<Pick<SwitcherProps, "persist" | "options" | "label">>) {
    switchLocale = useLocaleSwitch(persist, options).switchLocale;

    return <p>{label}</p>;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = ({
    router,
    persist,
    options = {},
    label = "switcher",
    activity = "visible",
  }: SwitcherProps): void => {
    act(() => {
      root.render(
        <Boundary>
          <AppRouterContext.Provider value={router}>
            <Placed activity={activity}>
              <Switcher persist={persist} options={options} label={label} />
            </Placed>
          </AppRouterContext.Provider>
        </Boundary>
      );
    });
  };
  render(initial);

  return {
    render,
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

// A page whose refresh and Server Action each record the render they produced: `router <cookie>` for a router refresh,
// `action <cookie>` for an action's own response. A cookie-only persist renders nothing.
function recordingServer() {
  const server = fakeServer();
  const rendered: Array<string> = [];
  const router = testRouter({
    refresh: () => {
      rendered.push(`router ${server.cookie()}`);
    },
  });
  const action = async (locale: string): Promise<void> => {
    await server.persist(locale);
    rendered.push(`action ${server.cookie()}`);
  };

  return { server, rendered, router, action };
}

// Unit under test: what a queued switch runs when its mount's router or props changed while it waited. Oracle: each
// fake server's stored cookie, requests and renders, written out per interleaving: a switch persists and refreshes
// through the router that admitted it, with the persist and refresh mode last committed together under that router.
describe("Next useLocaleSwitch when its mount changes while a switch is queued", () => {
  const apps: Array<{ readonly unmount: () => void }> = [];

  afterEach(() => {
    for (const app of apps.splice(0)) {
      app.unmount();
    }
  });

  it("persists a switch queued under one router through that router after the mount moved to another", async () => {
    const a = fakeServer();
    const b = fakeServer();
    const routerA = testRouter({
      refresh: () => {
        void a.refreshServer();
      },
    });
    const routerB = testRouter({
      refresh: () => {
        void b.refreshServer();
      },
    });
    const app = mountSwitcher({ router: routerA, persist: a.persist });
    apps.push(app);
    const sv = app.switchLocale("sv");
    const svHeld = await a.request(0);
    const fi = app.switchLocale("fi");
    app.render({ router: routerB, persist: b.persist });
    const de = app.switchLocale("de");
    (await b.request(0)).arrive();
    expect((await de)._tag).toBe("Switched");
    svHeld.arrive();
    await vi.waitFor(() => {
      expect(a.requests.length + b.requests.length).toBe(3);
    });
    expect([a.requests.map(({ locale }) => locale), b.requests.map(({ locale }) => locale)]).toEqual([
      ["sv", "fi"],
      ["de"],
    ]);
    (await a.request(1)).arrive();
    expect([(await sv)._tag, (await fi)._tag]).toEqual(["Superseded", "Switched"]);
    expect([a.cookie(), a.rendered, b.cookie(), b.rendered]).toEqual(["fi", ["fi"], "de", ["de"]]);
  });

  // Inside a hidden Activity, React disconnects layout and passive effects, but the commit still lands: the switch
  // must use the props the hidden switcher committed (its label shows which), not the ones before it was hidden.
  it.for([["visible"], ["hidden"]] as const)(
    "runs a queued switch with the persist and refresh mode committed together while it waited (%s)",
    async ([activity], { skip }) => {
      skip(activity === "hidden" && !HAS_ACTIVITY, "a hidden Activity needs React 19.2");
      const { server, rendered, router, action } = recordingServer();
      const app = mountSwitcher({
        router,
        persist: action,
        options: { refresh: "server-action" },
        label: "v0",
      });
      apps.push(app);
      const sv = app.switchLocale("sv");
      const svHeld = await server.request(0);
      const fi = app.switchLocale("fi");
      app.render({
        router,
        persist: server.persist,
        options: { refresh: "router-refresh" },
        label: "v1",
        activity,
      });
      await vi.waitFor(() => {
        expect(app.text()).toBe("v1");
      });
      svHeld.arrive();
      (await server.request(1)).arrive();
      expect([(await sv)._tag, (await fi)._tag]).toEqual(["Superseded", "Switched"]);
      expect([server.cookie(), rendered]).toEqual(["fi", ["action sv", "router fi"]]);
    }
  );

  // A switch stores sv and is superseded before it refreshes; each later switch fails to store its own locale, so its
  // recovery refresh must render sv. The first recovery's router.refresh() throws, which leaves sv unrendered, and the
  // switcher rendered: the throw is the switch's outcome, not an error of the switcher's render.
  it("recovers on a later failed persist after a recovery refresh threw", async () => {
    const server = fakeServer();
    let refreshes = 0;
    const router = testRouter({
      refresh: () => {
        refreshes += 1;
        if (refreshes === 1) {
          throw new Error("navigator gone");
        }
        void server.refreshServer();
      },
    });
    const app = mountSwitcher({ router, persist: server.persist });
    apps.push(app);
    const sv = app.switchLocale("sv");
    const svHeld = await server.request(0);
    const fi = app.switchLocale("fi");
    svHeld.arrive();
    (await server.request(1)).drop();
    expect([(await sv)._tag, (await fi)._tag, refreshes, server.rendered]).toEqual([
      "Superseded",
      "PersistFailed",
      1,
      [],
    ]);
    const nb = app.switchLocale("nb");
    (await server.request(2)).drop();
    expect([(await nb)._tag, refreshes, server.rendered]).toEqual(["PersistFailed", 2, ["sv"]]);
    // A commit after the outcomes, in which React would show an error the refresh left in its transition.
    app.render({ router, persist: server.persist, label: "after" });
    expect(app.text()).toBe("after");
  });

  it("reports RefreshFailed with router.refresh()'s own error after a persist, and keeps the switcher", async () => {
    const server = fakeServer();
    const gone = new Error("navigator gone");
    const router = testRouter({
      refresh: () => {
        throw gone;
      },
    });
    const app = mountSwitcher({ router, persist: server.persist });
    apps.push(app);
    const sv = app.switchLocale("sv");
    (await server.request(0)).arrive();
    const outcome = await sv;
    app.render({ router, persist: server.persist, label: "after" });
    expect([outcome._tag, app.text()]).toEqual(["RefreshFailed", "after"]);
    // The very error router.refresh() threw, not a copy.
    expect(outcome._tag === "RefreshFailed" && outcome.cause).toBe(gone);
  });
});

// Unit under test: the hook's server render and its hydration. Oracle: a server render has no switch in flight, so
// isPending is false, and a hydration commits the server's value before the client's, so the markup matches.
describe("Next useLocaleSwitch on the server", () => {
  it("renders isPending false", () => {
    function Switcher() {
      return <p>{String(useLocaleSwitch(() => undefined).isPending)}</p>;
    }
    expect(
      renderToString(
        <AppRouterContext.Provider value={ROUTER}>
          <Switcher />
        </AppRouterContext.Provider>
      )
    ).toBe("<p>false</p>");
  });

  it("hydrates idle server markup while another mount holds a switch, then shows it pending", async () => {
    const held = Promise.withResolvers<void>();
    const router = testRouter();
    const holder = mount({}, () => held.promise, [], router);
    const outcome = holder.switchLocale("nb");
    await vi.waitFor(() => {
      expect(holder.persisting()).toBe(1);
    });
    const committed: Array<boolean> = [];
    function Switcher() {
      const { isPending } = useLocaleSwitch(() => undefined);
      useLayoutEffect(() => {
        committed.push(isPending);
      }, [isPending]);

      return <p>{String(isPending)}</p>;
    }
    const page = (
      <AppRouterContext.Provider value={router}>
        <Switcher />
      </AppRouterContext.Provider>
    );
    const container = document.createElement("div");
    // The server's markup: a request renders with no switch of its own in flight.
    container.innerHTML = "<p>false</p>";
    const errors: Array<unknown> = [];
    const root = hydrateRoot(container, page, {
      onRecoverableError: (error) => {
        errors.push(error);
      },
    });
    try {
      await vi.waitFor(() => {
        expect(committed).toEqual([false, true]);
      });
      expect(errors).toEqual([]);
    } finally {
      act(() => {
        root.unmount();
      });
      held.resolve();
      await outcome;
      holder.unmount();
    }
  });
});
