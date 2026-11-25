import { expect, test } from "vitest";

import type { Catalog } from "@elmeragroup/intl/core";
import { createIntl } from "@elmeragroup/intl/core";

import { CatalogCompileError } from "../src/compile";
import type { PoLoaderOptions } from "../src/next";
import { formatPo } from "../src/po";
import poLoader from "../src/po-loader";
import type { Project } from "./project-fixture";
import { openProject } from "./project-fixture";

const SOURCE = "{n, number, money}";
const PO = formatPo("nb", [
  {
    source: SOURCE,
    context: undefined,
    translation: `${SOURCE} totalt`,
    references: [],
    comments: [],
    flags: [],
  },
]);

// Each test owns its project (see `Project`); every wait ends by its deadline.
const it = test.extend("project", ({ task }, { onCleanup }) => {
  const { project, close } = openProject("elmera-intl-po-loader-", task.timeout);
  onCleanup(close);

  return project;
});

/** What one loader call handed the bundler. */
type Loaded = {
  readonly error: Error | null;
  readonly code: string | undefined;
  /** The paths `addDependency` was given by the time the callback ran: Turbopack reads them there. */
  readonly dependencies: ReadonlySet<string>;
};

// Turbopack's webpack-loader call: the loader's options, the file, and its result through `async()`.
async function load(project: Project, resource: string): Promise<Loaded> {
  const done = Promise.withResolvers<Loaded>();
  const dependencies: Array<string> = [];
  const options: PoLoaderOptions = { config: project.path("elmera-intl.json"), source: false };
  poLoader.call(
    {
      resourcePath: project.path(resource),
      getOptions: () => options,
      addDependency: (file) => {
        dependencies.push(file);
      },
      async: () => (error, code) => {
        done.resolve({ error, code, dependencies: new Set(dependencies) });
      },
    },
    PO
  );

  return project.within(done.promise, "the loader's callback");
}

// The nb project whose formats module defines `money` in `currency`. One module path, rewritten: a dev server's loader
// sees the same module change.
function useMoney(project: Project, currency: string): void {
  project.write(
    "formats.ts",
    `export const formats = { number: { money: { style: "currency", currency: "${currency}" } } };\n`
  );
  project.write(
    "elmera-intl.json",
    JSON.stringify({
      include: ["*.ts"],
      catalogs: "intl/{locale}.po",
      locales: ["nb"],
      formats: "formats.ts",
    })
  );
}

// Unit under test: the Turbopack loader, through the webpack-loader API it implements. Oracle: Intl's own nb currency
// format, and its rejection of the currency "NOKK", which only the formats module the config names makes reachable;
// by its callback, a load has registered the config and that module as dependencies, whether it compiles or fails.
it("compiles the PO with the config's formats module, and fails a style only its edited content makes invalid", async ({
  project,
}) => {
  useMoney(project, "NOK");
  const { error, code, dependencies } = await load(project, "intl/nb.po");
  const module: unknown = await import(`data:text/javascript,${encodeURIComponent(code ?? "")}`);
  const exported = new Map<string, unknown>(Object.entries(new Object(module))).get("default");
  // SAFETY: the loader's module default is the compiled catalog this test renders; a wrong value fails the render.
  const catalog = exported as Catalog;
  const formats = { number: { money: { style: "currency", currency: "NOK" } } } as const;
  const both = new Set([project.path("elmera-intl.json"), project.path("formats.ts")]);

  expect(error).toBeNull();
  expect(createIntl({ locale: "nb", catalog, timeZone: "UTC", formats }).t(SOURCE, { n: 1234.5 })).toBe(
    `${new Intl.NumberFormat("nb", { style: "currency", currency: "NOK" }).format(1234.5)} totalt`
  );
  expect(dependencies).toEqual(both);

  useMoney(project, "NOKK");
  const failed = await load(project, "intl/nb.po");

  expect(failed.error).toBeInstanceOf(CatalogCompileError);
  expect(failed.error?.message).toMatch(/"\{n, number, money\}": Invalid currency code : NOKK/u);
  expect(failed.dependencies).toEqual(both);
});

// Unit under test: the loader on a PO no configured locale's catalog is. Oracle: the one rule for the text a PO of no
// configured locale fails with on every host (`elmera-intl:`, the PO's path relative to the config, the catalogs
// pattern and the locales), written out for this fixture; and by its callback the load has registered the config, the
// only file whose edit can repair it, as a dependency.
it("fails a PO of no configured locale, depending on the config", async ({ project }) => {
  useMoney(project, "NOK");
  const { error, dependencies } = await load(project, "intl/sv.po");

  expect(error?.message).toBe("elmera-intl: intl/sv.po is not a configured catalog (intl/{locale}.po, nb)");
  expect(dependencies).toEqual(new Set([project.path("elmera-intl.json")]));
});

// Unit under test: the loader under a config that does not parse. Oracle: the config is the only file whose edit can
// repair the load, so by its callback the failed load has registered it as a dependency. The failure's text is
// load-graph.test.ts's.
it("fails under an invalid config, depending on the config", async ({ project }) => {
  project.write("elmera-intl.json", "{");
  const { error, dependencies } = await load(project, "intl/nb.po");

  expect(error).not.toBeNull();
  expect(dependencies).toEqual(new Set([project.path("elmera-intl.json")]));
});
