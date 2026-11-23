import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { CORPUS } from "./corpus-expectations.ts";
import { FIXTURE_RUNTIME, FIXTURE_SERVER, NEXT_URL, START_URL } from "./fixture-mode.ts";

// A translation only the translated locale's catalog holds (no route renders it): data sent to the browser carries it
// only with that catalog.
const SENTINEL = "KATALOGVAKT-7Q2";
// Text of a structured English source no route renders: only the en catalog carries it (translated catalogs are keyed
// by hash and hold the translation instead).
const ENGLISH_SENTINEL = "ENVAKT-4X8";
// Names the pass in each title, so a packed-packages failure is not mistaken for the linked pass's.
const BUILD = `${FIXTURE_RUNTIME} packages, ${FIXTURE_SERVER}`;
// ErrorKind names only the ICU parser's own module contains (intl-messageformat's parser); a bundle without the parser
// has none of them.
const PARSER_ERROR_CODES = ["EXPECT_ARGUMENT_CLOSING_BRACE", "MALFORMED_ARGUMENT", "UNCLOSED_TAG"];
// `Due {d, date, short}` for 00:30 on Mar 5 in Oslo with the fixtures' short style, as next-intl 4.14.9 renders it.
// Built-in short would render 3/5/26 and 5.3.26.
const DUE = { en: "Due Mar 5, 2026", translated: "Forfaller 5. mars 2026" } as const;

type Host = {
  readonly name: "next" | "start";
  readonly url: string;
  /** The fixture's translated locale, which it serves without a locale cookie. */
  readonly translated: string;
  /** A client call site and its text per locale. */
  readonly call: { readonly selector: string; readonly en: string; readonly translated: string };
  /** A client call site formatting `{d, date, short}`, which the adapter's formats override, by its element id. */
  readonly date: { readonly id: string; readonly en: string; readonly translated: string };
  /** A request header only the switch's server refresh sends: the request that carries the new locale's catalog. */
  readonly refreshHeader: string;
  /** A button that answers only once the page has hydrated (a server action or server function), and its answer. */
  readonly hydrated: {
    readonly button: string;
    readonly result: string;
    readonly en: string;
    readonly translated: string;
  };
};

const HOSTS: ReadonlyArray<Host> = [
  {
    name: "next",
    url: NEXT_URL,
    translated: "no",
    refreshHeader: "rsc",
    call: { selector: "#client-call", en: "Hello from a call", translated: "Hei fra et kall" },
    date: { id: "client-date", ...DUE },
    hydrated: {
      button: "#action",
      result: "#action-result",
      en: "Action result",
      translated: "Handlingsresultat",
    },
  },
  {
    name: "start",
    url: START_URL,
    translated: "nb",
    refreshHeader: "x-tsr-serverfn",
    call: { selector: "#call", en: "Hello from a call", translated: "Hei fra et kall" },
    date: { id: "date", ...DUE },
    hydrated: { button: "#ping", result: "#pong", en: "pong kari", translated: "pong kari" },
  },
];

function cookieFor(locale: string): string {
  return locale === "en" ? "locale=en" : "";
}

// The corpus items of a server-rendered page, without the text separators React's streaming renderer inserts.
function serverItems(html: string): Array<string> {
  return [...html.matchAll(/<li data-corpus="\d+">([\s\S]*?)<\/li>/gu)].map(([, item = ""]) =>
    item.replaceAll("<!-- -->", "")
  );
}

// The page, once React hydrated it (both fixtures mark <html> from an effect): only then does a click reach a handler.
async function gotoHydrated(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
}

// Every page error and console error, which is where React reports a hydration mismatch.
function collectErrors(page: Page): Array<string> {
  const errors: Array<string> = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });

  return errors;
}

declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- only an interface merges into the DOM's Window
  interface Window {
    /** Set by FetchWatch.start: from then on, fetches the page calls are recorded. */
    intlE2eWatching?: boolean;
    /** Playwright's binding that hands a recorded response body to the test. */
    intlE2eRecordBody?: (body: string) => void;
  }
}

type FetchWatch = {
  /** Records from now on: every fetch/XHR request, and the body of every fetch the page calls with the header. */
  readonly start: () => Promise<void>;
  /** Each request's URL, and whether it carries the header. */
  readonly requests: ReadonlyArray<{ readonly url: string; readonly watched: boolean }>;
  readonly bodies: ReadonlyArray<string>;
};

// Set up before the page loads; records once started. A body is teed in the page from a clone of the response the app
// reads, so the request goes from the page to the server untouched. Not a route's route.fetch(): that re-issues the
// request from Playwright's own HTTP client, and once it held Next's RSC refresh past the expect timeout, leaving the
// page in the old locale. Not response.text(): Chromium sometimes keeps no DevTools copy of a streamed fetch body.
async function watchFetches(page: Page, header: string): Promise<FetchWatch> {
  const requests: Array<{ readonly url: string; readonly watched: boolean }> = [];
  const bodies: Array<string> = [];
  await page.exposeFunction("intlE2eRecordBody", (body: string) => {
    bodies.push(body);
  });
  await page.addInitScript((name) => {
    const original = window.fetch;
    window.fetch = async (input, init) => {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      // Decided when the fetch is called, so a response read after start() from an earlier call is not recorded.
      const isWatched = window.intlE2eWatching === true && headers.has(name);
      const response = await original(input, init);

      if (isWatched) {
        void response
          .clone()
          .text()
          .then((body) => window.intlE2eRecordBody?.(body));
      }

      return response;
    };
  }, header);

  return {
    start: async () => {
      page.on("request", (request) => {
        const type = request.resourceType();

        if (type === "fetch" || type === "xhr") {
          requests.push({ url: request.url(), watched: request.headers()[header] !== undefined });
        }
      });
      await page.evaluate(() => {
        window.intlE2eWatching = true;
      });
    },
    requests,
    bodies,
  };
}

for (const host of HOSTS) {
  test.describe(`${host.name} fixture, ${BUILD}`, () => {
    for (const locale of ["en", host.translated]) {
      const expected = CORPUS.map((entry) => (locale === "en" ? entry.en : entry.translated));
      const text = (entry: { readonly en: string; readonly translated: string }) =>
        locale === "en" ? entry.en : entry.translated;

      test(`renders the corpus in ${locale}, server-rendered and hydrated`, async ({ page, request }) => {
        const response = await request.get(host.url, { headers: { cookie: cookieFor(locale) } });
        const html = await response.text();

        expect(serverItems(html)).toEqual(expected);
        expect(html).toContain(`id="${host.date.id}">${text(host.date)}<`);

        const errors = collectErrors(page);
        await page
          .context()
          .addCookies([{ name: "locale", value: locale === "en" ? "en" : host.translated, url: host.url }]);
        await gotoHydrated(page, host.url);
        await page.locator(host.hydrated.button).click();
        await expect(page.locator(host.hydrated.result)).toHaveText(text(host.hydrated));
        await expect(page.locator(host.call.selector)).toHaveText(text(host.call));
        await expect(page.locator(`#${host.date.id}`)).toHaveText(text(host.date));
        const decoded = await page.evaluate((items) => {
          const template = document.createElement("template");

          return items.map((item) => {
            template.innerHTML = item;

            return template.content.textContent;
          });
        }, expected);

        await expect(page.locator("#corpus li")).toHaveText(decoded);
        expect(errors).toEqual([]);
      });
    }

    // Each document carries its own locale's catalog and no other: no English catalog beside a translated one.
    for (const [locale, sentinels] of [
      [host.translated, { translated: true, english: false }],
      ["en", { translated: false, english: true }],
    ] as const) {
      test(`sends the browser only the request locale's catalog, in ${locale}`, async ({ request }) => {
        const html = await (await request.get(host.url, { headers: { cookie: cookieFor(locale) } })).text();

        expect(serverItems(html)).toHaveLength(CORPUS.length);
        expect({ translated: html.includes(SENTINEL), english: html.includes(ENGLISH_SENTINEL) }).toEqual(
          sentinels
        );
      });
    }

    test(`switches locale in place, keeping typed input, fetching the new locale's catalog`, async ({
      page,
    }) => {
      await page.context().addCookies([{ name: "locale", value: "en", url: host.url }]);
      const fetches = await watchFetches(page, host.refreshHeader);
      await gotoHydrated(page, host.url);
      await page.locator(host.hydrated.button).click();
      await expect(page.locator(host.hydrated.result)).toHaveText(host.hydrated.en);
      await page.locator("#typed").fill("kept");
      await fetches.start();
      await page.locator(`#switch-${host.translated}`).click();

      await expect(page.locator(host.call.selector)).toHaveText(host.call.translated);
      await expect(page.locator(`#${host.date.id}`)).toHaveText(host.date.translated);
      await expect(page.locator("#switch-state")).toHaveText("idle");
      await expect(page.locator("#typed")).toHaveValue("kept");
      await expect(page.locator("#corpus li").first()).toHaveText("Ikke mist handlekurven");
      await expect.poll(() => fetches.bodies.length).toBe(1);
      expect(fetches.bodies.map((body) => body.includes(SENTINEL))).toEqual([true]);
      // The refresh is the only fetch/XHR, so no other response carries the catalog.
      expect(fetches.requests).toHaveLength(1);
    });
  });
}

test.describe(`next fixture, ${BUILD}, server components`, () => {
  test("renders server and client sites and a server component's msg() descriptor, translated", async ({
    page,
  }) => {
    await page.goto(NEXT_URL);

    await expect(page.locator("#rsc-element")).toHaveText("Serverelement");
    await expect(page.locator("#rsc-call")).toHaveText("Hei fra serveren");
    await expect(page.locator("#rsc-date")).toHaveText(DUE.translated);
    // The import-free receiver forms, extracted and translated.
    await expect(page.locator("#rsc-forms")).toHaveText("Punktum Valgfri Parentes Beregnet");
    await expect(page.locator("#client-element")).toHaveText("Hei fra et element");
    await expect(page.locator("#client-from")).toHaveText("Deklarert melding");
  });
});

// Unit under test: createRequestConfig (`/next/server`) behind withIntl's alias to the fixture's request module, whose
// adapter reads the locale from the request's `cookie` header. Oracle: the fixture's committed catalog (intl/no.po)
// and English sources, per locale cookie.
test.describe(`next fixture, ${BUILD}, request config`, () => {
  for (const [locale, text] of [
    ["en", "Route handler text"],
    ["no", "Tekst fra rutebehandleren"],
  ] as const) {
    // A route handler loads no layout and imports only `/server`: the alias alone reaches the request module.
    test(`answers a route handler in ${locale} with no setup import`, async ({ request }) => {
      const response = await request.get(`${NEXT_URL}/api/translation`, {
        headers: { cookie: cookieFor(locale) },
      });

      expect(response.status()).toBe(200);
      expect(await response.text()).toBe(text);
    });
  }

  // Inside a server action `headers()` is the request as it arrived: an adapter handed it would see the old locale
  // cookie after the action set the new one, in what the action reads and in the page Next re-renders in its response.
  test("switches no to en in a server action, which reads and re-renders the new locale in its own response", async ({
    page,
  }) => {
    const fetches = await watchFetches(page, "next-action");
    await gotoHydrated(page, NEXT_URL);
    await expect(page.locator("#rsc-action-switch")).toHaveText("Gjengitt med handlingens språk");
    await fetches.start();
    await page.locator("#action-switch-en").click();

    await expect(page.locator("#action-switch-before")).toHaveText("Lest i handlingen");
    await expect(page.locator("#action-switch-after")).toHaveText("Read in the action");
    await expect(page.locator("#rsc-action-switch")).toHaveText("Rendered with the action's locale");
    await expect(page.locator("#action-switch-state")).toHaveText("idle");
    // The action's POST carried the re-rendered page, and no refresh followed it.
    await expect.poll(() => fetches.bodies.length).toBe(1);
    expect(
      fetches.bodies.map((body) => ({
        en: body.includes("Rendered with the action's locale"),
        no: body.includes("Gjengitt med handlingens språk"),
      }))
    ).toEqual([{ en: true, no: false }]);
    expect(fetches.requests.map(({ watched }) => watched)).toEqual([true]);
  });
});

// Every JS response of a full page load, after it went idle: what the page's client chunks are.
async function clientScripts(page: Page, url: string): Promise<ReadonlyArray<string>> {
  const scripts: Array<Promise<string>> = [];
  page.on("response", (response) => {
    // A redirect has no body; its target is a response of its own.
    if (response.request().resourceType() === "script" && response.status() === 200) {
      scripts.push(response.text());
    }
  });
  await page.goto(url);
  await page.waitForLoadState("networkidle");

  return Promise.all(scripts);
}

function parserCodes(scripts: ReadonlyArray<string>): ReadonlyArray<string> {
  return PARSER_ERROR_CODES.filter((code) => scripts.some((script) => script.includes(code)));
}

// Unit under test: the client chunks of a route that renders our runtime alone. Oracle: the parser's own error codes;
// the control route, which formats with intl-messageformat, ships its parser, so the probe can see one.
test.describe(`client chunks, ${BUILD}`, () => {
  test("next: a route on @elmeragroup/intl alone ships no ICU parser; intl-messageformat's route does", async ({
    page,
  }) => {
    const ours = await clientScripts(page, `${NEXT_URL}/intl-only`);

    await expect(page.locator("#intl-only")).toHaveText("Hei fra et element");
    expect(parserCodes(ours)).toEqual([]);
    expect(parserCodes(await clientScripts(page, `${NEXT_URL}/parser-only`))).not.toEqual([]);
  });

  test("start: the app ships no ICU parser", async ({ page }) => {
    const scripts = await clientScripts(page, START_URL);

    await expect(page.locator("#call")).toHaveText("Hei fra et kall");
    expect(scripts.length).toBeGreaterThan(0);
    expect(parserCodes(scripts)).toEqual([]);
  });
});

// A string only the fixture's request module (intl/fixture-request.ts) holds, in an error path it keeps.
const REQUEST_SENTINEL = "FORESPORSELVAKT-5R8";
// The stub's guidance, each part as a token that survives HTML escaping: the server-code setup (withIntl and the
// request module) and the Client Component remedy.
const STUB_GUIDANCE = [
  /withIntl/u,
  /intl\/request\.ts/u,
  /useT and useFormat from @elmeragroup\/intl\/react/u,
];
const NEXT_BUILD = fileURLToPath(new URL("../fixtures/next/.next/", import.meta.url));

// Every file below a directory of the build, read as text.
function buildFiles(directory: string, extension: RegExp): ReadonlyArray<string> {
  return readdirSync(join(NEXT_BUILD, directory), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && extension.test(entry.name))
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"));
}

// Unit under test: `/server`'s request config under Turbopack, imported by a Client Component, which client and SSR
// code resolve to the stub (`internal/request-config` outside `react-server`). Oracle: the stub's guidance, and the
// request module's sentinel, which the server build carries (the route handler and pages reach it) and no client
// chunk may. Were the alias reached from client or SSR code, the build would fail, the call would resolve or throw
// next/headers' error instead, or the sentinel would ship.
test.describe(`next fixture, ${BUILD}, /server in a Client Component`, () => {
  test("rejects with the stub's guidance while the server renders it", async ({ request }) => {
    const html = await (await request.get(`${NEXT_URL}/server-from-client`)).text();
    const rendered = /<output id="server-from-client-render">([^<]*)<\/output>/u.exec(html)?.[1] ?? "";

    expect(STUB_GUIDANCE.filter((guidance) => !guidance.test(rendered))).toEqual([]);
  });

  test("loads, and rejects with the stub's guidance in the browser", async ({ page }) => {
    const errors = collectErrors(page);
    await gotoHydrated(page, `${NEXT_URL}/server-from-client`);
    await page.locator("#server-from-client").click();

    await expect(page.locator("#server-from-client-outcome")).not.toHaveText("idle");
    const outcome = (await page.locator("#server-from-client-outcome").textContent()) ?? "";
    expect(STUB_GUIDANCE.filter((guidance) => !guidance.test(outcome))).toEqual([]);
    await expect(page.locator("#server-from-client-render")).toHaveText(outcome);
    expect(errors).toEqual([]);
  });

  // Every client chunk the build emitted, not only those one page load fetches; the dev server writes no build.
  test("ships the request module in no client chunk of the build", () => {
    test.skip(FIXTURE_SERVER === "dev", "the dev server emits no production build");
    const client = buildFiles("static", /\.js$/u);
    const server = buildFiles("server", /\.js$/u);

    expect(client.length).toBeGreaterThan(0);
    expect({
      client: client.some((code) => code.includes(REQUEST_SENTINEL)),
      server: server.some((code) => code.includes(REQUEST_SENTINEL)),
    }).toEqual({ client: false, server: true });
  });
});
