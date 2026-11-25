import { describe, expect, it } from "vitest";

import type { SwitchOutcome } from "@elmeragroup/intl/core";
import { createLocaleSwitcher } from "@elmeragroup/intl/core";

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

  it("resolves a switch superseded whenever a newer one starts before it settles", async () => {
    const sawPending = await sweepSettlement((server) => ({
      switchLocale: createLocaleSwitcher(server),
      dispose: () => undefined,
    }));
    expect(sawPending, "no step saw A pending").toBe(true);
  });

  // Unit under test: the switcher's handoff from one switch to the next. Oracle: the order a caller observes: an
  // outcome handler attached before the switch settles runs before the next persist is sent, so the caller hears A's
  // outcome before the server hears B.
  it("runs an outcome handler attached before a switch settles before the next persist", async () => {
    const log: Array<string> = [];
    const server = fakeServer();
    const switchLocale = createLocaleSwitcher({
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
  });

  // Unit under test: how the switcher calls the app's port. Oracle: the port's own contract, persist then refresh on
  // the port itself: a method reading `this` keeps its receiver, and a property the contract does not name changes
  // nothing.
  it("calls a class-based port's methods on the port", async () => {
    class CookiePort {
      readonly rendered: Array<string> = [];
      private stored = "en";
      persist(locale: string): void {
        this.stored = locale;
      }
      refreshServer(): void {
        this.rendered.push(this.stored);
      }
    }
    const port = new CookiePort();
    expect(await createLocaleSwitcher(port)("nb")).toEqual({ _tag: "Switched", locale: "nb" });
    expect(port.rendered).toEqual(["nb"]);
  });

  it("refreshes a port that carries a property of its own", async () => {
    const server = fakeServer();
    const port = { persist: server.persist, refreshServer: server.refreshServer, rendersOnPersist: true };
    const done = createLocaleSwitcher(port)("nb");
    (await server.request(0)).arrive();
    expect([(await done)._tag, server.rendered]).toEqual(["Switched", ["nb"]]);
  });
});
