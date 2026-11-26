import type { ComponentProps, ReactNode } from "react";
import { act } from "react";

// @vitest-environment jsdom
import { createRoot } from "react-dom/client";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import type { IntlInstance } from "@elmeragroup/intl/core";
import { IntlProvider, T, Val, useIntl } from "@elmeragroup/intl/react";

import { english } from "./catalogs";

// Renders go through act(), so React writes no act-environment warning to the console a test below observes.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// A catalog without the probe's structured message, so every render reports it as not extracted.
const CATALOG = english();

// Unit under test: <IntlProvider> given a new onError each render (an inline arrow). Oracle: the translator a child
// reads keeps its identity, and the handler of the latest committed render is the one called.
describe("IntlProvider", () => {
  it("keeps the translator across a new onError and reports to the latest one", () => {
    const seen: Array<IntlInstance> = [];
    const reports: Array<string> = [];
    function Probe() {
      seen.push(useIntl());

      return (
        <T>
          Hi <Val name="Ada" />
        </T>
      );
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    const renderWith = (handler: string) => {
      act(() => {
        root.render(
          <IntlProvider
            locale="nb"
            catalog={CATALOG}
            timeZone="UTC"
            onError={(_error, key) => reports.push(`${handler} ${key}`)}>
            <Probe />
          </IntlProvider>
        );
      });
    };
    renderWith("first");
    renderWith("second");
    renderWith("second");
    act(() => {
      root.unmount();
    });
    expect(new Set(seen).size).toBe(1);
    // A changed handler takes effect from the next commit.
    expect(reports).toEqual(["first Hi {name}", "first Hi {name}", "second Hi {name}"]);
  });

  // Unit under test: the provider's choice, per report, between the app's handler and the runtime's default. Oracle:
  // the default's stated form and its once-per-problem rule, and each report's key, which is its message's source;
  // a handler takes effect from the commit after the render that changed it, so each change commits with a child
  // that reports nothing before the next problem renders.
  it("logs with no onError, reports only to an added one, and logs again once it is removed", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onTestFinished(() => {
      consoleError.mockRestore();
    });
    const reports: Array<string> = [];
    const handler = (_error: Error, key: string) => {
      reports.push(key);
    };
    const container = document.createElement("div");
    const root = createRoot(container);
    const renderWith = (onError: typeof handler | undefined, child: ReactNode) => {
      act(() => {
        root.render(
          <IntlProvider locale="nb" catalog={CATALOG} timeZone="UTC" onError={onError}>
            {child}
          </IntlProvider>
        );
      });
    };
    const quiet = <p>quiet</p>;
    // A new element each render, so React renders the <T> again (it would bail out of the same element) and the
    // second render reports the problem a second time, which the default does not log.
    const logged = () => (
      <T>
        Logged <Val first="A" /> before a handler
      </T>
    );
    renderWith(undefined, logged());
    renderWith(undefined, logged());
    renderWith(handler, quiet);
    renderWith(
      handler,
      <T>
        Handled <Val second="B" /> by the added handler
      </T>
    );
    renderWith(undefined, quiet);
    renderWith(
      undefined,
      <T>
        Logged <Val third="C" /> once the handler is gone
      </T>
    );
    act(() => {
      root.unmount();
    });
    expect(consoleError.mock.calls.map((call: ReadonlyArray<unknown>) => call.slice(0, 2))).toEqual([
      ["@elmeragroup/intl:", '"Logged {first} before a handler"'],
      ["@elmeragroup/intl:", '"Logged {third} once the handler is gone"'],
    ]);
    expect(reports).toEqual(["Handled {second} by the added handler"]);
  });

  // Unit under test: the provider given `onError={null}`, which a JavaScript app passes (`enabled ? report : null`)
  // and the types do not allow. Oracle: origin/main, where a null handler was skipped and the fallback rendered, and
  // the default's stated form and once-per-problem rule, which a null handler gets as an absent one does.
  it("renders the fallback and logs through the default when onError is null", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onTestFinished(() => {
      consoleError.mockRestore();
    });
    const container = document.createElement("div");
    const root = createRoot(container);
    const rendered: Array<string | null> = [];
    // A new element each round, so the second round reports the problem again.
    for (const round of ["1", "2"]) {
      const props: ComponentProps<typeof IntlProvider> = {
        locale: "nb",
        catalog: CATALOG,
        timeZone: "UTC",
        children: (
          <T>
            Null <Val handler="onError" /> in round <Val round={round} />
          </T>
        ),
      };
      // A JavaScript caller's null, set past the prop's type, which rules it out.
      Reflect.set(props, "onError", null);
      act(() => {
        root.render(<IntlProvider {...props} />);
      });
      rendered.push(container.textContent);
    }
    act(() => {
      root.unmount();
    });
    expect(rendered).toEqual(["Null onError in round 1", "Null onError in round 2"]);
    expect(consoleError.mock.calls.map((call: ReadonlyArray<unknown>) => call.slice(0, 2))).toEqual([
      ["@elmeragroup/intl:", '"Null {handler} in round {round}"'],
    ]);
  });
});
