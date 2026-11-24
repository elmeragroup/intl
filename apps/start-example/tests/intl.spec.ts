import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import {
  ACCOUNT_MENU,
  afterTwoFrames,
  chooseLocale,
  collectErrors,
  COOKIE,
  deferred,
  isServerFunction,
  OTHER_APP_COOKIE,
  SIDEBAR_COOKIE,
} from "./browser-control";
import { EXPECTED, LOCALES } from "./expected-text";
import type { Locale } from "./expected-text";

// Unit under test: the example app as a visitor gets it (its server render and hydration, route loaders, client state,
// API route and server functions, inside Fuse's app shell) on the built packages. Oracle: expected-text.ts, the English
// source and the translations each locale shows, written out per case.

// The metering point the search finds: the first row of the list sorted by customer, in the seeded data.
const GSRN = "707057510035582595";

// The pages, by the label each one's sidebar link and heading carry.
const PAGES = [
  { path: "/", label: "overview" },
  { path: "/metering-points", label: "meteringPoints" },
  { path: "/invoices", label: "invoices" },
  { path: "/settings", label: "settings" },
] as const;

// What each page's own client code does once the page has hydrated, and what the page shows: every case below runs it
// after hydration and reads the browser's errors only after its update, so a mismatch React reports late, or an error
// the update itself raises, fails the case.
const EXERCISES = {
  // The overview: its loader's notice, its messages and figures in Europe/Oslo, then a chart series toggled in the browser.
  "/": async (page, locale) => {
    const expected = EXPECTED[locale];
    await expect(page.locator("#loader-notice")).toHaveText(expected.notice);
    await expect(page.locator("#welcome-invoices")).toHaveText(expected.welcome);
    await expect(page.locator("#welcome-alerts")).toHaveText(expected.alerts);
    await expect(page.locator("#welcome-link")).toHaveText(expected.review);
    await expect(page.locator("#run-sent")).toHaveText(expected.sent);
    await expect(page.locator("#run-due")).toHaveText(expected.due);
    await expect(page.locator("#run-total")).toHaveText(expected.invoiced);
    await expect(page.locator("#run-areas")).toHaveText(expected.areas);
    await expect(page.locator("#run-states [data-invoice-state=Open]")).toHaveText(expected.openState);
    await expect(page.locator("#run-open")).toHaveText(expected.openVerb);
    await expect(page.locator("#kpi-consumption-change")).toHaveText(expected.consumptionChange);
    await expect(page.locator("#kpi-solar-change")).toHaveText(expected.solarChange);
    await expect(page.locator("[data-activity=price-alert-no1] time")).toHaveText(expected.alertAge);
    await expect(
      page.locator("[data-activity=price-alert-no1] [data-slot=timeline-list-description]")
    ).toHaveText(expected.alertDetail);
    // The sidebar's overdue count, as a screen reader hears it: one plural message, the number and its noun.
    await expect(
      page.locator("[data-slot=sidebar][data-state] [data-slot=sidebar-menu-badge] .sr-only")
    ).toHaveText(expected.overdueBadge);

    // Last year's series in the daily chart's legend: pressed, it leads the chart.
    const lastYear = page.locator("[data-slot=chart-legend-toggle][data-series='1']");
    await expect(lastYear).toHaveAttribute("aria-pressed", "false");
    await lastYear.click();
    await expect(lastYear).toHaveAttribute("aria-pressed", "true");
  },
  // The metering points: the search narrows the table, its counts and its cells translate as they change.
  "/metering-points": async (page, locale) => {
    const expected = EXPECTED[locale];
    await expect(page.locator("#points-count")).toContainText(expected.pointsCount);
    const search = page.getByRole("searchbox");
    // The search takes input only once the page has hydrated: what the visitor typed before would be lost.
    await expect(search).toBeEnabled();

    await search.fill(GSRN);

    await expect(page.locator("#points-count")).toContainText(expected.oneOfPoints);
    await expect(page.locator("#points-annual")).toHaveText(expected.annual);
    await expect(page.getByRole("row").filter({ hasText: GSRN })).toContainText(expected.customerCell);
    await page.getByRole("checkbox", { name: expected.selectPoint }).check();
    await expect(page.locator("#points-selected")).toHaveText(expected.selected);
  },
  // The invoices: the server's figures and Fuse's pagination, then the status filter narrows the table to overdue ones.
  "/invoices": async (page, locale) => {
    const expected = EXPECTED[locale];
    await expect(page.locator("#invoices-period")).toHaveText(expected.period);
    await expect(page.locator("#invoices-total")).toHaveText(expected.invoicedCount);
    // Fuse's own strings come from its LocaleProvider, which the shell drives from the request's locale.
    await expect(page.getByText(expected.fusePage, { exact: true })).toBeVisible();

    // The filter's Overdue choice, found by its label (its name also holds its count): the run's six overdue invoices,
    // every one of them overdue.
    await page
      .getByRole("group", { name: expected.showInvoices })
      .getByRole("button", { name: expected.overdueState })
      .click();

    const rows = page.locator("[data-slot=data-table-body] [data-slot=data-table-row]");
    await expect(rows).toHaveCount(6);
    await expect(rows.filter({ hasNotText: expected.overdueState })).toHaveCount(0);

    // One overdue invoice's due date, in its row as the loader formatted it and in its Sheet as the browser does: both
    // in Oslo's day.
    const invoice = rows.filter({ hasText: "INV-2602-0006" });
    await expect(invoice).toContainText(expected.invoiceDue);
    await invoice.click();
    await expect(page.getByRole("dialog", { name: "INV-2602-0006" })).toContainText(expected.invoiceSheetDue);
  },
  // Settings: a field edited in the browser makes the form unsaved.
  "/settings": async (page, locale) => {
    const expected = EXPECTED[locale];
    await expect(page.locator("#settings-state")).toHaveText(expected.unchanged);

    await page.getByRole("textbox", { name: expected.fullName }).fill("Kari Nordmann");

    await expect(page.locator("#settings-state")).toHaveText(expected.unsaved);
  },
} satisfies Readonly<Record<(typeof PAGES)[number]["path"], (page: Page, locale: Locale) => Promise<void>>>;

for (const locale of LOCALES) {
  const expected = EXPECTED[locale];

  test.describe(`in ${locale}`, () => {
    test.beforeEach(async ({ context }) => {
      await chooseLocale(context, locale);
    });

    test.describe("without JavaScript", () => {
      // Only the server's HTML runs: every text below was rendered on the server, the loaders' and client state's
      // included. Visible text only, so the loader data serialized for hydration cannot satisfy it.
      test.use({ javaScriptEnabled: false });

      test("server-renders every page in the request's language", async ({ page }) => {
        await page.goto("/");

        await expect(page.locator("html")).toHaveAttribute("lang", locale);
        await expect(page.locator("h1")).toHaveText(expected.overview);
        // One title, the page's: React hoists the page header's <title> into the document's head.
        await expect(page.locator("title")).toHaveCount(1);
        await expect(page).toHaveTitle(`${expected.overview} · ${expected.backOffice}`);
        await expect(page.locator("#loader-notice")).toHaveText(expected.notice);
        await expect(page.locator("#welcome-invoices")).toHaveText(expected.welcome);
        // The tag's link leads to the page it names.
        await expect(page.locator("#welcome-link a")).toHaveText(expected.reviewLink);
        await expect(page.locator("#welcome-link a")).toHaveAttribute("href", "/invoices");
        await expect(page.locator("#run-due")).toHaveText(expected.due);
        await expect(page.locator("#run-sent")).toHaveText(expected.sent);
        // The server's HTML as it is, its no-break spaces and minus signs included; nothing rewrites it here.
        expect(await page.locator("#run-total").textContent()).toBe(expected.invoiced);
        expect(await page.locator("#kpi-consumption-change").textContent()).toBe(expected.consumptionChange);

        await page.goto("/invoices");
        await expect(page.locator("h1")).toHaveText(expected.invoices);
        await expect(page.locator("#invoices-period")).toHaveText(expected.period);

        await page.goto("/metering-points");
        await expect(page.locator("h1")).toHaveText(expected.meteringPoints);
        await expect(page.locator("#points-count")).toContainText(expected.pointsCount);
        // No script runs to take input: the search stays disabled until the page hydrates.
        await expect(page.getByRole("searchbox")).toBeDisabled();

        await page.goto("/settings");
        await expect(page.locator("h1")).toHaveText(expected.settings);
        await expect(page.locator("#settings-state")).toHaveText(expected.unchanged);
        await expect(page.getByRole("textbox", { name: expected.fullName })).toBeDisabled();
      });

      for (const { path, label } of PAGES) {
        // Overview's link is followed from Settings, every other page's from Overview.
        const from = path === "/" ? "/settings" : "/";

        test(`reaches ${path} by link on a narrow screen`, async ({ page }) => {
          // Below md the sidebar is a Sheet that only script opens: the server's page links stand in for it.
          await page.setViewportSize({ width: 390, height: 844 });
          await page.goto(from);
          const pages = page.getByRole("navigation", { name: expected.pages });

          await pages.getByRole("link", { name: expected[label], exact: true }).click();

          await expect(page).toHaveURL(path);
          await expect(page.locator("h1")).toHaveText(expected[label]);
          await expect(pages.getByRole("link", { name: expected[label], exact: true })).toHaveAttribute(
            "aria-current",
            "page"
          );
        });
      }

      // A missing path below a page's route is no page either: Invoices is not current on /invoices/missing.
      for (const path of ["/no-such-page", "/invoices/missing"]) {
        test(`names ${path}, which no page owns, and marks no page as current`, async ({ page }) => {
          const response = await page.goto(path);

          expect(response?.status()).toBe(404);
          await expect(page.locator("[data-slot=breadcrumb-page]")).toHaveText(expected.notFound);
          await expect(page.locator("[data-slot=sidebar] a[aria-current=page]")).toHaveCount(0);
          await expect(page.locator("[data-slot=sidebar] a[data-status=active]")).toHaveCount(0);
        });
      }
    });

    for (const { path, label } of PAGES) {
      test(`hydrates ${path} and updates it in the browser without an error`, async ({ page }) => {
        const errors = collectErrors(page);
        await page.goto(path);
        // Enabled only once React has hydrated the shell.
        await expect(page.getByRole("button", { name: expected.search, exact: true })).toBeEnabled();
        await expect(page.locator("h1")).toHaveText(expected[label]);

        await EXERCISES[path](page, locale);
        await afterTwoFrames(page);

        // The browser formats what the server formatted, Fuse's components read the same locale, and the page's own
        // update raises nothing: no hydration mismatch, no missing message.
        expect(errors).toEqual([]);
      });
    }

    for (const { path, label } of PAGES) {
      // Overview's link is followed from Settings, every other page's from Overview.
      const from = path === "/" ? "/settings" : "/";

      test(`reaches ${path} from the sidebar, in the current language`, async ({ page }) => {
        await page.goto(from);
        await expect(page.getByRole("button", { name: expected.search, exact: true })).toBeEnabled();

        await page
          .locator("[data-slot=sidebar][data-state]")
          .getByRole("link", { name: expected[label], exact: true })
          .click();

        await expect(page).toHaveURL(path);
        await expect(page.locator("h1")).toHaveText(expected[label]);
        await expect(page).toHaveTitle(`${expected[label]} · ${expected.backOffice}`);
        await expect(page.locator("html")).toHaveAttribute("lang", locale);
      });
    }

    test("answers in the request's language from the API route and a server function", async ({
      page,
      request,
    }) => {
      const response = await request.get("/api/greeting", { headers: { cookie: `${COOKIE}=${locale}` } });
      expect(await response.text()).toBe(expected.api);

      await page.goto("/settings");
      await page.getByRole("button", { name: expected.testAlert }).click();
      await expect(page.locator("#api-greeting")).toHaveText(expected.api);
      await page.getByRole("button", { name: expected.save }).click();
      await expect(page.locator("#settings-saved")).toHaveText(expected.saved);
    });

    test("says the server did not answer when the API fails or the server function cannot reach it", async ({
      page,
    }) => {
      await page.route("**/api/greeting", (route) =>
        route.fulfill({ status: 500, body: "Internal Server Error" })
      );
      await page.route(isServerFunction, (route) =>
        route.request().method() === "POST" ? route.abort() : route.continue()
      );
      await page.goto("/settings");

      await page.getByRole("button", { name: expected.testAlert }).click();
      await expect(page.locator("#api-greeting")).toHaveText(expected.failed);
      await page.getByRole("button", { name: expected.save }).click();
      await expect(page.locator("#settings-saved")).toHaveText(expected.failed);
    });

    test("says so in the page's language when the choice cannot be saved", async ({ page }) => {
      await page.route(isServerFunction, (route) =>
        route.request().method() === "POST" ? route.abort() : route.continue()
      );
      await page.goto("/settings");
      const other = page.getByRole("button", { name: locale === "en" ? "Norsk bokmål" : "English" });
      await expect(other).toBeEnabled();

      await other.click();

      await expect(page.locator("#locale-status")).toHaveText(expected.notSaved);
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      await expect(page.locator("h1")).toHaveText(expected.settings);
    });
  });
}

// Outside a secure context, such as the app opened by its address on the local network over plain HTTP, the browser
// has no `navigator.clipboard`: copying the link fails, and says so in the page's language.
test("says the link could not be copied where the browser has no clipboard", async ({ page, context }) => {
  await chooseLocale(context, "nb");
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "clipboard", { get: () => undefined, configurable: true });
  });
  await page.goto("/");
  await page.getByRole("button", { name: EXPECTED.nb.search, exact: true }).click();

  await page.getByRole("option", { name: "Kopier lenke til denne siden" }).click();

  await expect(page.locator("[data-slot=toast-title]")).toHaveText(EXPECTED.nb.copyFailed);
});

// The command menu's code loads on the first opening. When it cannot (here the network is gone), the page stays as it
// was and says search is unavailable, with an action that reloads the page: a browser may keep the failed module, so a
// fresh page is what fetches it again.
test("keeps the page and offers a reload when the menu's code cannot load", async ({ page, context }) => {
  await page.goto("/");
  const search = page.getByRole("button", { name: EXPECTED.en.search, exact: true });
  await expect(search).toBeEnabled();
  await context.setOffline(true);

  await search.click();

  await expect(page.locator("[data-slot=toast-title]")).toHaveText("Search is unavailable");
  // The page is still there, not the app's error.
  await expect(page.locator("h1")).toHaveText(EXPECTED.en.overview);
  await expect(page.locator("#loader-notice")).toHaveText(EXPECTED.en.notice);
  await expect(page.locator("#load-error")).toHaveCount(0);
  await expect(search).toHaveAttribute("aria-expanded", "false");

  await context.setOffline(false);
  const reloaded = page.waitForEvent("load");
  await page.locator("[data-slot=toast-action]").getByText("Reload page").click();
  await reloaded;

  await expect(search).toBeEnabled();
  await search.click();
  await expect(page.getByRole("option", { name: "Copy link to this page" })).toBeVisible();
});

// Fuse's menu link item stays open on a click unless told otherwise: left open on a phone, its backdrop would cover
// the page it led to. It closes, and the shell's focus on the new page's title stays where it is.
test("closes the account menu when it leads to Settings, and leaves focus on the page's title", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: EXPECTED.en.search, exact: true })).toBeEnabled();
  await page.getByRole("button", { name: ACCOUNT_MENU }).click();

  await page.getByRole("menuitem", { name: EXPECTED.en.settings }).click();

  await expect(page.locator("h1")).toHaveText(EXPECTED.en.settings);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.locator("[data-page-title]")).toBeFocused();
  // Nothing covers the form: a click reaches its first field.
  await page.getByRole("textbox", { name: EXPECTED.en.fullName }).click();
  await expect(page.getByRole("textbox", { name: EXPECTED.en.fullName })).toBeFocused();
});

// A toast lives in the shell and outlives a switch. It renders `<T>`, so it reads in the language the page has now.
test("shows an open notification in the language the page switches to", async ({ page }) => {
  await page.goto("/settings");
  const finnish = page.getByRole("button", { name: EXPECTED.fi.language });
  await expect(finnish).toBeEnabled();
  await page.getByRole("button", { name: ACCOUNT_MENU }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  const title = page.locator("[data-slot=toast-title]");
  await expect(title).toHaveText(EXPECTED.en.signedOut);

  // The pointer rests on the toast, which holds its timer, and the switch is clicked without moving it there.
  await title.hover();
  await finnish.dispatchEvent("click");

  await expect(page.locator("html")).toHaveAttribute("lang", "fi");
  await expect(title).toHaveText(EXPECTED.fi.signedOut);
  await expect(page.locator("[data-slot=toast-description]")).toHaveText(EXPECTED.fi.signedOutDetail);
});

test("switches the language in place, keeps the draft, clears old answers and remembers the choice", async ({
  page,
}) => {
  // The overview first, so the router holds its loader's notice in English when the switch comes.
  await page.goto("/");
  await expect(page.locator("#loader-notice")).toHaveText(EXPECTED.en.notice);
  await expect(page.getByRole("button", { name: EXPECTED.en.search, exact: true })).toBeEnabled();
  await page
    .locator("[data-slot=sidebar][data-state]")
    .getByRole("link", { name: EXPECTED.en.settings, exact: true })
    .click();
  await expect(page.locator("h1")).toHaveText(EXPECTED.en.settings);
  await page.getByRole("button", { name: EXPECTED.en.save }).click();
  await expect(page.locator("#settings-saved")).toHaveText(EXPECTED.en.saved);
  await page.getByRole("textbox", { name: EXPECTED.en.fullName }).fill("Kari Nordmann");
  // A field the save's sentence names, so the save after the switch shows the server got the edited draft.
  await page.getByRole("textbox", { name: "Alert threshold, øre/kWh" }).fill("200");
  await expect(page.locator("#settings-state")).toHaveText(EXPECTED.en.unsaved);
  await page.getByRole("button", { name: EXPECTED.en.testAlert }).click();
  await expect(page.locator("#api-greeting")).toHaveText(EXPECTED.en.api);

  // The root loader re-runs through a GET server function, whose answer is localized too. A response event fires on
  // its headers, before the page can render the body it carries.
  const loaderCacheControls: Array<string | undefined> = [];
  page.on("response", (response) => {
    if (isServerFunction(new URL(response.url())) && response.request().method() === "GET") {
      loaderCacheControls.push(response.headers()["cache-control"]);
    }
  });
  await page.getByRole("button", { name: EXPECTED.fi.language }).click();

  await expect(page.locator("html")).toHaveAttribute("lang", "fi");
  await expect(page.locator("h1")).toHaveText(EXPECTED.fi.settings);
  await expect(page).toHaveTitle(`${EXPECTED.fi.settings} · ${EXPECTED.fi.backOffice}`);
  // However many GET server functions the router re-ran, each answer is kept out of shared caches.
  expect(loaderCacheControls.length).toBeGreaterThan(0);
  expect(loaderCacheControls.filter((cacheControl) => cacheControl !== "private, no-store")).toEqual([]);
  // The shell re-rendered with the new catalog too: the sidebar names the pages in Finnish.
  await expect(
    page.locator("[data-slot=sidebar][data-state]").getByRole("link", { name: EXPECTED.fi.invoices })
  ).toBeVisible();
  // The draft is client state: what the visitor typed survives the switch, under a Finnish label.
  await expect(page.getByRole("textbox", { name: EXPECTED.fi.fullName })).toHaveValue("Kari Nordmann");
  await expect(page.locator("#settings-state")).toHaveText(EXPECTED.fi.unsaved);
  await expect(page.getByRole("button", { name: EXPECTED.fi.language })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  // The English answers are gone, the API route's and the server function's; asked again, the server answers in
  // Finnish.
  await expect(page.locator("#api-greeting")).toHaveText("");
  await expect(page.locator("#settings-saved")).toHaveText("");
  await page.getByRole("button", { name: EXPECTED.fi.testAlert }).click();
  await expect(page.locator("#api-greeting")).toHaveText(EXPECTED.fi.api);
  // Saved after the switch, the draft typed before it: the server answers in Finnish with the edited threshold.
  await page.getByRole("button", { name: EXPECTED.fi.save }).click();
  await expect(page.locator("#settings-saved")).toHaveText(
    "Tallennettu: oletuksena Pörssisähkö, maksuaika 14 päivää, hintahälytykset yli 200 äyri/kWh eikä viikkoraporttia."
  );
  await expect(page.locator("#settings-state")).toHaveText(EXPECTED.fi.unchanged);
  // The overview's loader ran in English before the switch; back on the overview, its notice, translated on the server,
  // is Finnish.
  await page
    .locator("[data-slot=sidebar][data-state]")
    .getByRole("link", { name: EXPECTED.fi.overview, exact: true })
    .click();
  await expect(page.locator("#loader-notice")).toHaveText(EXPECTED.fi.notice);

  await page.goto("/settings");
  await expect(page.locator("h1")).toHaveText(EXPECTED.fi.settings);
  await expect(page.locator("#settings-state")).toHaveText(EXPECTED.fi.unchanged);

  await page.getByRole("button", { name: EXPECTED.sv.language }).click();
  await expect(page.locator("h1")).toHaveText(EXPECTED.sv.settings);
  await page.getByRole("button", { name: EXPECTED.en.language }).click();
  await expect(page.locator("h1")).toHaveText(EXPECTED.en.settings);
});

test("shows how the latest switch ended, not an older one that failed after it started", async ({ page }) => {
  // The first save waits, then fails; the second waits until the test lets it through. Switches run one at a time, so
  // the second save is sent only once the first has failed and its outcome has reached the page.
  const failFirst = deferred();
  const releaseLatest = deferred();
  const latestSent = deferred();
  let saves = 0;
  await page.route(isServerFunction, async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    saves += 1;
    if (saves === 1) {
      await failFirst.promise;
      await route.abort();
    } else {
      latestSent.settle();
      await releaseLatest.promise;
      await route.continue();
    }
  });
  await page.goto("/settings");
  const swedish = page.getByRole("button", { name: EXPECTED.sv.language });
  await expect(swedish).toBeEnabled();

  await swedish.click();
  await page.getByRole("button", { name: EXPECTED.nb.language }).click();
  failFirst.settle();
  await latestSent.promise;
  // Let React commit what the first switch's failure set, if anything, before asserting there is nothing to see.
  await afterTwoFrames(page);
  await expect(page.locator("nav[aria-busy=true] #locale-status")).toHaveText("");
  releaseLatest.settle();

  await expect(page.locator("html")).toHaveAttribute("lang", "nb");
  await expect(page.locator("h1")).toHaveText(EXPECTED.nb.settings);
  await expect(page.locator("nav[aria-busy=false] #locale-status")).toHaveText("");
  expect(saves).toBe(2);
});

// Every switcher under the router shares one queue, wherever the visitor has been meanwhile. A Swedish switch is held
// at the server; the visitor leaves Settings, comes back and picks Finnish. The remounted switcher shows the held switch
// as busy before the click, and the browser sends the Finnish save only after the Swedish answer reached it, so the
// Finnish one cannot finish first and let the Swedish answer take the page and the cookie back to Swedish.
test("waits for the held save before sending the remounted switcher's choice", async ({ page, context }) => {
  const releaseSwedish = deferred();
  const swedishSent = deferred();
  // The browser's own request and response events, in the order the page saw them.
  const saves: Array<string> = [];
  const localeOf = (body: string): string | undefined =>
    ["sv", "fi"].find((locale) => body.includes(`"${locale}"`));
  page.on("request", (request) => {
    const locale = request.method() === "POST" ? localeOf(request.postData() ?? "") : undefined;
    if (locale !== undefined) {
      saves.push(`${locale} sent`);
    }
  });
  page.on("response", (response) => {
    const request = response.request();
    const locale = request.method() === "POST" ? localeOf(request.postData() ?? "") : undefined;
    if (locale !== undefined) {
      saves.push(`${locale} answered`);
    }
  });
  await page.route(isServerFunction, async (route) => {
    const request = route.request();
    if (request.method() === "POST" && localeOf(request.postData() ?? "") === "sv") {
      swedishSent.settle();
      await releaseSwedish.promise;
    }
    await route.continue();
  });
  await page.goto("/settings");
  const sidebar = page.locator("[data-slot=sidebar][data-state]");
  const swedish = page.getByRole("button", { name: EXPECTED.sv.language });
  await expect(swedish).toBeEnabled();
  await swedish.click();
  await swedishSent.promise;

  await sidebar.getByRole("link", { name: EXPECTED.en.overview, exact: true }).click();
  await expect(page.locator("h1")).toHaveText(EXPECTED.en.overview);
  await sidebar.getByRole("link", { name: EXPECTED.en.settings, exact: true }).click();
  await expect(page.locator("h1")).toHaveText(EXPECTED.en.settings);
  await expect(page.locator("nav[aria-busy=true] #locale-status")).toBeAttached();
  await page.getByRole("button", { name: EXPECTED.fi.language }).click();
  releaseSwedish.settle();

  await expect.poll(() => saves).toEqual(["sv sent", "sv answered", "fi sent", "fi answered"]);
  await expect
    .poll(async () => (await context.cookies()).find(({ name }) => name === COOKIE)?.value)
    .toBe("fi");
  await expect(page.locator("html")).toHaveAttribute("lang", "fi");
  await expect(page.locator("nav[aria-busy=false] #locale-status")).toHaveText("");
  await page.reload();
  await expect(page.locator("h1")).toHaveText(EXPECTED.fi.settings);
});

// A page's loader data is text in the language it loaded in. Back on Invoices after a switch, the page waits for its
// loader to answer in Finnish rather than paint the English it holds from the first visit: a recorder in the page notes
// any moment the English billing period shows, while the loader's answer is held.
test("shows a page visited before a switch only in the new language", async ({ page }) => {
  await page.goto("/invoices");
  await expect(page.locator("#invoices-period")).toHaveText(EXPECTED.en.period);
  await expect(page.getByRole("button", { name: EXPECTED.en.search, exact: true })).toBeEnabled();
  const sidebar = page.locator("[data-slot=sidebar][data-state]");
  await sidebar.getByRole("link", { name: EXPECTED.en.settings, exact: true }).click();
  await page.getByRole("button", { name: EXPECTED.fi.language }).click();
  await expect(page.locator("h1")).toHaveText(EXPECTED.fi.settings);
  await page.evaluate((english) => {
    const record = (): void => {
      const period = document.querySelector("#invoices-period")?.textContent ?? "";
      if (period.replaceAll(/\s+/gu, " ").trim() === english) {
        document.documentElement.dataset.sawEnglishPeriod = "yes";
      }
    };
    new MutationObserver(record).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }, EXPECTED.en.period);
  const release = deferred();
  const held = deferred();
  await page.route(isServerFunction, async (route) => {
    if (route.request().method() === "GET") {
      held.settle();
      await release.promise;
    }
    await route.continue();
  });

  await sidebar.getByRole("link", { name: EXPECTED.fi.invoices, exact: true }).click();
  await held.promise;
  // Frames enough for a page that does not wait for its loader to paint what it holds.
  await afterTwoFrames(page);
  release.settle();

  await expect(page.locator("h1")).toHaveText(EXPECTED.fi.invoices);
  await expect(page.locator("#invoices-period")).toHaveText(EXPECTED.fi.period);
  expect(await page.evaluate(() => document.documentElement.dataset.sawEnglishPeriod)).toBeUndefined();
});

// The adapter hands the request's Accept-Language to chooseLocale: one browser that asks for Bokmål proves the wiring.
// How the header is weighed, row by row and across all four languages, is test/locale.test.ts.
test.describe("without a stored choice", () => {
  test.use({ locale: "nb-NO" });

  test("follows the browser's Accept-Language", async ({ page }) => {
    await page.goto("/");

    await expect(page.locator("html")).toHaveAttribute("lang", "nb");
    await expect(page.locator("h1")).toHaveText(EXPECTED.nb.overview);
  });
});

test("ignores the Next example's choice and a plain `locale` cookie on the same host", async ({
  request,
}) => {
  const response = await request.get("/api/greeting", {
    headers: { cookie: `${OTHER_APP_COOKIE}=nb; locale=nb`, "accept-language": "en" },
  });

  expect(await response.text()).toBe(EXPECTED.en.api);
});

// The root loader reads the app's own sidebar cookie for the first paint, never Fuse's `sidebar:state`, which every app
// on the host shares.
test("opens the sidebar as the visitor left it, from the app's own cookie", async ({ page, context }) => {
  await context.addCookies([{ name: "sidebar:state", value: "false", domain: "localhost", path: "/" }]);
  await page.goto("/");
  const sidebar = page.locator("[data-slot=sidebar][data-state]");
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  await expect(page.getByRole("button", { name: EXPECTED.en.search, exact: true })).toBeEnabled();

  await page.locator("[data-slot=sidebar-trigger]").click();
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  await expect
    .poll(async () => (await context.cookies()).find(({ name }) => name === SIDEBAR_COOKIE)?.value)
    .toBe("false");

  await page.reload();
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
});

// Each response's text depends on the visitor's cookie and Accept-Language: no shared cache may store one, page or API.
for (const { path } of PAGES) {
  test(`keeps ${path} out of shared caches`, async ({ request }) => {
    const response = await request.get(path);

    // The root route and the loaders that run while the document renders set exactly the app's policy, on every page.
    expect(response.headers()["cache-control"]).toBe("private, no-store");
  });
}

// A client navigation fetches the incoming page's loader data with a GET of its own, which a shared cache could store
// as readily as a document. Each page's loader answer is told apart from the root's by visible text only it supplies:
// the overview's notice, and the invoices' billing period, read from the page once it shows (a date range's spaces
// differ between ICU releases, so the expected string is the one the server wrote).
for (const { path, label, holds } of [
  { path: "/", label: "overview", holds: "#loader-notice" },
  { path: "/invoices", label: "invoices", holds: "#invoices-period" },
] as const) {
  test(`keeps ${path}'s loader answer out of shared caches on a client navigation`, async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByRole("button", { name: EXPECTED.en.search, exact: true })).toBeEnabled();
    const answers: Array<Promise<{ readonly body: string; readonly cacheControl: string | undefined }>> = [];
    page.on("response", (response) => {
      if (isServerFunction(new URL(response.url())) && response.request().method() === "GET") {
        answers.push(
          response.text().then((body) => ({ body, cacheControl: response.headers()["cache-control"] }))
        );
      }
    });

    await page
      .locator("[data-slot=sidebar][data-state]")
      .getByRole("link", { name: EXPECTED.en[label], exact: true })
      .click();
    await expect(page.locator("h1")).toHaveText(EXPECTED.en[label]);
    const shown = (await page.locator(holds).textContent()) ?? "";
    expect(shown).not.toBe("");

    const loaderAnswers = (await Promise.all(answers)).filter(({ body }) => body.includes(shown));
    expect(loaderAnswers.length).toBeGreaterThan(0);
    expect(loaderAnswers.map(({ cacheControl }) => cacheControl)).toEqual(
      loaderAnswers.map(() => "private, no-store")
    );
  });
}

// TanStack Router moves no focus on a navigation: the shell moves it to the incoming page's title, once that page has
// rendered, so the next Tab starts in the page. On a phone the sidebar is a Sheet, which closes as its link is followed.
for (const { screen, viewport } of [
  { screen: "a desktop", viewport: { width: 1280, height: 800 } },
  { screen: "a phone", viewport: { width: 390, height: 844 } },
] as const) {
  test(`moves focus to the new page's title after a sidebar navigation on ${screen}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expect(page.getByRole("button", { name: EXPECTED.en.search, exact: true })).toBeEnabled();
    if (viewport.width < 768) {
      await page.locator("[data-slot=sidebar-trigger]").click();
    }

    await page
      .locator("[data-slot=sidebar][data-state], [data-slot=sidebar][data-mobile]")
      .getByRole("link", { name: EXPECTED.en.invoices, exact: true })
      .click();

    await expect(page.locator("h1")).toHaveText(EXPECTED.en.invoices);
    const title = page.locator("[data-page-title]");
    await expect(title).toContainText(EXPECTED.en.invoices);
    await expect(title).toBeFocused();
    // Still there once the Sheet, if any, has finished closing.
    await expect(page.locator("[data-slot=sidebar][data-mobile]")).toHaveCount(0);
    await expect(title).toBeFocused();
  });
}

// The browser's Back is a navigation too: on a phone, the sidebar's Sheet closes on it, as on a link, and the page it
// returns to takes focus and clicks.
test("closes the phone's sidebar on the browser's Back, and leaves the page it returns to usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: EXPECTED.en.search, exact: true })).toBeEnabled();
  const sheet = page.locator("[data-slot=sidebar][data-mobile]");
  await page.locator("[data-slot=sidebar-trigger]").click();
  await sheet.getByRole("link", { name: EXPECTED.en.invoices, exact: true }).click();
  await expect(page.locator("h1")).toHaveText(EXPECTED.en.invoices);
  await expect(sheet).toHaveCount(0);
  await page.locator("[data-slot=sidebar-trigger]").click();
  await expect(sheet).toBeVisible();

  await page.goBack();

  await expect(page.locator("h1")).toHaveText(EXPECTED.en.overview);
  await expect(sheet).toHaveCount(0);
  await expect(page.locator("[data-page-title]")).toBeFocused();
  // Nothing covers the page: a click reaches its chart's legend.
  const lastYear = page.locator("[data-slot=chart-legend-toggle][data-series='1']");
  await lastYear.click();
  await expect(lastYear).toHaveAttribute("aria-pressed", "true");
});

// The router matches a path in any case: `/SETTINGS` is Settings, so the shell names it so, marks its link, and keeps
// its draft when the visitor follows that link to `/settings`.
test("names and keeps a page whose path is typed in another case", async ({ page }) => {
  await page.goto("/SETTINGS");
  await expect(page.locator("h1")).toHaveText(EXPECTED.en.settings);
  await expect(page.locator("[data-slot=breadcrumb-page]")).toHaveText(EXPECTED.en.settings);
  const link = page
    .locator("[data-slot=sidebar][data-state]")
    .getByRole("link", { name: EXPECTED.en.settings, exact: true });
  await expect(link).toHaveAttribute("aria-current", "page");
  const name = page.getByRole("textbox", { name: EXPECTED.en.fullName });
  await expect(name).toBeEnabled();
  await name.fill("Kari Nordmann");

  await link.click();

  await expect(page).toHaveURL("/settings");
  await expect(name).toHaveValue("Kari Nordmann");
  await expect(page.locator("#settings-state")).toHaveText(EXPECTED.en.unsaved);
});

test("keeps the API route's answer out of shared caches", async ({ request }) => {
  const response = await request.get("/api/greeting");

  // The route sets exactly the app's policy.
  expect(response.headers()["cache-control"]).toBe("private, no-store");
});

test("reads its cookie's whole value, so a value with an extra `=` is no locale", async ({ request }) => {
  const response = await request.get("/api/greeting", {
    headers: { cookie: `${COOKIE}=nb=other`, "accept-language": "en" },
  });

  expect(await response.text()).toBe(EXPECTED.en.api);
});
