import { act, useLayoutEffect, useState } from "react";

// @vitest-environment jsdom
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LocaleSwitchOptions, SwitchOutcome } from "../src/next";
import { useLocaleSwitch } from "../src/next";
import { sweepSettlement } from "./switch-settlement";

// Persist resolves on its own schedule (a held fake server), outside act().
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });

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

// A client component under the App Router context useRouter reads; persist is a request the test releases, per
// locale through `release`.
function mount(
  options: LocaleSwitchOptions,
  release: (locale: string) => Promise<void>,
  log: Array<string> = []
): Mounted {
  let persisting = 0;
  let switchLocale: ((locale: string) => Promise<SwitchOutcome>) | undefined;
  let rerender: (() => void) | undefined;
  const history: Array<string> = [];
  const persist = async (locale: string): Promise<void> => {
    persisting += 1;
    await release(locale);
  };
  const router: AppRouterInstance = {
    back: () => undefined,
    forward: () => undefined,
    refresh: () => undefined,
    push: () => undefined,
    replace: () => undefined,
    prefetch: () => undefined,
    bfcacheId: "test",
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
