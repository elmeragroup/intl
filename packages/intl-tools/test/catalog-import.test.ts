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
// import compiles one locale, the one its file names; a file two locales' catalogs link to names neither uniquely, so
// the real-path match must not pick one by the order of `locales`, and the import is refused naming both locales, each
// of which needs a PO of its own.
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
    "elmera-intl: shared/en.po is the catalog of en-US, en-GB through a link; each locale needs a PO of its own (intl/{locale}.po)"
  );
});

// Unit under test: the import both hosts share, for a locale whose catalog directory links to another locale's
// (`intl/sv -> nb`), given the file at its real path, as the hosts hand it over (#98). Oracle: as for a shared file
// above, a file the catalogs of two locales resolve to names neither, also when one locale's catalog names it as
// written: compiled for `nb`, `sv`'s import would get `nb`'s plural rules and formats with no error, so the import is
// refused naming both locales, though `nb` is configured and names the file as written.
it("refuses a file one locale names and another's catalog directory links to, given at its real path", ({
  project,
}) => {
  project.write("intl/nb/messages.po", PO);
  symlinkSync("nb", project.path("intl/sv"), "dir");
  project.write(
    "elmera-intl.json",
    JSON.stringify({ include: ["*.ts"], catalogs: "intl/{locale}/messages.po", locales: ["nb", "sv"] })
  );

  const { outcome } = compileCatalogImport({
    config: project.path("elmera-intl.json"),
    file: project.path("intl/nb/messages.po"),
    readPo: () => PO,
    source: false,
  });

  expect(outcome._tag === "Failed" ? outcome.error.message : outcome._tag).toBe(
    "elmera-intl: intl/nb/messages.po is the catalog of nb, sv through a link; each locale needs a PO of its own (intl/{locale}/messages.po)"
  );
});

// Unit under test: the import both hosts share, for an absolute `catalogs` with a `..` after a directory that does not
// exist (`/mnt/web -> app`, `unmounted` absent), given the PO checked in where that pattern collapses lexically.
// Oracle: the kernel resolves the pattern as written, so no locale's catalog exists there (`extract` refuses it with
// `CatalogClimbsMissing`, #91), and a catalog path that does not resolve cannot be the file imported, which exists: the
// import is refused by name as the catalog of none, never compiled for `nb` by a collapsed `..`.
it("refuses a file an absolute catalog pattern reaches only by collapsing a `..` after a missing directory", ({
  project,
}) => {
  project.write("messages/nb.po", PO);
  mkdirSync(project.path("app"), { recursive: true });
  symlinkSync(project.path("app"), project.path("mnt-web"), "dir");
  const catalogs = `${project.path("mnt-web")}/unmounted/../../messages/{locale}.po`;
  project.write("app/elmera-intl.json", JSON.stringify({ include: ["*.ts"], catalogs, locales: ["nb"] }));

  const { outcome } = compileCatalogImport({
    config: project.path("app/elmera-intl.json"),
    file: project.path("messages/nb.po"),
    readPo: () => PO,
    source: false,
  });

  expect(outcome._tag === "Failed" ? outcome.error.message : outcome._tag).toBe(
    `elmera-intl: ../messages/nb.po is not a configured catalog (${catalogs}, nb)`
  );
});
