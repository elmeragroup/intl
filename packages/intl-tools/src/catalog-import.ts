// What one `*.po` import compiles to, what it depends on and what it fails with, for every host: Next's po-loader and
// Vite's `load` each only map it onto their loader context. A synchronous compile with no project-services runtime, for
// loader workers: the extractor, the commands and the watcher stay outside its import graph.
import { relative } from "node:path";

import type { Catalog } from "@elmeragroup/intl/internal/catalog";
import { SOURCE_LOCALE } from "@elmeragroup/intl/internal/catalog";

import { compileCatalog } from "./compile";
import { describeProblem } from "./problem";
import { catalogLocale } from "./project-catalogs";
import { loadConfig } from "./project-config";
import { loadFormats } from "./project-formats";

/** One `*.po` import, as a host hands it over. */
export type CatalogImportRequest = {
  /** Absolute path of `elmera-intl.json`. */
  readonly config: string;
  /** Absolute path of the imported PO. */
  readonly file: string;
  /** The PO's text, read only once the config, the locale and the formats hold. A throw propagates as it is. */
  readonly readPo: () => string;
  /** Compile the msgids as the English catalog (`?source`). */
  readonly source: boolean;
};

/** What the import compiles to, and the files it depends on. */
export type CatalogImport = {
  /** The paths the adapter reports to its host as the import's dependencies, failed or not. */
  readonly dependencies: ReadonlyArray<string>;
  readonly outcome:
    | { readonly _tag: "Module"; readonly code: string }
    | { readonly _tag: "Failed"; readonly error: Error };
};

/**
 * Compile one imported PO to the module exporting its catalog, for the locale its path names (or English, with
 * `source`), with the app's `formats`. The dependencies are the config, on every outcome, and the formats module once
 * the PO is a configured locale's catalog: the paths the adapter reports to its host, which decides what a change to
 * one of them reruns. A PO of no configured locale fails with one text on every host; a catalog that does not compile
 * fails with the `CatalogCompileError` itself.
 *
 * @param request - The import.
 * @returns The module's code or the failure, with the paths the import depends on.
 */
export function compileCatalogImport(request: CatalogImportRequest): CatalogImport {
  const loaded = loadConfig(request.config);

  if (loaded._tag === "ConfigInvalid") {
    return failed([request.config], new Error(describeProblem(loaded.problem)));
  }

  const { config } = loaded;
  const locale = catalogLocale(config, request.file);

  if (locale === undefined) {
    return failed(
      [request.config],
      new Error(
        `elmera-intl: ${relative(config.root, request.file)} is not a configured catalog (${config.catalogs}, ${config.locales.join(", ")})`
      )
    );
  }

  const dependencies = config.formats === undefined ? [request.config] : [request.config, config.formats];
  const formats = loadFormats(config);

  if (formats._tag === "ConfigInvalid") {
    return failed(dependencies, new Error(describeProblem(formats.problem)));
  }

  const compiled = compileCatalog(request.readPo(), request.source ? SOURCE_LOCALE : locale, {
    formats: formats.formats,
  });

  if (compiled._tag === "CatalogCompileError") {
    return failed(dependencies, compiled);
  }

  return { dependencies, outcome: { _tag: "Module", code: catalogModule(compiled.catalog) } };
}

function failed(dependencies: ReadonlyArray<string>, error: Error): CatalogImport {
  return { dependencies, outcome: { _tag: "Failed", error } };
}

// An ES module whose default export is the catalog: `JSON.parse` of a string literal, which engines parse faster than
// the same object literal.
function catalogModule(catalog: Catalog): string {
  return `export default JSON.parse(${JSON.stringify(JSON.stringify(catalog))});\n`;
}
