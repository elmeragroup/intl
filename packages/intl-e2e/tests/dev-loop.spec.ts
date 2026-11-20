import { expect, test } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { FIXTURE_SERVER, NEXT_URL, START_URL } from "./fixture-mode.ts";

const HOSTS = [
  { name: "next", url: NEXT_URL, po: "../fixtures/next/intl/no.po", selector: "#client-call" },
  { name: "start", url: START_URL, po: "../fixtures/start/src/intl/nb.po", selector: "#call" },
] as const;
const BEFORE = 'msgid "Hello from a call"\nmsgstr "Hei fra et kall"';
const AFTER = 'msgid "Hello from a call"\nmsgstr "Hei fra en lagring"';

// Unit under test: the dev loop, a PO-only save reaching a tab already open (Next: the loader's module recompiles and
// the RSC refreshes; Start: the Vite plugin's event reruns the root loader). Oracle: the saved msgstr, rendered in the
// same document (a global set before the save survives, so the page did not reload).
for (const host of HOSTS) {
  test(`${host.name}: a PO save updates an open tab in place`, async ({ page }) => {
    test.skip(FIXTURE_SERVER !== "dev", "the dev servers' loop");
    const po = fileURLToPath(new URL(host.po, import.meta.url));
    const original = readFileSync(po, "utf8");
    expect(original).toContain(BEFORE);

    try {
      await page.goto(host.url);
      // Hydrated (the fixtures mark <html> from an effect), so the client is listening for the update.
      await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
      await expect(page.locator(host.selector)).toHaveText("Hei fra et kall");
      // A global, which a reload (unlike window.name) drops and React never touches.
      await page.evaluate(() => Object.assign(window, { intlMarker: "before-save" }));
      writeFileSync(po, original.replace(BEFORE, AFTER));

      await expect(page.locator(host.selector)).toHaveText("Hei fra en lagring");
      expect(await page.evaluate(() => "intlMarker" in window)).toBe(true);
    } finally {
      writeFileSync(po, original);
    }
  });
}
