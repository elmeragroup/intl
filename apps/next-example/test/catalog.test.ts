import { describe, expect, it } from "vitest";

import { createIntl } from "@elmeragroup/intl/core";

import { formats } from "../intl/formats";
import catalog from "../intl/nb.po";

// Unit under test: the Bokmål catalog as the app's tests import it, compiled by intlCatalogs() (vitest.config.ts), read
// through createIntl. Oracle: the msgstr the message has in ../intl/nb.po. A message missing from the catalog would
// render its English source, so the expectation differs from its source. The page's messages, the two contexts of
// "Open" among them, are the Playwright specs'.
describe("the compiled Bokmål catalog", () => {
  const errors: Array<string> = [];
  const intl = createIntl({
    locale: "nb",
    catalog,
    timeZone: "Europe/Oslo",
    formats,
    onError: (_error, key) => {
      errors.push(key);
    },
  });

  it("translates a message", () => {
    expect(intl.t("Welcome to the example shop")).toBe("Velkommen til eksempelbutikken");
    expect(errors).toEqual([]);
  });
});
