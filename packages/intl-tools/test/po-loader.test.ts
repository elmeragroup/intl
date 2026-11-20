import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

import type { Catalog } from "@elmeragroup/intl/core";
import { createIntl } from "@elmeragroup/intl/core";

import type { PoLoaderOptions } from "../src/next";
import { formatPo } from "../src/po";
import poLoader from "../src/po-loader";

const SOURCE = "{n, number, money}";
let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "elmera-intl-po-loader-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// Turbopack's webpack-loader call: the loader's options, the file, and its result through `async()`.
async function load(
  currency: string
): Promise<{ readonly error: Error | null; readonly code: string | undefined }> {
  // One module path, rewritten: a dev server's loader sees the same module change.
  const formats = "formats.ts";
  writeFileSync(
    join(root, formats),
    `export const formats = { number: { money: { style: "currency", currency: "${currency}" } } };\n`
  );
  writeFileSync(
    join(root, "elmera-intl.json"),
    JSON.stringify({ include: ["*.ts"], catalogs: "intl/{locale}.po", locales: ["nb"], formats })
  );
  const done = Promise.withResolvers<{ readonly error: Error | null; readonly code: string | undefined }>();
  const options: PoLoaderOptions = { config: join(root, "elmera-intl.json"), source: false };
  poLoader.call(
    {
      resourcePath: join(root, "intl/nb.po"),
      getOptions: () => options,
      addDependency: () => undefined,
      async: () => (error, code) => {
        done.resolve({ error, code });
      },
    },
    formatPo("nb", [
      {
        source: SOURCE,
        context: undefined,
        translation: `${SOURCE} totalt`,
        references: [],
        comments: [],
        flags: [],
      },
    ])
  );

  return done.promise;
}

// Unit under test: the Turbopack loader, through the webpack-loader API it implements. Oracle: Intl's own nb currency
// format, and its rejection of the currency "NOKK", which only the formats module the config names makes reachable.
it("compiles the PO with the config's formats module, and fails a style only its edited content makes invalid", async () => {
  const { error, code } = await load("NOK");
  const module: unknown = await import(`data:text/javascript,${encodeURIComponent(code ?? "")}`);
  const exported = new Map<string, unknown>(Object.entries(new Object(module))).get("default");
  // SAFETY: the loader's module default is the compiled catalog this test renders; a wrong value fails the render.
  const catalog = exported as Catalog;
  const formats = { number: { money: { style: "currency", currency: "NOK" } } } as const;

  expect(error).toBeNull();
  expect(createIntl({ locale: "nb", catalog, timeZone: "UTC", formats }).t(SOURCE, { n: 1234.5 })).toBe(
    `${new Intl.NumberFormat("nb", { style: "currency", currency: "NOK" }).format(1234.5)} totalt`
  );
  expect((await load("NOKK")).error?.message).toMatch(/"\{n, number, money\}": Invalid currency code : NOKK/);
});
