import { act } from "react";

// @vitest-environment jsdom
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";

import type { IntlInstance } from "@elmeragroup/intl/core";
import { IntlProvider, T, Val, useIntl } from "@elmeragroup/intl/react";

import { english } from "./catalogs";

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
});
