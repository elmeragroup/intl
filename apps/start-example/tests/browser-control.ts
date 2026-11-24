// What the specs in this directory share to drive the app: its cookies, the browser's errors, its server functions, and
// answers the test releases when it chooses.
import type { BrowserContext, Page } from "@playwright/test";

import type { Locale } from "./expected-text";

// The app's own cookies, and the other example's: both apps run on localhost, where cookies are shared across ports.
/** The app's locale cookie. */
export const COOKIE = "start-example-locale";
/** The app's sidebar cookie. */
export const SIDEBAR_COOKIE = "start-example-sidebar";
/** The Next example's locale cookie, on the same host. */
export const OTHER_APP_COOKIE = "next-example-locale";

/** The account menu's trigger, named for the signed-in user (src/data/signed-in.ts), in English. */
export const ACCOUNT_MENU = "Account menu for Ingrid Haugen";

/**
 * Store `locale` as the visitor's choice.
 *
 * @param context - The browser context.
 * @param locale - The locale to store.
 */
export async function chooseLocale(context: BrowserContext, locale: Locale): Promise<void> {
  await context.addCookies([{ name: COOKIE, value: locale, domain: "localhost", path: "/" }]);
}

/**
 * Everything the browser reports as broken: console errors (a hydration mismatch, a missing message) and uncaught
 * exceptions. Listening starts before the page loads.
 *
 * @param page - The page to listen on.
 * @returns The errors reported so far, growing as more arrive.
 */
export function collectErrors(page: Page): ReadonlyArray<string> {
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

/**
 * Server functions post to, and loaders fetch from, this prefix: the switch's save and the settings' save are POSTs,
 * the root's intl config and the pages' loader data are GETs.
 *
 * @param url - A request's URL.
 * @returns `true` for a server function's request.
 */
export function isServerFunction(url: URL): boolean {
  return url.pathname.startsWith("/_serverFn/");
}

/**
 * Two frames in the page: whatever React committed before them has run its effects and reported its errors, and the
 * browser's report of an error raised until then reaches the test before this resolves.
 *
 * @param page - The page.
 */
export async function afterTwoFrames(page: Page): Promise<void> {
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
}

/** A promise the test settles when it chooses. */
export type Deferred = { readonly promise: Promise<void>; readonly settle: () => void };

/**
 * A promise the test settles when it chooses.
 *
 * @returns The promise and its settle function.
 */
export function deferred(): Deferred {
  const { promise, resolve } = Promise.withResolvers<void>();

  return {
    promise,
    settle: () => {
      resolve();
    },
  };
}
