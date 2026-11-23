import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

// Unit under test: the example app as a visitor gets it (its server render and hydration, route loader, client
// components, API route and server function) on the built packages. Oracle: the English source the app's code writes
// and the Bokmål translations in src/intl/nb.po, with the formatted values CLDR gives for each locale (stated per case). Playwright's text matching
// collapses whitespace, so the no-break spaces in "1 234,50 kr" match a plain space.
const EXPECTED = {
  en: {
    heading: "Welcome to the example shop",
    notice: "This notice was translated in a route loader.",
    messages: "Hello Kari, you have 3 new messages.",
    delivery: "Delivered to your office.",
    terms: "Read our terms of sale before you order.",
    link: "terms of sale",
    termsHeading: "Terms of sale",
    termsText: "Orders ship within two working days, and you can return an item within 30 days.",
    status: "Shipped",
    shop: "Open",
    // The verb, translated apart from the shop's state by its context.
    openTerms: "Open",
    // 2026-03-04T23:30Z is 5 March in Oslo; the server and browser run in New York, where it is still 4 March.
    placed: "Placed on March 5, 2026",
    total: "NOK 1,234.50",
    shipped: "2 hours ago",
    // CLDR's en interval format for month, day and time on one day: the date once, the times joined by an en dash. The
    // window is 08:00 to 16:00 in Oslo; in New York, where the server and browser run, it would be 3:00 to 11:00 AM.
    deliveryWindow: "March 9, 8:00 AM – 4:00 PM",
    pickup: "Oslo, Bergen, and Trondheim",
    emptyCart: "Your cart is empty",
    twoItems: "2 items in your cart",
    twoItemsTotal: "Total: NOK 498.00",
    cartOrder: "Order A-1001: Shipped, March 5, 2026",
    addItem: "Add an item",
    callApi: "Call the API",
    confirm: "Confirm the order",
    api: "This text was translated by an API route.",
    action: "Thank you! Order A-1001 is confirmed.",
    failed: "The server did not answer. Try again.",
    notSaved: "Your language choice was not saved. Try again.",
    loadError: "This page could not be loaded.",
    tryAgain: "Try again",
  },
  nb: {
    heading: "Velkommen til eksempelbutikken",
    notice: "Denne meldingen ble oversatt i en rutelaster.",
    messages: "Hei Kari, du har 3 nye meldinger.",
    delivery: "Leveres til kontoret ditt.",
    terms: "Les salgsvilkårene våre før du bestiller.",
    link: "salgsvilkårene",
    termsHeading: "Salgsvilkår",
    termsText: "Bestillinger sendes innen to virkedager, og du kan returnere en vare innen 30 dager.",
    status: "Sendt",
    shop: "Åpen",
    openTerms: "Åpne",
    placed: "Bestilt 5. mars 2026",
    total: "1 234,50 kr",
    shipped: "for 2 timer siden",
    // CLDR's nb interval format: 24-hour times joined by an unspaced en dash.
    deliveryWindow: "9. mars, 08:00–16:00",
    pickup: "Oslo, Bergen og Trondheim",
    emptyCart: "Handlekurven er tom",
    twoItems: "2 varer i handlekurven",
    twoItemsTotal: "Totalt: 498,00 kr",
    cartOrder: "Bestilling A-1001: Sendt, 5. mars 2026",
    addItem: "Legg til en vare",
    callApi: "Kall API-et",
    confirm: "Bekreft bestillingen",
    api: "Denne teksten ble oversatt av en API-rute.",
    action: "Takk! Bestilling A-1001 er bekreftet.",
    failed: "Serveren svarte ikke. Prøv igjen.",
    notSaved: "Språkvalget ditt ble ikke lagret. Prøv igjen.",
    loadError: "Siden kunne ikke lastes inn.",
    tryAgain: "Prøv igjen",
  },
} as const;

const LOCALES = ["en", "nb"] as const;

// The app's own cookie, and the other example's: both apps run on localhost, where cookies are shared across ports.
const COOKIE = "start-example-locale";
const OTHER_APP_COOKIE = "next-example-locale";

async function chooseLocale(context: BrowserContext, locale: (typeof LOCALES)[number]): Promise<void> {
  await context.addCookies([{ name: COOKIE, value: locale, domain: "localhost", path: "/" }]);
}

// Everything the browser reports as broken: console errors (a hydration mismatch, a missing message) and uncaught
// exceptions. Listening starts before the page loads.
function collectErrors(page: Page): ReadonlyArray<string> {
  const errors: Array<string> = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });

  return errors;
}

// Server functions post to, and loaders fetch from, this prefix.
const SERVER_FN = "/_serverFn/";

// A promise the test settles when it chooses.
type Deferred = { readonly promise: Promise<void>; readonly settle: () => void };

function deferred(): Deferred {
  let settle = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });

  return { promise, settle };
}

for (const locale of LOCALES) {
  const expected = EXPECTED[locale];

  test.describe(`in ${locale}`, () => {
    test.beforeEach(async ({ context }) => {
      await chooseLocale(context, locale);
    });

    test.describe("without JavaScript", () => {
      // Only the server's HTML runs: every text below was rendered on the server, the loader's and client components'
      // included. Visible text only, so the loader data serialized for hydration cannot satisfy it.
      test.use({ javaScriptEnabled: false });

      test("server-renders the page in the request's language", async ({ page }) => {
        await page.goto("/");

        await expect(page.locator("html")).toHaveAttribute("lang", locale);
        await expect(page.locator("#server-heading")).toHaveText(expected.heading);
        await expect(page.locator("#loader-notice")).toHaveText(expected.notice);
        await expect(page.locator("#server-messages")).toHaveText(expected.messages);
        await expect(page.locator("#server-terms a")).toHaveText(expected.link);
        // The link leads somewhere on the page: the terms it names.
        await expect(page.locator("#server-terms a")).toHaveAttribute("href", "#terms");
        await expect(page.locator("#terms h2")).toHaveText(expected.termsHeading);
        await expect(page.locator("#terms-text")).toHaveText(expected.termsText);
        // Formatted on the server, in New York: the configured zone puts the order on 5 March.
        await expect(page.locator("#order-placed")).toHaveText(expected.placed);
        await expect(page.locator("#order-shipped")).toHaveText(expected.shipped);
        await expect(page.locator("#order-delivery")).toHaveText(expected.deliveryWindow);
        await expect(page.locator("#cart-count")).toHaveText(expected.emptyCart);
        await expect(page.locator("#cart-order")).toHaveText(expected.cartOrder);
      });
    });

    test("renders the route's messages, loader text and formats after hydration without an error", async ({
      page,
    }) => {
      const errors = collectErrors(page);
      await page.goto("/");
      // Enabled only once React has hydrated the page, so every error hydration reports is in by now.
      await expect(page.getByRole("button", { name: expected.addItem })).toBeEnabled();

      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      await expect(page.locator("#server-heading")).toHaveText(expected.heading);
      await expect(page.locator("#loader-notice")).toHaveText(expected.notice);
      await expect(page.locator("#server-messages")).toHaveText(expected.messages);
      await expect(page.locator("#server-delivery")).toHaveText(expected.delivery);
      await expect(page.locator("#server-terms")).toHaveText(expected.terms);
      await expect(page.locator("#server-terms a")).toHaveText(expected.link);
      await expect(page.locator("#order-status")).toHaveText(expected.status);
      await expect(page.locator("#shop-state")).toHaveText(expected.shop);
      await expect(page.locator("#order-placed")).toHaveText(expected.placed);
      await expect(page.locator("#order-total")).toHaveText(expected.total);
      await expect(page.locator("#order-shipped")).toHaveText(expected.shipped);
      await expect(page.locator("#order-delivery")).toHaveText(expected.deliveryWindow);
      await expect(page.locator("#order-pickup")).toHaveText(expected.pickup);
      await expect(page.locator("#terms-open")).toHaveText(expected.openTerms);
      // The browser formats what the server formatted: no hydration mismatch, no missing message.
      expect(errors).toEqual([]);
    });

    test("translates and formats in client components as their state changes", async ({ page }) => {
      await page.goto("/");

      await expect(page.locator("#cart-count")).toHaveText(expected.emptyCart);
      await expect(page.locator("#cart-order")).toHaveText(expected.cartOrder);
      const add = page.getByRole("button", { name: expected.addItem });
      await add.click();
      await add.click();
      await expect(page.locator("#cart-count")).toHaveText(expected.twoItems);
      await expect(page.locator("#cart-total")).toHaveText(expected.twoItemsTotal);
    });

    test("answers in the request's language from the API route and a server function", async ({
      page,
      request,
    }) => {
      const response = await request.get("/api/greeting", { headers: { cookie: `${COOKIE}=${locale}` } });
      expect(await response.text()).toBe(expected.api);

      await page.goto("/");
      await page.getByRole("button", { name: expected.callApi }).click();
      await expect(page.locator("#api-greeting")).toHaveText(expected.api);
      await page.getByRole("button", { name: expected.confirm }).click();
      await expect(page.locator("#action-confirmation")).toHaveText(expected.action);
    });

    test("says the server did not answer when the API fails or the server function cannot reach it", async ({
      page,
    }) => {
      await page.route("**/api/greeting", (route) =>
        route.fulfill({ status: 500, body: "Internal Server Error" })
      );
      await page.route(
        (url) => url.pathname.startsWith(SERVER_FN),
        (route) => (route.request().method() === "POST" ? route.abort() : route.continue())
      );
      await page.goto("/");

      await page.getByRole("button", { name: expected.callApi }).click();
      await expect(page.locator("#api-greeting")).toHaveText(expected.failed);
      await page.getByRole("button", { name: expected.confirm }).click();
      await expect(page.locator("#action-confirmation")).toHaveText(expected.failed);
    });

    test("says so in the page's language when the choice cannot be saved", async ({ page }) => {
      await page.route(
        (url) => url.pathname.startsWith(SERVER_FN),
        (route) => (route.request().method() === "POST" ? route.abort() : route.continue())
      );
      await page.goto("/");
      const other = page.getByRole("button", { name: locale === "en" ? "Norsk bokmål" : "English" });
      await expect(other).toBeEnabled();

      await other.click();

      await expect(page.locator("#locale-status")).toHaveText(expected.notSaved);
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      await expect(page.locator("#server-heading")).toHaveText(expected.heading);
    });

    test("keeps a request's button disabled until its answer arrives, and only that request's", async ({
      page,
    }) => {
      // The first request waits until the test lets it through: while it is in flight, no second one can start, so a
      // slow, older answer cannot replace a newer one. The other request is independent: it answers meanwhile.
      const greeting = deferred();
      let requests = 0;
      await page.route("**/api/greeting", async (route) => {
        requests += 1;
        await greeting.promise;
        await route.continue();
      });
      await page.goto("/");
      const call = page.getByRole("button", { name: expected.callApi });
      await expect(call).toBeEnabled();

      await call.click();
      await expect(call).toBeDisabled();
      const confirm = page.getByRole("button", { name: expected.confirm });
      await confirm.click();
      await expect(page.locator("#action-confirmation")).toHaveText(expected.action);
      await expect(confirm).toBeEnabled();
      await expect(call).toBeDisabled();
      await expect(page.locator("#api-greeting")).toHaveText("");
      greeting.settle();

      await expect(call).toBeEnabled();
      await expect(page.locator("#api-greeting")).toHaveText(expected.api);
      expect(requests).toBe(1);
    });
  });
}

test("switches the language in place, keeps client state, clears old answers and remembers the choice", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#server-heading")).toHaveText(EXPECTED.en.heading);
  await page.getByRole("button", { name: EXPECTED.en.addItem }).click();
  await page.getByRole("button", { name: EXPECTED.en.addItem }).click();
  await page.getByRole("button", { name: EXPECTED.en.callApi }).click();
  await expect(page.locator("#api-greeting")).toHaveText(EXPECTED.en.api);
  await page.getByRole("button", { name: EXPECTED.en.confirm }).click();
  await expect(page.locator("#action-confirmation")).toHaveText(EXPECTED.en.action);

  // The loaders re-run through GET server functions (the root's intl config, the route's notice), whose answers are
  // localized too. A response event fires on its headers, before the page can render the body it carries.
  const loaderCacheControls: Array<string | undefined> = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname.startsWith(SERVER_FN) && response.request().method() === "GET") {
      loaderCacheControls.push(response.headers()["cache-control"]);
    }
  });
  await page.getByRole("button", { name: "Norsk bokmål" }).click();

  await expect(page.locator("#server-heading")).toHaveText(EXPECTED.nb.heading);
  await expect(page.locator("html")).toHaveAttribute("lang", "nb");
  await expect(page.locator("#order-total")).toHaveText(EXPECTED.nb.total);
  await expect(page.locator("#loader-notice")).toHaveText(EXPECTED.nb.notice);
  await expect(page.locator("#cart-count")).toHaveText(EXPECTED.nb.twoItems);
  await expect(page.getByRole("button", { name: "Norsk bokmål" })).toHaveAttribute("aria-pressed", "true");
  // However many GET server functions the router re-ran, each answer is kept out of shared caches.
  expect(loaderCacheControls.length).toBeGreaterThan(0);
  expect(loaderCacheControls.filter((cacheControl) => cacheControl !== "private, no-store")).toEqual([]);
  // The English answers are gone; asked again, the server answers in Bokmål.
  await expect(page.locator("#api-greeting")).toHaveText("");
  await expect(page.locator("#action-confirmation")).toHaveText("");
  await page.getByRole("button", { name: EXPECTED.nb.callApi }).click();
  await expect(page.locator("#api-greeting")).toHaveText(EXPECTED.nb.api);
  await page.getByRole("button", { name: EXPECTED.nb.confirm }).click();
  await expect(page.locator("#action-confirmation")).toHaveText(EXPECTED.nb.action);

  await page.reload();
  await expect(page.locator("#server-heading")).toHaveText(EXPECTED.nb.heading);
  await expect(page.locator("#cart-count")).toHaveText(EXPECTED.nb.emptyCart);

  await page.getByRole("button", { name: "English" }).click();
  await expect(page.locator("#server-heading")).toHaveText(EXPECTED.en.heading);
});

test("shows how the latest switch ended, not an older one that failed after it started", async ({ page }) => {
  // The first save waits, then fails; the second waits until the test lets it through. Switches run one at a time, so
  // the second save is sent only once the first has failed and its outcome has reached the page.
  const failFirst = deferred();
  const releaseLatest = deferred();
  const latestSent = deferred();
  let saves = 0;
  await page.route(
    (url) => url.pathname.startsWith(SERVER_FN),
    async (route) => {
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
    }
  );
  await page.goto("/");
  const english = page.getByRole("button", { name: "English" });
  await expect(english).toBeEnabled();

  await english.click();
  await page.getByRole("button", { name: "Norsk bokmål" }).click();
  failFirst.settle();
  await latestSent.promise;
  // Let React commit what the first switch's failure set, if anything, before asserting there is nothing to see.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
      })
  );
  await expect(page.locator("nav[aria-busy=true] #locale-status")).toHaveText("");
  releaseLatest.settle();

  await expect(page.locator("html")).toHaveAttribute("lang", "nb");
  await expect(page.locator("#server-heading")).toHaveText(EXPECTED.nb.heading);
  await expect(page.locator("nav[aria-busy=false] #locale-status")).toHaveText("");
  expect(saves).toBe(2);
});

test("offers to load again when the loaders fail after the choice is saved", async ({ page }) => {
  // The switch saves the choice (a POST), then the loaders re-run (GETs); while `failing`, every GET fails.
  let failing = false;
  await page.route(
    (url) => url.pathname.startsWith(SERVER_FN),
    (route) => (failing && route.request().method() === "GET" ? route.abort() : route.continue())
  );
  await page.goto("/");
  const norwegian = page.getByRole("button", { name: "Norsk bokmål" });
  await expect(norwegian).toBeEnabled();
  failing = true;

  await norwegian.click();

  // The page still holds the English config it loaded, so it says so in English.
  await expect(page.locator("#load-error")).toHaveText(EXPECTED.en.loadError);
  failing = false;
  await page.getByRole("button", { name: EXPECTED.en.tryAgain }).click();

  await expect(page.locator("#server-heading")).toHaveText(EXPECTED.nb.heading);
  await expect(page.locator("html")).toHaveAttribute("lang", "nb");
  await expect(page.locator("#load-error")).toHaveCount(0);
});

// The adapter hands the request's Accept-Language to chooseLocale: one browser that asks for Bokmål proves the wiring.
// How the header is weighed, row by row, is test/locale.test.ts.
test.describe("without a stored choice", () => {
  test.use({ locale: "nb-NO" });

  test("follows the browser's Accept-Language", async ({ page }) => {
    await page.goto("/");

    await expect(page.locator("html")).toHaveAttribute("lang", "nb");
    await expect(page.locator("#server-heading")).toHaveText(EXPECTED.nb.heading);
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

// Each response's text depends on the visitor's cookie and Accept-Language: no shared cache may store one.
test("keeps localized responses out of shared caches", async ({ request }) => {
  const [page, api] = await Promise.all([request.get("/"), request.get("/api/greeting")]);

  expect(page.headers()["cache-control"]).toBe("private, no-store");
  expect(api.headers()["cache-control"]).toBe("private, no-store");
});

test("reads its cookie's whole value, so a value with an extra `=` is no locale", async ({ request }) => {
  const response = await request.get("/api/greeting", {
    headers: { cookie: `${COOKIE}=nb=other`, "accept-language": "en" },
  });

  expect(await response.text()).toBe(EXPECTED.en.api);
});
