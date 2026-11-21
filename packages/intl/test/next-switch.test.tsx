import { act } from "react";

// @vitest-environment jsdom
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LocaleSwitchOptions, SwitchOutcome } from "../src/next";
import { useLocaleSwitch } from "../src/next";

// Persist resolves on its own schedule (a held fake server), outside act().
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });

type Mounted = {
  readonly pending: () => string | null | undefined;
  readonly switchLocale: (locale: string) => Promise<SwitchOutcome>;
  readonly persisting: () => number;
  readonly unmount: () => void;
};

// A client component under the App Router context useRouter reads; persist is a request the test releases.
function mount(options: LocaleSwitchOptions, release: Promise<void>, log: Array<string> = []): Mounted {
  let persisting = 0;
  let switchLocale: ((locale: string) => Promise<SwitchOutcome>) | undefined;
  const persist = async (): Promise<void> => {
    persisting += 1;
    await release;
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
    // A new persist every render (an inline arrow), which must not reset the switch queue.
    const localeSwitch = useLocaleSwitch(async (locale) => {
      log.push(`start ${locale}`);
      await persist();
      log.push(`end ${locale}`);
    }, options);
    switchLocale = localeSwitch.switchLocale;

    return <p>{localeSwitch.isPending ? "pending" : "idle"}</p>;
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

// Unit under test: the Next useLocaleSwitch's isPending. Oracle: a switch whose persist has not resolved is pending.
describe("Next useLocaleSwitch", () => {
  it.each([["router-refresh"], ["server-action"]] as const)(
    "is pending while persist is outstanding (%s)",
    async (refresh) => {
      const held = Promise.withResolvers<void>();
      const app = mount({ refresh }, held.promise);
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
    "runs switches one at a time when persist is a new function every render (%s)",
    async (refresh) => {
      const held = Promise.withResolvers<void>();
      const log: Array<string> = [];
      const app = mount({ refresh }, held.promise, log);
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
