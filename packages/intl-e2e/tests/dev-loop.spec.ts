import type { Browser } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FIXTURE_SERVER, NEXT_URL, START_URL } from "./fixture-mode.ts";

const HOSTS = [
  { name: "next", url: NEXT_URL, po: "../fixtures/next/intl/no.po", selector: "#client-call" },
  { name: "start", url: START_URL, po: "../fixtures/start/src/intl/nb.po", selector: "#call" },
] as const;
const BEFORE = 'msgid "Hello from a call"\nmsgstr "Hei fra et kall"';
const AFTER = 'msgid "Hello from a call"\nmsgstr "Hei fra en lagring"';

// Replaces the PO in one rename, as editors save. writeFileSync truncates and then writes, so a load between the two
// would compile an empty catalog, which compiles (every message renders English) and stays until the next change
// (#19). The temp file is a sibling, so the rename stays on one file system, and no catalog pattern matches its name.
function save(po: string, text: string): void {
  const temp = join(dirname(po), `.${basename(po)}.${process.pid}.tmp`);
  writeFileSync(temp, text);
  renameSync(temp, po);
}

type Host = (typeof HOSTS)[number];

// Restoring a PO: its teardown gets this budget of its own, apart from the test's, and each look at the dev server
// one bounded navigation of it.
const RESTORE_TIMEOUT = 60_000;
const LOOK_TIMEOUT = 5_000;

// What a freshly loaded page renders at the host's selector right after it loads: what the dev server's compiled
// catalog says now, whatever an open tab last received. A navigation that fails, a page without the element, or a
// sample the page cuts short (a dev server reloading it destroys its context) is no answer, and the next look loads a
// fresh page again.
async function served(browser: Browser, host: Host): Promise<string | undefined> {
  const fresh = await browser.newPage();
  try {
    const response = await fresh.goto(host.url, { timeout: LOOK_TIMEOUT }).catch(() => null);

    return response === null
      ? undefined
      : await fresh
          .evaluate((selector) => document.querySelector(selector)?.textContent ?? undefined, host.selector)
          .catch(() => undefined);
  } finally {
    await fresh.close();
  }
}

// The host's PO, which the test saves through `save` and the fixture's teardown restores, waiting, within its own
// budget, until a freshly loaded page renders the original msgstr again: however the test ended, the tests after it
// start from the original catalog. Teardown first closes `save`, so a test body still running past its deadline cannot
// save over the restore: a later call throws. A teardown failure is reported beside the test's own.
type DevCatalog = { readonly original: string; readonly save: (text: string) => void };
const it = test.extend<{ host: Host; devCatalog: DevCatalog }>({
  host: [HOSTS[0], { option: true }],
  devCatalog: [
    async ({ browser, host }, use) => {
      const po = fileURLToPath(new URL(host.po, import.meta.url));
      const original = readFileSync(po, "utf8");
      let saving = true;
      await use({
        original,
        save: (text) => {
          if (!saving) {
            throw new Error(`${host.po} is being restored: a save after the test ended`);
          }
          save(po, text);
        },
      });
      saving = false;
      save(po, original);
      await expect
        .poll(() => served(browser, host), {
          message: `the ${host.name} dev server serves the restored PO`,
          timeout: RESTORE_TIMEOUT - LOOK_TIMEOUT,
        })
        .toBe("Hei fra et kall");
    },
    { timeout: RESTORE_TIMEOUT },
  ],
});

// Unit under test: the dev loop, a PO-only save reaching a tab already open (Next: the loader's module recompiles and
// the RSC refreshes; Start: the Vite plugin's event reruns the root loader). Oracle: the saved msgstr, rendered in the
// same document (a global set before the save survives, so the page did not reload). The `devCatalog` fixture, for the
// one host each test uses, restores the PO afterwards and waits for the dev server to serve it.
for (const host of HOSTS) {
  it.describe(host.name, () => {
    it.skip(FIXTURE_SERVER !== "dev", "the dev servers' loop");
    it.use({ host });

    it(`${host.name}: a PO save updates an open tab in place`, async ({ page, devCatalog }) => {
      expect(devCatalog.original).toContain(BEFORE);

      await page.goto(host.url);
      // Hydrated (the fixtures mark <html> from an effect), so the client is listening for the update.
      await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
      await expect(page.locator(host.selector)).toHaveText("Hei fra et kall");
      // A global, which a reload (unlike window.name) drops and React never touches.
      await page.evaluate(() => Object.assign(window, { intlMarker: "before-save" }));
      devCatalog.save(devCatalog.original.replace(BEFORE, AFTER));

      await expect(page.locator(host.selector)).toHaveText("Hei fra en lagring");
      expect(await page.evaluate(() => "intlMarker" in window)).toBe(true);
    });
  });
}
