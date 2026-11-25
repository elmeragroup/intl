import { describe, expect, it } from "vitest";

import type { SwitchOutcome } from "@elmeragroup/intl/core";
import { createLocaleSwitcher } from "@elmeragroup/intl/core";

import { countPending } from "../src/adapter";
import type { MakeSwitch } from "./switch-settlement";
import { fakeServer, sweepSettlement } from "./switch-settlement";

const tags = (outcomes: ReadonlyArray<SwitchOutcome>): ReadonlyArray<string> =>
  outcomes.map((outcome) => outcome._tag);

// Unit under test: createLocaleSwitcher, the latest-switch-wins logic every adapter shares. Oracle: the fake
// server's observable state (stored cookie, rendered locales) and the outcomes in call order, written out per
// interleaving.
describe("locale switch", () => {
  it("persists then refreshes", async () => {
    const server = fakeServer();
    const switchLocale = createLocaleSwitcher(server);
    const done = switchLocale("nb");
    (await server.request(0)).arrive();
    expect(await done).toEqual({ _tag: "Switched", locale: "nb" });
    expect(server.rendered).toEqual(["nb"]);
  });

  it("lets the newest switch decide the stored locale and the render", async () => {
    const server = fakeServer();
    const switchLocale = createLocaleSwitcher(server);
    const first = switchLocale("nb");
    const nb = await server.request(0);
    const second = switchLocale("sv");
    // The second persist is not sent while the first is in flight, so it cannot overtake it at the server. The
    // switcher only chains promises, so one macrotask turn drains every microtask an eager send would need.
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(server.requests.map((r) => r.locale)).toEqual(["nb"]);
    nb.arrive();
    (await server.request(1)).arrive();
    expect(await first).toEqual({ _tag: "Superseded", locale: "nb" });
    expect(await second).toEqual({ _tag: "Switched", locale: "sv" });
    expect([server.cookie(), server.rendered]).toEqual(["sv", ["sv"]]);
  });

  it("skips the persist of a switch superseded before it started", async () => {
    const server = fakeServer();
    const switchLocale = createLocaleSwitcher(server);
    const first = switchLocale("nb");
    const nb = await server.request(0);
    const middle = switchLocale("sv");
    const last = switchLocale("fi");
    nb.arrive();
    (await server.request(1)).arrive();
    expect(tags(await Promise.all([first, middle, last]))).toEqual(["Superseded", "Superseded", "Switched"]);
    expect(server.requests.map((r) => r.locale)).toEqual(["nb", "fi"]);
    expect(server.rendered).toEqual(["fi"]);
  });

  it("never lands an older refresh after a newer one", async () => {
    const server = fakeServer(["hold", "hold"]);
    const switchLocale = createLocaleSwitcher(server);
    const first = switchLocale("nb");
    (await server.request(0)).arrive();
    const firstRefresh = await server.refresh(0);
    const second = switchLocale("sv");
    // The newer switch waits for the older refresh, so their renders land in call order.
    expect(server.requests).toHaveLength(1);
    firstRefresh.render();
    (await server.request(1)).arrive();
    (await server.refresh(1)).render();
    expect(await first).toEqual({ _tag: "Superseded", locale: "nb" });
    expect(await second).toEqual({ _tag: "Switched", locale: "sv" });
    expect(server.rendered).toEqual(["nb", "sv"]);
  });

  it("re-renders the stored locale when the newest persist fails after an older one stored", async () => {
    const server = fakeServer();
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

  it("reports an older switch whose persist failed after a newer one started as superseded", async () => {
    const server = fakeServer();
    const switchLocale = createLocaleSwitcher(server);
    const first = switchLocale("nb");
    const nb = await server.request(0);
    const second = switchLocale("sv");
    nb.drop();
    (await server.request(1)).arrive();
    expect(tags(await Promise.all([first, second]))).toEqual(["Superseded", "Switched"]);
    expect([server.cookie(), server.rendered]).toEqual(["sv", ["sv"]]);
  });

  it("reports an older switch whose refresh failed after a newer one started as superseded", async () => {
    const server = fakeServer(["hold"]);
    const switchLocale = createLocaleSwitcher(server);
    const first = switchLocale("nb");
    (await server.request(0)).arrive();
    const firstRefresh = await server.refresh(0);
    const second = switchLocale("sv");
    firstRefresh.fail();
    (await server.request(1)).arrive();
    expect(tags(await Promise.all([first, second]))).toEqual(["Superseded", "Switched"]);
    expect([server.cookie(), server.rendered]).toEqual(["sv", ["sv"]]);
  });

  it("re-renders the stored locale when the newest persist fails after the previous refresh failed", async () => {
    // A's refresh fails while A is still the latest switch; B's recovery refresh renders at once.
    const server = fakeServer(["fail", "render"]);
    const switchLocale = createLocaleSwitcher(server);
    const first = switchLocale("nb");
    (await server.request(0)).arrive();
    const a = await first;
    const second = switchLocale("sv");
    (await server.request(1)).drop();
    expect(tags([a, await second])).toEqual(["RefreshFailed", "PersistFailed"]);
    expect([server.cookie(), server.rendered]).toEqual(["nb", ["nb"]]);
  });

  it("reports a failed persist as superseded when a newer switch starts during its recovery refresh", async () => {
    // B's persist fails after A stored unrendered, so B refreshes to show A; C starts while that refresh is held.
    const server = fakeServer(["hold"]);
    const switchLocale = createLocaleSwitcher(server);
    const settled: Array<string> = [];
    const track = (name: string, outcome: Promise<SwitchOutcome>): Promise<SwitchOutcome> => {
      void outcome.then(() => {
        settled.push(name);
      });

      return outcome;
    };
    const a = track("A", switchLocale("nb"));
    const nb = await server.request(0);
    const b = track("B", switchLocale("sv"));
    nb.arrive();
    (await server.request(1)).drop();
    const recovery = await server.refresh(0);
    const c = track("C", switchLocale("fi"));
    recovery.render();
    (await server.request(2)).arrive();
    expect(tags(await Promise.all([a, b, c]))).toEqual(["Superseded", "Superseded", "Switched"]);
    expect([server.cookie(), server.rendered]).toEqual(["fi", ["nb", "fi"]]);
    expect(settled).toEqual(["A", "B", "C"]);
  });

  const makers: ReadonlyArray<{ readonly name: string; readonly make: MakeSwitch }> = [
    {
      name: "the switcher",
      make: (server) => ({ switchLocale: createLocaleSwitcher(server), dispose: () => undefined }),
    },
    {
      name: "the pending-counted switcher",
      make: (server) => ({
        switchLocale: countPending(createLocaleSwitcher(server), () => undefined),
        dispose: () => undefined,
      }),
    },
  ];

  it.each(makers)(
    "resolves a switch superseded whenever a newer one starts before it settles, through $name",
    async ({ make }) => {
      expect(await sweepSettlement(make), "no step saw A pending").toBe(true);
    }
  );

  // Unit under test: the switcher's handoff from one switch to the next, bare and pending-counted. Oracle: the order
  // a caller observes: an outcome handler attached before the switch settles runs before the next persist is sent,
  // so the caller hears A's outcome before the server hears B.
  it.each(makers)(
    "runs an outcome handler attached before a switch settles before the next persist, through $name",
    async ({ make }) => {
      const log: Array<string> = [];
      const server = fakeServer();
      const { switchLocale } = await make({
        ...server,
        persist: (locale) => {
          log.push(`persist ${locale}`);

          return server.persist(locale);
        },
      });
      const first = switchLocale("nb");
      const nb = await server.request(0);
      const second = switchLocale("sv");
      // Attached after B started and before A settles: B's own step on A's settlement is already queued, so only a
      // switcher that starts B a step after A's settlement runs this handler first.
      void first.then((outcome) => {
        log.push(`nb ${outcome._tag}`);
      });
      nb.arrive();
      (await server.request(1)).arrive();
      await second;
      expect(log).toEqual(["persist nb", "nb Superseded", "persist sv"]);
    }
  );
});
