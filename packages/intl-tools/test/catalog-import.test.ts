import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

import { compileCatalogImport } from "../src/catalog-import";
import { formatPo } from "../src/po";
import { openProject } from "./project-fixture";

const PO = formatPo("nb", [
  { source: "Hello", context: undefined, translation: "Hei", references: [], comments: [], flags: [] },
]);

// Each test owns its project (see `Project`); every wait ends by its deadline.
const it = test.extend("project", ({ task }, { onCleanup }) => {
  const { project, close } = openProject("elmera-intl-catalog-import-", task.timeout);
  onCleanup(close);

  return project;
});

// Unit under test: the catalog import both hosts share, given the imported file as the host hands it. Oracle: the
// bundlers resolve an import through its links before a loader sees it: Next 16.4.6's Turbopack hands its loader the
// real path (replayed for #63: `../intl-link/nb.po` reaches the loader as `…/intl/nb.po`), as Vite does with its
// default `resolve.preserveSymlinks: false`. So a file the config names through a link (`intl-link -> intl`), or under
// a project directory spelled through one (the temporary directory on macOS, `/var` for `/private/var`), compiles as
// that locale's catalog when it arrives at its real path; one no locale's catalog is, at either spelling, does not.
it.for([
  { name: "a catalog the config names through a link", file: "intl/nb.po", compiles: true },
  { name: "a file of no configured locale", file: "intl/sv.po", compiles: false },
])("compiles $name, given at its real path: $compiles", ({ file, compiles }, { project }) => {
  mkdirSync(project.path("intl"), { recursive: true });
  symlinkSync(project.path("intl"), project.path("intl-link"), "dir");
  project.write("intl/nb.po", PO);
  project.write("intl/sv.po", PO);
  project.write(
    "elmera-intl.json",
    JSON.stringify({ include: ["*.ts"], catalogs: "intl-link/{locale}.po", locales: ["nb"] })
  );

  const { outcome } = compileCatalogImport({
    config: project.path("elmera-intl.json"),
    file: join(realpathSync(project.path(".")), file),
    readPo: () => PO,
    source: false,
  });

  expect(outcome._tag).toBe(compiles ? "Module" : "Failed");
});

// Unit under test: the same import, for a file that is the real path of several locales' catalogs. Oracle: a catalog
// import compiles one locale, the one its file names (`main` refuses a file that names no configured locale with
// `… is not a configured catalog`); a file two locales' catalogs link to names neither uniquely, so the real-path
// match must not pick one by the order of `locales`, and the import is refused as one that names no locale.
it("refuses a file that several locales' catalogs link to, given at its real path", ({ project }) => {
  project.write("shared/en.po", PO);
  mkdirSync(project.path("intl"), { recursive: true });
  symlinkSync(project.path("shared/en.po"), project.path("intl/en-US.po"), "file");
  symlinkSync(project.path("shared/en.po"), project.path("intl/en-GB.po"), "file");
  project.write(
    "elmera-intl.json",
    JSON.stringify({ include: ["*.ts"], catalogs: "intl/{locale}.po", locales: ["en-US", "en-GB"] })
  );

  const real = realpathSync(project.path("."));
  const { outcome } = compileCatalogImport({
    config: join(real, "elmera-intl.json"),
    file: join(real, "shared/en.po"),
    readPo: () => PO,
    source: false,
  });

  expect(outcome._tag === "Failed" ? outcome.error.message : outcome._tag).toBe(
    "elmera-intl: shared/en.po is not a configured catalog (intl/{locale}.po, en-US, en-GB)"
  );
});
