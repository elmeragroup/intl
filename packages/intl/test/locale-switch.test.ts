import { describe, expect, it, vi } from "vitest";

import { createLocaleSwitcher } from "@elmeragroup/intl/core";

type HeldRequest = { readonly locale: string; readonly arrive: () => void; readonly drop: () => void };

// A server that stores the locale cookie when a persist request arrives and renders whatever the cookie says on
// refresh. Requests are held until the test lets them arrive, so it controls the interleaving.
function fakeServer(options: { readonly heldRefresh: boolean }) {
  let cookie = "en";
  const rendered: Array<string> = [];
  const requests: Array<HeldRequest> = [];
  const refreshes: Array<() => void> = [];
  const persist = async (locale: string): Promise<void> => {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    requests.push({
      locale,
      arrive: () => {
        cookie = locale;
        resolve();
      },
      drop: () => {
        reject(new Error("offline"));
      },
    });

    return promise;
  };
  const refreshServer = async (): Promise<void> => {
    if (!options.heldRefresh) {
      rendered.push(cookie);

      return;
    }

    const { promise, resolve } = Promise.withResolvers<void>();
    refreshes.push(() => {
      rendered.push(cookie);
      resolve();
    });

    return promise;
  };
  const request = async (index: number): Promise<HeldRequest> => {
    await vi.waitFor(() => {
      expect(requests.length).toBeGreaterThan(index);
    });
    const held = requests[index];

    if (!held) {
      throw new Error(`request ${index} never arrived`);
    }

    return held;
  };
  const refresh = async (index: number): Promise<() => void> => {
    await vi.waitFor(() => {
      expect(refreshes.length).toBeGreaterThan(index);
    });
    const held = refreshes[index];

    if (!held) {
      throw new Error(`refresh ${index} never started`);
    }

    return held;
  };

  return { persist, refreshServer, request, refresh, rendered, requests, cookie: () => cookie };
}

// Unit under test: createLocaleSwitcher, the latest-switch-wins logic every adapter shares. Oracle: the fake
// server's observable state (stored cookie, rendered locales) and the outcomes, written out per interleaving.
describe("locale switch", () => {
  it("persists then refreshes", async () => {
    const server = fakeServer({ heldRefresh: false });
    const switchLocale = createLocaleSwitcher(server);
    const done = switchLocale("nb");
    (await server.request(0)).arrive();
    expect(await done).toEqual({ _tag: "Switched", locale: "nb" });
    expect(server.rendered).toEqual(["nb"]);
  });

  it("lets the newest switch decide the stored locale and the render", async () => {
    const server = fakeServer({ heldRefresh: false });
    const switchLocale = createLocaleSwitcher(server);
    const first = switchLocale("nb");
    const nb = await server.request(0);
    const second = switchLocale("sv");
    // The second persist is not sent while the first is in flight, so it cannot overtake it at the server. The
    // switcher only chains promises, so one macrotask turn drains every microtask an eager send would need.
    await new Promise((resolve) => setImmediate(resolve));
    expect(server.requests.map((r) => r.locale)).toEqual(["nb"]);
    nb.arrive();
    (await server.request(1)).arrive();
    expect(await first).toEqual({ _tag: "Superseded", locale: "nb" });
    expect(await second).toEqual({ _tag: "Switched", locale: "sv" });
    expect([server.cookie(), server.rendered]).toEqual(["sv", ["sv"]]);
  });

  it("skips the persist of a switch superseded before it started", async () => {
    const server = fakeServer({ heldRefresh: false });
    const switchLocale = createLocaleSwitcher(server);
    const first = switchLocale("nb");
    const nb = await server.request(0);
    const middle = switchLocale("sv");
    const last = switchLocale("fi");
    nb.arrive();
    (await server.request(1)).arrive();
    expect((await Promise.all([first, middle, last])).map((outcome) => outcome._tag)).toEqual([
      "Superseded",
      "Superseded",
      "Switched",
    ]);
    expect(server.requests.map((r) => r.locale)).toEqual(["nb", "fi"]);
    expect(server.rendered).toEqual(["fi"]);
  });

  it("never lands an older refresh after a newer one", async () => {
    const server = fakeServer({ heldRefresh: true });
    const switchLocale = createLocaleSwitcher(server);
    const first = switchLocale("nb");
    (await server.request(0)).arrive();
    const firstRefresh = await server.refresh(0);
    const second = switchLocale("sv");
    // The newer switch waits for the older refresh, so their renders land in call order.
    expect(server.requests).toHaveLength(1);
    firstRefresh();
    (await server.request(1)).arrive();
    (await server.refresh(1))();
    expect(await first).toEqual({ _tag: "Superseded", locale: "nb" });
    expect(await second).toEqual({ _tag: "Switched", locale: "sv" });
    expect(server.rendered).toEqual(["nb", "sv"]);
  });

  it("re-renders the stored locale when the newest persist fails after an older one stored", async () => {
    const server = fakeServer({ heldRefresh: false });
    const switchLocale = createLocaleSwitcher(server);
    const first = switchLocale("nb");
    const nb = await server.request(0);
    const second = switchLocale("sv");
    nb.arrive();
    (await server.request(1)).drop();
    expect(await first).toEqual({ _tag: "Superseded", locale: "nb" });
    expect((await second)._tag).toBe("PersistFailed");
    expect([server.cookie(), server.rendered]).toEqual(["nb", ["nb"]]);
  });

  it("reports a failed refresh", async () => {
    const switchLocale = createLocaleSwitcher({
      persist: () => Promise.resolve(),
      refreshServer: () => Promise.reject(new Error("router gone")),
    });
    expect((await switchLocale("nb"))._tag).toBe("RefreshFailed");
  });
});
