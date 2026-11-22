// The Turbopack (webpack-loader API) loader `withIntl` registers on `*.po`: compile the imported catalog.
import { SOURCE_LOCALE } from "@elmeragroup/intl/internal/catalog";

import { catalogModule } from "./catalog-module";
import { compileCatalog } from "./compile";
import type { PoLoaderOptions } from "./next";
import { describeProblem } from "./problem";
import { catalogLocale, loadFormats } from "./project";
import { loadConfig } from "./project-config";

/** The part of Turbopack's webpack-loader context the loader uses. */
type LoaderContext = {
  readonly resourcePath: string;
  addDependency(file: string): void;
  getOptions(): PoLoaderOptions;
  async(): (error: Error | null, code?: string) => void;
};

/**
 * Compile one PO file to the module exporting its catalog, for the locale its path names (or English, with
 * `?source`), with the app's `formats`.
 *
 * @param po - The file's text.
 */
export default function poLoader(this: LoaderContext, po: string): void {
  const callback = this.async();
  // Settled once, either way: the module, the failure the loader reports, or a throw (a defect, or I/O this does not
  // classify), passed on as loader-runner passes a synchronous throw after `this.async()`. A Promise, though the
  // compile is still synchronous, so a later layer can run it as an Effect program.
  Promise.try(compile, this, po).then((result) => {
    if (result._tag === "Module") {
      callback(null, result.code);
    } else {
      callback(result.error);
    }
  }, callback);
}

type Compiled =
  | { readonly _tag: "Module"; readonly code: string }
  | { readonly _tag: "Failed"; readonly error: Error };

// The catalog module's code, or the error the import fails with.
function compile(context: LoaderContext, po: string): Compiled {
  const { config: configPath, source } = context.getOptions();
  const loaded = loadConfig(configPath);

  if (loaded._tag === "ConfigInvalid") {
    return { _tag: "Failed", error: new Error(describeProblem(loaded.problem)) };
  }

  const { config } = loaded;
  const locale = catalogLocale(config, context.resourcePath);

  if (locale === undefined) {
    return {
      _tag: "Failed",
      error: new Error(
        `elmera-intl: ${context.resourcePath} is not a configured catalog (${config.catalogs}, ${config.locales.join(", ")})`
      ),
    };
  }

  // Before loading, so saving a repaired formats module reruns a load that failed on it.
  context.addDependency(configPath);

  if (config.formats !== undefined) {
    context.addDependency(config.formats);
  }

  const formats = loadFormats(config);

  if (formats._tag === "ConfigInvalid") {
    return { _tag: "Failed", error: new Error(describeProblem(formats.problem)) };
  }

  const compiled = compileCatalog(po, source ? SOURCE_LOCALE : locale, { formats: formats.formats });

  // The CatalogCompileError itself, with every problem in its message.
  return compiled._tag === "CatalogCompileError"
    ? { _tag: "Failed", error: compiled }
    : { _tag: "Module", code: catalogModule(compiled.catalog) };
}
