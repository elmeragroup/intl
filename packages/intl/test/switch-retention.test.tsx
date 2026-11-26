import type { ReactNode } from "react";
import * as React from "react";
import { act } from "react";

import { loadBindings, minify } from "next/dist/build/swc/index.js";
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import * as NextNavigation from "next/navigation";

// @vitest-environment jsdom
import type { AnyRouter } from "@tanstack/react-router";
import * as TanStackRouter from "@tanstack/react-router";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { rolldown } from "rolldown";
import { describe, expect, it, vi } from "vitest";

import { useLocaleSwitch as useNextSwitch } from "../src/next";
import type { LocaleSwitch } from "../src/start";
import { useLocaleSwitch as useStartSwitch } from "../src/start";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// A hang guard only, for each test in this file: one took at most 0.05 s idle and 0.25 s with this machine's cores four
// times oversubscribed at lowest priority, where the heap walk the count below replaced took 2.1 s there, and 5.1 s on a
// loaded CI runner.
vi.setConfig({ testTimeout: 30_000 });

type Persist = (locale: string) => Promise<void>;
type UseSwitch = (persist: Persist) => LocaleSwitch;
type Hosts = { readonly next: UseSwitch; readonly start: UseSwitch };
type Peer = typeof React | typeof NextNavigation | typeof TanStackRouter;
// What a built entry's CommonJS bundle assigns: the host's hook, which public-surface.test.ts checks it exports.
type Entry = { useLocaleSwitch?: UseSwitch };

// The peers the built entries import, handed the instances this test renders with.
const PEERS: ReadonlyMap<string, Peer> = new Map<string, Peer>([
  ["react", React],
  ["next/navigation", NextNavigation],
  ["@tanstack/react-router", TanStackRouter],
]);

// A built entry as a production Next build ships it: bundled with its own chunks, then minified by Next's own SWC
// minifier, which inlines small functions into their callers, so closures that were apart in `src` can share one scope
// (rolldown's minifier keeps them apart). loadBindings loads the native binding Next installs for this platform.
async function minified(entry: string): Promise<UseSwitch> {
  const bundle = await rolldown({
    input: join(import.meta.dirname, "../dist", entry),
    platform: "browser",
    logLevel: "silent",
    external: (id) => PEERS.has(id),
  });
  const { output } = await bundle.generate({ format: "cjs" });
  await bundle.close();
  const [chunk] = output;
  await loadBindings();
  // In a function scope, as in a module, its top-level functions are local, so the minifier may inline them (a
  // script's are globals it keeps).
  const { code } = await minify(`(function (require, exports) {\n${chunk.code}\n})(require, exports);`, {
    compress: true,
    mangle: true,
    module: false,
  });
  const exports: Entry = {};
  // SAFETY: the function body is the wrapped bundle above, which reads the two parameters it names and returns nothing.
  // oxlint-disable-next-line typescript/no-implied-eval -- evaluates the minified bundle the test built, with the test's own peers
  const evaluate = new Function("require", "exports", code) as (
    require: (id: string) => Peer | undefined,
    exports: Entry
  ) => void;
  evaluate((id) => PEERS.get(id), exports);
  if (!exports.useLocaleSwitch) {
    throw new Error(`${entry} exports no useLocaleSwitch`);
  }

  return exports.useLocaleSwitch;
}

async function minifiedHosts(): Promise<Hosts> {
  const [next, start] = await Promise.all([minified("next.js"), minified("start.js")]);

  return { next, start };
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

// V8's own full collection, which the flag exposes to a new context. A major collection marks everything reachable and
// clears every WeakRef whose target it did not mark. It costs a few milliseconds here; v8.queryObjects, which walks the
// whole heap after collecting, took about 0.2 s.
setFlagsFromString("--expose-gc");
// SAFETY: with --expose-gc set, a new context's global `gc` is V8's collection function, called with no arguments.
const collect = runInNewContext("gc") as () => void;

// Persists, each a new function object, every obsolete one tracked by a WeakRef, which alone does not keep it, so the
// obsolete persists still alive after a full collection are what a mount kept that it no longer needs. A task first, so
// no WeakRef made or read in the job that rendered still holds its target. One collection suffices: V8's gc() finishes
// any incremental marking already in progress, then runs a full marking of its own from the roots, which leaves
// unmarked whatever that earlier marking reached and nothing reaches now.
function persists() {
  const obsolete: Array<WeakRef<Persist>> = [];
  const persistFor = (need: "obsolete" | "needed"): Persist => {
    const persist: Persist = () => Promise.resolve();
    if (need === "obsolete") {
      obsolete.push(new WeakRef(persist));
    }

    return persist;
  };
  const retained = async (): Promise<number> => {
    await nextTask();
    collect();

    return obsolete.filter((ref) => ref.deref() !== undefined).length;
  };

  return { persistFor, retained };
}

function root() {
  const container = document.createElement("div");
  const reactRoot: Root = createRoot(container);

  return {
    render: (node: ReactNode): void => {
      act(() => {
        reactRoot.render(node);
      });
    },
    unmount: () => {
      act(() => {
        reactRoot.unmount();
      });
    },
  };
}

function startRouter(): AnyRouter {
  return createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    isServer: false,
  });
}

const nextRouter: AppRouterInstance = {
  back: () => undefined,
  forward: () => undefined,
  refresh: () => undefined,
  push: () => undefined,
  replace: () => undefined,
  prefetch: () => undefined,
  bfcacheId: "test",
};

// Live routers, module-scoped so each one outlives the switcher's stay under it and the count after.
const LIVE_ROUTERS = Array.from({ length: 24 }, () => startRouter());

const BUILDS: ReadonlyArray<readonly [string, Hosts]> = [
  ["source", { next: useNextSwitch, start: useStartSwitch }],
  ["minified build", await minifiedHosts()],
];

// Unit under test: what a mounted useLocaleSwitch keeps reachable, from source and as a production Next build
// minifies it. Oracle: with no switch queued, a mount needs only the persist it committed last, so every persist it
// committed before, under this router or another live one, is garbage once React's alternate fiber has let go of it
// (one more commit).
describe.each(BUILDS)("useLocaleSwitch's retained persists (%s)", (_build, hosts) => {
  function Switcher({ use, persist }: { readonly use: UseSwitch; readonly persist: Persist }) {
    use(persist);

    return null;
  }

  it("lets go of what a Start switcher committed under each router it left", async () => {
    const { persistFor, retained } = persists();
    const app = root();
    const show = (router: AnyRouter, need: "obsolete" | "needed"): void => {
      app.render(
        <RouterContextProvider router={router}>
          <Switcher use={hosts.start} persist={persistFor(need)} />
        </RouterContextProvider>
      );
    };
    try {
      for (const router of LIVE_ROUTERS) {
        show(router, "obsolete");
      }
      const last = LIVE_ROUTERS.at(-1);
      if (!last) {
        throw new Error("no router");
      }
      // The final router's own persist replaced, then one more commit, which leaves the one before on the alternate
      // fiber.
      show(last, "needed");
      show(last, "needed");
      expect(await retained()).toBe(0);
    } finally {
      app.unmount();
    }
  });

  it.each(["start", "next"] as const)(
    "lets go of the first persists a %s switcher committed under one router",
    async (host) => {
      const { persistFor, retained } = persists();
      const router = startRouter();
      const app = root();
      const show = (need: "obsolete" | "needed"): void => {
        app.render(
          <AppRouterContext.Provider value={nextRouter}>
            <RouterContextProvider router={router}>
              <Switcher use={hosts[host]} persist={persistFor(need)} />
            </RouterContextProvider>
          </AppRouterContext.Provider>
        );
      };
      try {
        // The third stays on the alternate fiber, the fourth is committed.
        for (const need of ["obsolete", "obsolete", "needed", "needed"] as const) {
          show(need);
        }
        expect(await retained()).toBe(0);
      } finally {
        app.unmount();
      }
    }
  );
});
