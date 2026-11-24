import { describe, expect, it } from "vitest";

import { createIntl } from "@elmeragroup/intl/core";

import fi from "../src/intl/fi.po";
import { formats } from "../src/intl/formats";
import nb from "../src/intl/nb.po";
import sv from "../src/intl/sv.po";

// Unit under test: each locale's catalog as the app's tests import it, compiled by intlCatalogs() (vitest.config.ts),
// read through createIntl. Oracle: the msgstr the message has in that locale's PO. A message missing from a catalog
// would render its English source, so each expectation differs from its source. The pages' messages, in all four
// languages, the two contexts of "Open" among them, are the Playwright specs'.
describe.each([
  { locale: "nb", catalog: nb, welcome: "Velkommen tilbake" },
  { locale: "sv", catalog: sv, welcome: "Välkommen tillbaka" },
  { locale: "fi", catalog: fi, welcome: "Tervetuloa takaisin" },
])("the compiled $locale catalog", ({ locale, catalog, welcome }) => {
  const errors: Array<string> = [];
  const intl = createIntl({
    locale,
    catalog,
    timeZone: "Europe/Oslo",
    formats,
    onError: (_error, key) => {
      errors.push(key);
    },
  });

  it("translates a message", () => {
    expect(intl.t("Welcome back")).toBe(welcome);
    expect(errors).toEqual([]);
  });
});

// Unit under test: the Finnish welcome, the overview's plural, compiled from fi.po. Oracle: Finnish grammar, which
// negates the verb itself ("sinulla ei ole", you do not have) where English negates the noun ("no overdue invoices"),
// so each arm carries its own verb; the count and the partitive after a number above one follow CLDR's Finnish plural
// rules. The page shows only the run's count, six, so the zero and one arms are proven here.
describe("the compiled Finnish welcome", () => {
  const intl = createIntl({ locale: "fi", catalog: fi, timeZone: "Europe/Oslo", formats });

  it.each([
    { count: 0, welcome: "Hei Ingrid, sinulla ei ole erääntyneitä laskuja." },
    { count: 1, welcome: "Hei Ingrid, sinulla on 1 erääntynyt lasku." },
    { count: 6, welcome: "Hei Ingrid, sinulla on 6 erääntynyttä laskua." },
  ])("says $count overdue invoices with the verb in its arm", ({ count, welcome }) => {
    expect(
      intl.t(
        "Hello {name}, you have {count, plural, =0 {no overdue invoices} one {# overdue invoice} other {# overdue invoices}}.",
        { name: "Ingrid", count }
      )
    ).toBe(welcome);
  });
});
